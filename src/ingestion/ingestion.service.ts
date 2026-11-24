import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThan, Repository } from 'typeorm';
import { BookmarkChunk } from '../bookmarks/bookmark-chunk.entity';
import { BookmarkContent } from '../bookmarks/bookmark-content.entity';
import { Bookmark } from '../bookmarks/bookmark.entity';
import { BookmarksService } from '../bookmarks/bookmarks.service';
import {
  chunkArticle,
  ChunkDraft,
  chunkHash,
  embeddingText,
} from './chunk/chunker';
import { GeminiEmbedder } from '../embedding/gemini-embedder';
import { ContentExtractor, stripNul } from './extract/content-extractor';
import { SafeFetcher } from './fetch/safe-fetcher';
import { errorMessage, PermanentIngestionError } from './ingestion-errors';
import { ProcessingState as S } from './processing-state';
import { IngestionQueue } from './queue/ingestion-queue.service';

export interface Stage {
  name: 'fetch' | 'extract' | 'embed';
  input: S;
  active: S;
  output: S;
}

export const FETCH_STAGE: Stage = {
  name: 'fetch',
  input: S.Pending,
  active: S.Fetching,
  output: S.Fetched,
};

export const EXTRACT_STAGE: Stage = {
  name: 'extract',
  input: S.Fetched,
  active: S.Extracting,
  output: S.Extracted,
};

export const EMBED_STAGE: Stage = {
  name: 'embed',
  input: S.Extracted,
  active: S.Embedding,
  output: S.Ready,
};

const STAGES = [FETCH_STAGE, EXTRACT_STAGE, EMBED_STAGE];

export interface Attempt {
  /** Attempts already made before this one (BullMQ attemptsMade). */
  made: number;
  max: number;
}

export type StageOutcome = 'done' | 'skipped' | 'unsupported' | 'failed';

export const STUCK_AFTER_MS = 5 * 60_000;
export const ORPHAN_AFTER_MS = 2 * 60_000;
const SWEEP_BATCH = 100;
export const EMBED_BATCH = 50;

// Adaptive refresh: unchanged pages are checked half as often each time, up to 30 days.
export const REFRESH_BASE_HOURS = 12;
export const REFRESH_MAX_HOURS = 720;
export const REFRESH_MAX_FAILURES = 5;
const REFRESH_ENQUEUE_CHUNK = 100;

export type RefreshOutcome = 'unchanged' | 'changed' | 'failed' | 'skipped';

export const textHash = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const freshSchedule = (now: Date) => ({
  checkedAt: now,
  nextCheckAt: new Date(now.getTime() + REFRESH_BASE_HOURS * 3_600_000),
  refreshIntervalHours: REFRESH_BASE_HOURS,
  refreshFailures: 0,
  lastRefreshError: null,
});

