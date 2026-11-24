import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { BookmarkChunk } from '../bookmarks/bookmark-chunk.entity';
import { BookmarkContent } from '../bookmarks/bookmark-content.entity';
import { Bookmark } from '../bookmarks/bookmark.entity';
import { BookmarksService } from '../bookmarks/bookmarks.service';
import { chunkHash } from './chunk/chunker';
import { GeminiEmbedder } from '../embedding/gemini-embedder';
import { ContentExtractor } from './extract/content-extractor';
import { SafeFetcher } from './fetch/safe-fetcher';
import {
  PermanentIngestionError,
  TransientIngestionError,
} from './ingestion-errors';
import { FETCH_STAGE, IngestionService } from './ingestion.service';
import { ProcessingState as S } from './processing-state';
import { IngestionQueue } from './queue/ingestion-queue.service';

describe('IngestionService', () => {
  let service: IngestionService;
  const transition = jest.fn<Promise<boolean>, unknown[]>();
  const bookmarks = {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    find: jest.fn(),
  };
  const contents = { findOne: jest.fn() };
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    getMany: jest.fn(),
    getCount: jest.fn(),
  };
  const manager = {
    upsert: jest.fn(),
    update: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
    insert: jest.fn(),
    createQueryBuilder: jest.fn(() => qb),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
  };
  const embedder = { model: 'gemini-embedding-001', embedDocuments: jest.fn() };
  const fetcher = { fetch: jest.fn() };
  const extractor = { extract: jest.fn() };
  const queue = {
    enqueueFetch: jest.fn(),
    enqueueExtract: jest.fn(),
    enqueueEmbed: jest.fn(),
  };
  const first = { made: 0, max: 5 };
  const last = { made: 4, max: 5 };
  const page = {
    finalUrl: 'https://x.dev/a',
    status: 200,
    contentType: 'text/html',
    html: '<p>hi</p>',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const fn of [qb.getMany, qb.getCount, manager.find, manager.findOne]) {
      fn.mockReset();
    }
    transition.mockResolvedValue(true);
    bookmarks.findOneOrFail.mockResolvedValue({
      id: 'b1',
      originalUrl: 'https://x.dev/a',
    });
    const mod = await Test.createTestingModule({
      providers: [
        IngestionService,
        {
          provide: BookmarksService,
          useValue: { transitionProcessingState: transition },
        },
        { provide: getRepositoryToken(Bookmark), useValue: bookmarks },
        { provide: getRepositoryToken(BookmarkContent), useValue: contents },
        { provide: getRepositoryToken(BookmarkChunk), useValue: {} },
        { provide: GeminiEmbedder, useValue: embedder },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: SafeFetcher, useValue: fetcher },
        { provide: ContentExtractor, useValue: extractor },
        { provide: IngestionQueue, useValue: queue },
      ],
    }).compile();
    service = mod.get(IngestionService);
  });

  const transitions = () => transition.mock.calls.map((c) => [c[1], c[2]]);

  it('fetch: claims, stores content in the commit transaction, enqueues extract', async () => {
    fetcher.fetch.mockResolvedValue(page);
    await expect(service.fetch('b1', first)).resolves.toBe('done');
    expect(transitions()).toEqual([
      [S.Pending, S.Fetching],
      [S.Fetching, S.Fetched],
    ]);
    expect(transition.mock.calls[1][4]).toBe(manager);
    expect(manager.upsert).toHaveBeenCalledWith(
      BookmarkContent,
      expect.objectContaining({ bookmarkId: 'b1', rawHtml: '<p>hi</p>' }),
      ['bookmarkId'],
    );
    expect(queue.enqueueExtract).toHaveBeenCalledWith('b1');
  });

  it('skips without working when another worker owns the row', async () => {
    transition.mockResolvedValueOnce(false);
    bookmarks.findOne.mockResolvedValue({ id: 'b1', processingState: S.Ready });
    await expect(service.fetch('b1', first)).resolves.toBe('skipped');
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('resumes a redelivered job whose row is already in the active state', async () => {
    transition.mockResolvedValueOnce(false);
    bookmarks.findOne.mockResolvedValue({
      id: 'b1',
      processingState: S.Fetching,
    });
    fetcher.fetch.mockResolvedValue(page);
    await expect(service.fetch('b1', first)).resolves.toBe('done');
  });

  it('does not write content when a stale worker loses the commit', async () => {
    fetcher.fetch.mockResolvedValue(page);
    transition.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(service.fetch('b1', first)).resolves.toBe('skipped');
    expect(manager.upsert).not.toHaveBeenCalled();
    expect(queue.enqueueExtract).not.toHaveBeenCalled();
  });

  it('transient error: steps back to the input state and rethrows for retry', async () => {
    const err = new TransientIngestionError('HTTP 503');
    fetcher.fetch.mockRejectedValue(err);
    await expect(service.fetch('b1', first)).rejects.toBe(err);
    expect(transitions()).toEqual([
      [S.Pending, S.Fetching],
      [S.Fetching, S.Pending],
    ]);
    expect(transition.mock.calls[1][3]).toBe('HTTP 503');
  });

  it('transient error on the last attempt: marks failed', async () => {
    fetcher.fetch.mockRejectedValue(new TransientIngestionError('timeout'));
    await expect(service.fetch('b1', last)).resolves.toBe('failed');
    expect(transitions()[1]).toEqual([S.Fetching, S.Failed]);
  });

  it('permanent error: marks unsupported without retrying', async () => {
    fetcher.fetch.mockRejectedValue(new PermanentIngestionError('HTTP 404'));
    await expect(service.fetch('b1', first)).resolves.toBe('unsupported');
    expect(transitions()[1]).toEqual([S.Fetching, S.Unsupported]);
  });

  it('extract: stores the article, writes chunks reusing unchanged vectors, enqueues embed', async () => {
    contents.findOne.mockResolvedValue({
      bookmarkId: 'b1',
      finalUrl: 'https://x.dev/a',
      rawHtml: '<p>hi</p>',
    });
    extractor.extract.mockReturnValue({
      title: 'T',
      textContent: 'Hello world.',
      contentHtml: '<p>Hello world.</p>',
    });
    manager.find.mockResolvedValue([
      { contentHash: chunkHash('T', null, 'Hello world.'), embedding: [1, 0] },
    ]);

    await expect(service.extract('b1', first)).resolves.toBe('done');
    expect(transitions()).toEqual([
      [S.Fetched, S.Extracting],
      [S.Extracting, S.Extracted],
    ]);
    expect(manager.update).toHaveBeenCalledWith(
      BookmarkContent,
      { bookmarkId: 'b1' },
      expect.objectContaining({
        title: 'T',
        extractedAt: expect.any(Date) as unknown,
      }),
    );
    expect(manager.delete).toHaveBeenCalledWith(BookmarkChunk, {
      bookmarkId: 'b1',
    });
    const [, rows] = manager.insert.mock.calls[0] as [
      unknown,
      Partial<BookmarkChunk>[],
    ];
    expect(rows).toEqual([
      expect.objectContaining({
        position: 0,
        content: 'Hello world.',
        embedding: [1, 0],
        embeddingModel: 'gemini-embedding-001',
      }),
    ]);
    expect(qb.where).toHaveBeenCalledWith('id = :id AND title IS NULL', {
      id: 'b1',
    });
    expect(queue.enqueueEmbed).toHaveBeenCalledWith('b1');
  });

  it('extract: drops the old vector when the chunk text changed', async () => {
    contents.findOne.mockResolvedValue({
      bookmarkId: 'b1',
      finalUrl: 'https://x.dev/a',
      rawHtml: '<p>hi</p>',
    });
    extractor.extract.mockReturnValue({
      title: 'T',
      contentHtml: '<p>Hello there.</p>',
    });
    manager.find.mockResolvedValue([
      { contentHash: chunkHash('T', null, 'Hello world.'), embedding: [1, 0] },
    ]);
    await service.extract('b1', first);
    const [, rows] = manager.insert.mock.calls[0] as [
      unknown,
      Partial<BookmarkChunk>[],
    ];
    expect(rows[0]).toMatchObject({ embedding: null, embeddingModel: null });
  });

  it('embed: embeds pending chunks in batches and finishes as ready', async () => {
    contents.findOne.mockResolvedValue({ bookmarkId: 'b1', title: 'T' });
    qb.getCount.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    qb.getMany
      .mockResolvedValueOnce([
        { id: 'c1', section: null, content: 'a' },
        { id: 'c2', section: 'S', content: 'b' },
      ])
      .mockResolvedValueOnce([]);
    manager.findOne.mockResolvedValue({ processingState: S.Embedding });
    embedder.embedDocuments.mockResolvedValue([[1], [2]]);

    await expect(service.embed('b1', first)).resolves.toBe('done');
    expect(embedder.embedDocuments).toHaveBeenCalledWith([
      { title: 'T', text: 'a' },
      { title: 'T', text: 'S\n\nb' },
    ]);
    expect(manager.update).toHaveBeenCalledWith(
      BookmarkChunk,
      { id: 'c2' },
      expect.objectContaining({
        embedding: [2],
        embeddingModel: 'gemini-embedding-001',
      }),
    );
    expect(transitions()).toEqual([
      [S.Extracted, S.Embedding],
      [S.Embedding, S.Ready],
    ]);
  });

  it('embed: stops without writing when the row left the embedding state', async () => {
    contents.findOne.mockResolvedValue({ bookmarkId: 'b1', title: 'T' });
    qb.getCount.mockResolvedValue(1);
    qb.getMany.mockResolvedValue([{ id: 'c1', section: null, content: 'a' }]);
    manager.findOne.mockResolvedValue({ processingState: S.Pending });
    embedder.embedDocuments.mockResolvedValue([[1]]);

    await expect(service.embed('b1', first)).resolves.toBe('skipped');
    expect(manager.update).not.toHaveBeenCalled();
    expect(transitions()).toEqual([[S.Extracted, S.Embedding]]);
  });

  it('embed: a rate-limit error steps back to extracted for retry', async () => {
    contents.findOne.mockResolvedValue({ bookmarkId: 'b1', title: 'T' });
    qb.getCount.mockResolvedValue(1);
    qb.getMany.mockResolvedValue([{ id: 'c1', section: null, content: 'a' }]);
    const err = new TransientIngestionError('Gemini HTTP 429');
    embedder.embedDocuments.mockRejectedValue(err);

    await expect(service.embed('b1', first)).rejects.toBe(err);
    expect(transitions()).toEqual([
      [S.Extracted, S.Embedding],
      [S.Embedding, S.Extracted],
    ]);
  });

  it('sweep: resets stuck rows and requeues orphaned ones', async () => {
    bookmarks.find
      .mockResolvedValueOnce([{ id: 'stuck', processingState: S.Extracting }])
      .mockResolvedValueOnce([{ id: 'orphan', processingState: S.Pending }]);
    await expect(service.sweep()).resolves.toEqual({ reset: 1, requeued: 1 });
    expect(transitions()).toEqual([[S.Extracting, S.Fetched]]);
    expect(queue.enqueueExtract).toHaveBeenCalledWith('stuck');
    expect(queue.enqueueFetch).toHaveBeenCalledWith('orphan');
  });

  it('exposes the fetch stage edges used by the state machine', () => {
    expect(FETCH_STAGE).toMatchObject({
      input: S.Pending,
      active: S.Fetching,
      output: S.Fetched,
    });
  });
});