/** The row left this worker's stage mid-work (reset by sweeper or reprocessed). */
class LostClaimError extends Error {}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly bookmarksService: BookmarksService,
    @InjectRepository(Bookmark)
    private readonly bookmarks: Repository<Bookmark>,
    @InjectRepository(BookmarkContent)
    private readonly contents: Repository<BookmarkContent>,
    @InjectRepository(BookmarkChunk)
    private readonly chunks: Repository<BookmarkChunk>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly fetcher: SafeFetcher,
    private readonly extractor: ContentExtractor,
    private readonly embedder: GeminiEmbedder,
    private readonly queue: IngestionQueue,
  ) {}

  async fetch(bookmarkId: string, attempt: Attempt): Promise<StageOutcome> {
    const outcome = await this.runStage(
      bookmarkId,
      FETCH_STAGE,
      attempt,
      async () => {
        const b = await this.bookmarks.findOneOrFail({
          where: { id: bookmarkId },
          select: { id: true, originalUrl: true },
        });
        return this.fetcher.fetch(b.originalUrl);
      },
      async (m, page) => {
        await m.upsert(
          BookmarkContent,
          {
            bookmarkId,
            finalUrl: page.finalUrl,
            httpStatus: page.status,
            contentType: page.contentType.slice(0, 255),
            rawHtml: stripNul(page.html),
            fetchedAt: new Date(),
            etag: page.etag,
            lastModified: page.lastModified,
          },
          ['bookmarkId'],
        );
      },
    );
    if (outcome === 'done') await this.enqueue(EXTRACT_STAGE, bookmarkId);
    return outcome;
  }

  async extract(bookmarkId: string, attempt: Attempt): Promise<StageOutcome> {
    const outcome = await this.runStage(
      bookmarkId,
      EXTRACT_STAGE,
      attempt,
      async () => {
        const content = await this.contents.findOne({
          where: { bookmarkId },
          select: { bookmarkId: true, finalUrl: true, rawHtml: true },
        });
        if (!content) throw new PermanentIngestionError('No fetched content');
        const article = this.extractor.extract(
          content.rawHtml,
          content.finalUrl,
        );
        return { article, chunks: chunkArticle(article.contentHtml) };
      },
      async (m, { article, chunks }) => {
        const now = new Date();
        await m.update(
          BookmarkContent,
          { bookmarkId },
          {
            ...article,
            extractedAt: now,
            contentHash: textHash(article.textContent),
            ...freshSchedule(now),
          },
        );
        await this.replaceChunks(m, bookmarkId, article.title, chunks);
        // Fill the title only if the user didn't set one.
        if (article.title) {
          await m
            .createQueryBuilder()
            .update(Bookmark)
            .set({ title: article.title })
            .where('id = :id AND title IS NULL', { id: bookmarkId })
            .execute();
        }
      },
    );
    if (outcome === 'done') await this.enqueue(EMBED_STAGE, bookmarkId);
    return outcome;
  }

  embed(bookmarkId: string, attempt: Attempt): Promise<StageOutcome> {
    return this.runStage(
      bookmarkId,
      EMBED_STAGE,
      attempt,
      () => this.embedPendingChunks(bookmarkId, S.Embedding),
      async (m) => {
        const remaining = await this.pendingChunks(m, bookmarkId).getCount();
        if (remaining > 0) {
          throw new Error(`${remaining} chunks still not embedded`);
        }
      },
    );
  }

  /**
   * claim -> work -> commit. Work runs outside any transaction; the commit
   * re-checks the state so a slower duplicate worker can't overwrite.
   */
  async runStage<T>(
    bookmarkId: string,
    stage: Stage,
    attempt: Attempt,
    work: () => Promise<T>,
    commit: (m: EntityManager, result: T) => Promise<void>,
  ): Promise<StageOutcome> {
    if (!(await this.claim(bookmarkId, stage))) return 'skipped';

    let result: T;
    try {
      result = await work();
    } catch (err) {
      if (err instanceof LostClaimError) return 'skipped';
      return this.handleFailure(bookmarkId, stage, attempt, err);
    }

    const committed = await this.dataSource.transaction(async (m) => {
      const won = await this.bookmarksService.transitionProcessingState(
        bookmarkId,
        stage.active,
        stage.output,
        null,
        m,
      );
      if (won) await commit(m, result);
      return won;
    });
    if (!committed) return 'skipped';
    this.logger.log(`${stage.name} done for ${bookmarkId}`);
    return 'done';
  }

  /**
   * Re-fetches a ready bookmark without taking it out of search. Unchanged → only the
   * check is recorded; changed → content and chunks are swapped in one transaction;
   * failure → the old content stays and the error is recorded.
   */
  async refresh(bookmarkId: string): Promise<RefreshOutcome> {
    const b = await this.bookmarks.findOne({
      where: { id: bookmarkId },
      select: { id: true, originalUrl: true, processingState: true },
    });
    if (b?.processingState !== S.Ready) return 'skipped';
    const prev = await this.contents.findOne({
      where: { bookmarkId },
      select: {
        bookmarkId: true,
        contentHash: true,
        etag: true,
        lastModified: true,
        refreshIntervalHours: true,
        refreshFailures: true,
      },
    });
    if (!prev) return 'skipped';

    try {
      const page = await this.fetcher.fetchIfChanged(b.originalUrl, prev);
      if ('notModified' in page) {
        await this.recordCheck(prev, 'unchanged');
        return 'unchanged';
      }
      const article = this.extractor.extract(page.html, page.finalUrl);
      const hash = textHash(article.textContent);
      const validators = { etag: page.etag, lastModified: page.lastModified };
      if (hash === prev.contentHash) {
        await this.recordCheck(prev, 'unchanged', validators);
        return 'unchanged';
      }

      const chunks = chunkArticle(article.contentHtml);
      const committed = await this.dataSource.transaction(async (m) => {
        // A reprocess or delete that started meanwhile wins.
        const row = await m.findOne(Bookmark, {
          where: { id: bookmarkId },
          select: { id: true, processingState: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (row?.processingState !== S.Ready) return false;
        const now = new Date();
        await m.update(
          BookmarkContent,
          { bookmarkId },
          {
            finalUrl: page.finalUrl,
            httpStatus: page.status,
            contentType: page.contentType.slice(0, 255),
            rawHtml: stripNul(page.html),
            fetchedAt: now,
            ...validators,
            ...article,
            extractedAt: now,
            contentHash: hash,
            contentChangedAt: now,
            ...freshSchedule(now),
          },
        );
        await this.replaceChunks(m, bookmarkId, article.title, chunks);
        if (article.title) {
          await m
            .createQueryBuilder()
            .update(Bookmark)
            .set({ title: article.title })
            .where('id = :id AND title IS NULL', { id: bookmarkId })
            .execute();
        }
        return true;
      });
      if (!committed) return 'skipped';

      const missing = await this.pendingChunks(
        this.dataSource.manager,
        bookmarkId,
      ).getCount();
      if (missing > 0) {
        try {
          await this.queue.enqueueReembed(bookmarkId);
        } catch (err) {
          this.logger.warn(
            `Failed to enqueue reembed for ${bookmarkId}: ${errorMessage(err)}`,
          );
        }
      }
      this.logger.log(
        `refresh: ${bookmarkId} changed, ${missing} chunks to embed`,
      );
      return 'changed';
    } catch (err) {
      const message = errorMessage(err);
      await this.recordCheck(prev, 'failed', {}, message);
      this.logger.warn(`refresh failed for ${bookmarkId}: ${message}`);
      return 'failed';
    }
  }

  /** Embeds chunks a refresh added; the bookmark stays ready (searchable) meanwhile. */
  async reembed(bookmarkId: string): Promise<StageOutcome> {
    try {
      await this.embedPendingChunks(bookmarkId, S.Ready);
    } catch (err) {
      if (err instanceof LostClaimError) return 'skipped';
      throw err;
    }
    return 'done';
  }

  /**
   * Picks due auto-refresh bookmarks, at most `perUser` per user and `total` overall,
   * round-robin across users; leftovers stay due for the next run.
   */
  async planRefreshes(total: number, perUser: number): Promise<number> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM (
         SELECT b.id, c.next_check_at,
                row_number() OVER (PARTITION BY b.user_id ORDER BY c.next_check_at, b.id) AS rn
         FROM bookmarks b
         JOIN bookmark_contents c ON c.bookmark_id = b.id
         WHERE b.auto_refresh AND b.processing_state = 'ready' AND c.next_check_at <= now()
       ) due
       WHERE rn <= $1
       ORDER BY rn, next_check_at
       LIMIT $2`,
      [perUser, total],
    );
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += REFRESH_ENQUEUE_CHUNK) {
      await this.queue.enqueueScheduledRefreshes(
        ids.slice(i, i + REFRESH_ENQUEUE_CHUNK),
      );
    }
    this.logger.log(`refresh plan: queued ${ids.length} bookmarks`);
    return ids.length;
  }

  private async recordCheck(
    prev: BookmarkContent,
    result: 'unchanged' | 'failed',
    validators: Partial<Pick<BookmarkContent, 'etag' | 'lastModified'>> = {},
    error: string | null = null,
  ): Promise<void> {
    const now = new Date();
    const interval = Math.min(prev.refreshIntervalHours * 2, REFRESH_MAX_HOURS);
    const failures = result === 'failed' ? prev.refreshFailures + 1 : 0;
    const giveUp = failures >= REFRESH_MAX_FAILURES;
    await this.contents.update(
      { bookmarkId: prev.bookmarkId },
      {
        ...validators,
        checkedAt: now,
        refreshIntervalHours: interval,
        refreshFailures: failures,
        lastRefreshError: error,
        nextCheckAt: giveUp
          ? null
          : new Date(now.getTime() + interval * 3_600_000),
      },
    );
  }

  /** Requeues stuck rows and rows whose job was lost. Run periodically. */
  async sweep(): Promise<{ reset: number; requeued: number }> {
    const now = Date.now();
    const stages = STAGES;

    let reset = 0;
    const stuck = await this.bookmarks.find({
      where: {
        processingState: In(stages.map((s) => s.active)),
        processingStateChangedAt: LessThan(new Date(now - STUCK_AFTER_MS)),
      },
      select: { id: true, processingState: true },
      take: SWEEP_BATCH,
    });
    for (const b of stuck) {
      const stage = stages.find((s) => s.active === b.processingState)!;
      const moved = await this.bookmarksService.transitionProcessingState(
        b.id,
        stage.active,
        stage.input,
        'Stalled: reset by sweeper',
      );
      if (moved) {
        reset++;
        await this.enqueue(stage, b.id);
      }
    }

    const waiting = await this.bookmarks.find({
      where: {
        processingState: In(stages.map((s) => s.input)),
        processingStateChangedAt: LessThan(new Date(now - ORPHAN_AFTER_MS)),
      },
      select: { id: true, processingState: true },
      take: SWEEP_BATCH,
    });
    for (const b of waiting) {
      const stage = stages.find((s) => s.input === b.processingState)!;
      await this.enqueue(stage, b.id);
    }

    if (reset || waiting.length) {
      this.logger.log(`Sweep: reset ${reset}, requeued ${waiting.length}`);
    }
    return { reset, requeued: waiting.length };
  }

  // Already in the active state means this job is being redelivered after a
  // crash or stall (jobId dedup allows only one job per bookmark per stage).
  private async claim(bookmarkId: string, stage: Stage): Promise<boolean> {
    const claimed = await this.bookmarksService.transitionProcessingState(
      bookmarkId,
      stage.input,
      stage.active,
    );
    if (claimed) return true;
    const current = await this.bookmarks.findOne({
      where: { id: bookmarkId },
      select: { id: true, processingState: true },
    });
    return current?.processingState === stage.active;
  }

  private async handleFailure(
    bookmarkId: string,
    stage: Stage,
    attempt: Attempt,
    err: unknown,
  ): Promise<StageOutcome> {
    const message = errorMessage(err);

    if (err instanceof PermanentIngestionError) {
      await this.bookmarksService.transitionProcessingState(
        bookmarkId,
        stage.active,
        S.Unsupported,
        message,
      );
      this.logger.warn(
        `${stage.name} unsupported for ${bookmarkId}: ${message}`,
      );
      return 'unsupported';
    }

    // Unknown errors are treated as transient.
    if (attempt.made + 1 >= attempt.max) {
      await this.bookmarksService.transitionProcessingState(
        bookmarkId,
        stage.active,
        S.Failed,
        message,
      );
      this.logger.error(`${stage.name} failed for ${bookmarkId}: ${message}`);
      return 'failed';
    }

    // Step back so the retry re-claims; rethrow so BullMQ applies backoff.
    await this.bookmarksService.transitionProcessingState(
      bookmarkId,
      stage.active,
      stage.input,
      message,
    );
    throw err;
  }

  /**
   * Replaces a bookmark's chunks. Vectors are carried over for chunks whose
   * embedding input is unchanged, so reprocessing only embeds what changed.
   */
  private async replaceChunks(
    m: EntityManager,
    bookmarkId: string,
    title: string | null,
    drafts: ChunkDraft[],
  ): Promise<void> {
    const model = this.embedder.model;
    const previous = await m.find(BookmarkChunk, {
      where: { bookmarkId, embeddingModel: model },
      select: { id: true, contentHash: true, embedding: true },
    });
    const reusable = new Map(
      previous
        .filter((p) => p.embedding)
        .map((p) => [p.contentHash, p.embedding]),
    );

    await m.delete(BookmarkChunk, { bookmarkId });
    if (drafts.length === 0) return;

    const now = new Date();
    await m.insert(
      BookmarkChunk,
      drafts.map((d) => {
        const contentHash = chunkHash(title, d.section, d.content);
        const embedding = reusable.get(contentHash) ?? null;
        return {
          bookmarkId,
          position: d.position,
          section: d.section,
          content: d.content,
          tokenEstimate: d.tokenEstimate,
          contentHash,
          embedding,
          embeddingModel: embedding ? model : null,
          embeddedAt: embedding ? now : null,
        };
      }),
    );
  }

  /**
   * Embeds missing vectors batch by batch, committing each batch, so a
   * failure midway only re-embeds the chunks that are still missing.
   */
  private async embedPendingChunks(
    bookmarkId: string,
    requiredState: S,
  ): Promise<void> {
    const content = await this.contents.findOne({
      where: { bookmarkId },
      select: { bookmarkId: true, title: true },
    });
    const title = content?.title ?? null;
    const total = await this.pendingChunks(
      this.dataSource.manager,
      bookmarkId,
    ).getCount();

    for (let round = 0; round <= Math.ceil(total / EMBED_BATCH); round++) {
      const batch = await this.pendingChunks(
        this.dataSource.manager,
        bookmarkId,
      )
        .select(['c.id', 'c.section', 'c.content'])
        .orderBy('c.position')
        .limit(EMBED_BATCH)
        .getMany();
      if (batch.length === 0) return;

      const vectors = await this.embedder.embedDocuments(
        batch.map((c) => ({
          title,
          text: embeddingText(c.section, c.content),
        })),
      );

      await this.dataSource.transaction(async (m) => {
        // Lock the bookmark so a reset/reprocess can't interleave with this write.
        const row = await m.findOne(Bookmark, {
          where: { id: bookmarkId },
          select: { id: true, processingState: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (row?.processingState !== requiredState) throw new LostClaimError();
        const now = new Date();
        for (const [i, c] of batch.entries()) {
          await m.update(
            BookmarkChunk,
            { id: c.id },
            {
              embedding: vectors[i],
              embeddingModel: this.embedder.model,
              embeddedAt: now,
            },
          );
        }
      });
    }
  }

  private pendingChunks(m: EntityManager, bookmarkId: string) {
    return m
      .createQueryBuilder(BookmarkChunk, 'c')
      .where('c.bookmark_id = :bookmarkId', { bookmarkId })
      .andWhere(
        '(c.embedding IS NULL OR c.embedding_model IS DISTINCT FROM :model)',
        { model: this.embedder.model },
      );
  }

  private async enqueue(stage: Stage, bookmarkId: string): Promise<void> {
    try {
      if (stage.name === 'fetch') await this.queue.enqueueFetch(bookmarkId);
      else if (stage.name === 'extract') {
        await this.queue.enqueueExtract(bookmarkId);
      } else await this.queue.enqueueEmbed(bookmarkId);
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue ${stage.name} for ${bookmarkId}: ${errorMessage(err)}`,
      );
    }
  }
}
