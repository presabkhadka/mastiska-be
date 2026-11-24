import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryDeepPartialEntity, Repository } from 'typeorm';
import { CollectionsService } from '../collections/collections.service';
import { isUniqueViolation } from '../common/db-errors';
import { paginate, Paginated } from '../common/dto/paginated.dto';
import {
  assertTransition,
  ProcessingState,
} from '../ingestion/processing-state';
import { IngestionQueue } from '../ingestion/queue/ingestion-queue.service';
import { TagsService } from '../tags/tags.service';
import { BookmarkContent } from './bookmark-content.entity';
import { BookmarkIdentityService } from './bookmark-identity.service';
import { Bookmark } from './bookmark.entity';
import { BookmarkQueryDto } from './dto/bookmark-query.dto';
import { CreateBookmarkDto } from './dto/create-bookmark.dto';
import { UpdateBookmarkDto } from './dto/update-bookmark.dto';

const REPROCESSABLE: readonly ProcessingState[] = [
  ProcessingState.Ready,
  ProcessingState.Failed,
  ProcessingState.Unsupported,
];

@Injectable()
export class BookmarksService {
  private readonly logger = new Logger(BookmarksService.name);

  constructor(
    @InjectRepository(Bookmark)
    private readonly bookmarks: Repository<Bookmark>,
    @InjectRepository(BookmarkContent)
    private readonly contents: Repository<BookmarkContent>,
    private readonly ingestion: IngestionQueue,
    private readonly identity: BookmarkIdentityService,
    private readonly tags: TagsService,
    private readonly collections: CollectionsService,
  ) {}

  async findAll(
    userId: string,
    q: BookmarkQueryDto,
  ): Promise<Paginated<Bookmark>> {
    const qb = this.bookmarks
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.tags', 't')
      .where('b.userId = :userId', { userId });

    // EXISTS filters so the joined tag list isn't narrowed by the filter.
    if (q.tagId) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM bookmark_tags bt WHERE bt.bookmark_id = b.id AND bt.tag_id = :tagId)',
        { tagId: q.tagId },
      );
    }
    if (q.collectionId) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM bookmark_collections bc WHERE bc.bookmark_id = b.id AND bc.collection_id = :collectionId)',
        { collectionId: q.collectionId },
      );
    }
    if (q.isArchived !== undefined) {
      qb.andWhere('b.isArchived = :isArchived', { isArchived: q.isArchived });
    }
    if (q.processingState) {
      qb.andWhere('b.processingState = :processingState', {
        processingState: q.processingState,
      });
    }
    if (q.isFavorite !== undefined) {
      qb.andWhere('b.isFavorite = :isFavorite', { isFavorite: q.isFavorite });
    }
    if (q.savedAfter) {
      qb.andWhere('b.createdAt >= :savedAfter', { savedAfter: q.savedAfter });
    }
    if (q.savedBefore) {
      qb.andWhere('b.createdAt < :savedBefore', { savedBefore: q.savedBefore });
    }

    // sortBy is whitelisted by the DTO; id is a tiebreaker for stable pages.
    qb.orderBy(`b.${q.sortBy}`, q.order)
      .addOrderBy('b.id', q.order)
      .skip(q.skip)
      .take(q.limit);

    const [items, total] = await qb.getManyAndCount();
    return paginate(items, total, q.page, q.limit);
  }

  async findOne(userId: string, id: string): Promise<Bookmark> {
    const b = await this.bookmarks.findOne({
      where: { id, userId },
      relations: { tags: true, collections: true },
    });
    // 404 (not 403) for other users' bookmarks: don't leak existence.
    if (!b) throw new NotFoundException('Bookmark not found');
    return b;
  }

  /** Lightweight ownership check for nested resources (notes, relations). */
  async assertOwned(userId: string, id: string): Promise<void> {
    const exists = await this.bookmarks.existsBy({ id, userId });
    if (!exists) throw new NotFoundException('Bookmark not found');
  }

  async create(userId: string, dto: CreateBookmarkDto): Promise<Bookmark> {
    try {
      const bookmark = this.bookmarks.create({
        userId,
        originalUrl: dto.url,
        canonicalUrl: this.identity.canonicalize(dto.url),
        title: dto.title ?? null,
        processingState: ProcessingState.Pending,
      });
      const saved = await this.bookmarks.save(bookmark);
      await this.enqueueFetch(saved.id);
      return saved;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return await this.bookmarks.findOneByOrFail({
        userId,
        canonicalUrl: this.identity.canonicalize(dto.url),
      });
    }
  }

  // Write only user-owned columns so a stale read can't clobber processing_state.
  async update(
    userId: string,
    id: string,
    dto: UpdateBookmarkDto,
  ): Promise<Bookmark> {
    const { isRead, title, isFavorite, isArchived } = dto;
    const patch: QueryDeepPartialEntity<Bookmark> = {};
    if (title !== undefined) patch.title = title;
    if (isFavorite !== undefined) patch.isFavorite = isFavorite;
    if (isArchived !== undefined) patch.isArchived = isArchived;
    // Keep the first read time: only set readAt when it is still null.
    if (isRead === true) patch.readAt = () => 'COALESCE(read_at, now())';
    if (isRead === false) patch.readAt = null;

    if (Object.keys(patch).length > 0) {
      const res = await this.bookmarks.update({ id, userId }, patch);
      if (!res.affected) throw new NotFoundException('Bookmark not found');
    }
    return this.findOne(userId, id);
  }

  async reprocess(userId: string, id: string): Promise<Bookmark> {
    const b = await this.bookmarks.findOne({
      where: { id, userId },
      select: { id: true, processingState: true },
    });
    if (!b) throw new NotFoundException('Bookmark not found');
    if (!REPROCESSABLE.includes(b.processingState)) {
      throw new ConflictException(
        `Bookmark is ${b.processingState}; only ${REPROCESSABLE.join(', ')} can be reprocessed`,
      );
    }
    const moved = await this.transitionProcessingState(
      id,
      b.processingState,
      ProcessingState.Pending,
    );
    if (!moved) throw new ConflictException('Processing state changed; retry');
    await this.enqueueFetch(id);
    return this.findOne(userId, id);
  }

  async getContent(userId: string, id: string): Promise<BookmarkContent> {
    await this.assertOwned(userId, id);
    const content = await this.contents.findOneBy({ bookmarkId: id });
    if (!content?.extractedAt) {
      throw new NotFoundException('Content not extracted yet');
    }
    return content;
  }

  /** Compare-and-set; false if another worker moved it first. */
  async transitionProcessingState(
    id: string,
    from: ProcessingState,
    to: ProcessingState,
    error: string | null = null,
    manager: EntityManager = this.bookmarks.manager,
  ): Promise<boolean> {
    assertTransition(from, to);
    const res = await manager
      .createQueryBuilder()
      .update(Bookmark)
      .set({
        processingState: to,
        processingError: error,
        processingStateChangedAt: () => 'now()',
      })
      .where('id = :id AND processing_state = :from', { id, from })
      .execute();
    return res.affected === 1;
  }

  // Best-effort: if Redis is down the row stays pending and the sweeper retries.
  private async enqueueFetch(id: string): Promise<void> {
    try {
      await this.ingestion.enqueueFetch(id);
    } catch (err) {
      this.logger.warn(`Failed to enqueue fetch for ${id}: ${String(err)}`);
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const res = await this.bookmarks.delete({ id, userId });
    if (!res.affected) throw new NotFoundException('Bookmark not found');
  }

  // --- Tag / collection membership (idempotent attach/detach) ---

  async addTag(userId: string, bookmarkId: string, tagId: string) {
    await this.assertOwned(userId, bookmarkId);
    await this.tags.findOne(userId, tagId);
    await this.relate('tags', bookmarkId, tagId);
  }

  async removeTag(userId: string, bookmarkId: string, tagId: string) {
    await this.assertOwned(userId, bookmarkId);
    await this.tags.findOne(userId, tagId);
    await this.unrelate('tags', bookmarkId, tagId);
  }

  async addToCollection(
    userId: string,
    collectionId: string,
    bookmarkId: string,
  ) {
    await this.collections.findOne(userId, collectionId);
    await this.assertOwned(userId, bookmarkId);
    await this.relate('collections', bookmarkId, collectionId);
  }

  async removeFromCollection(
    userId: string,
    collectionId: string,
    bookmarkId: string,
  ) {
    await this.collections.findOne(userId, collectionId);
    await this.assertOwned(userId, bookmarkId);
    await this.unrelate('collections', bookmarkId, collectionId);
  }

  private async relate(
    relation: 'tags' | 'collections',
    bookmarkId: string,
    otherId: string,
  ) {
    try {
      await this.bookmarks
        .createQueryBuilder()
        .relation(Bookmark, relation)
        .of(bookmarkId)
        .add(otherId);
    } catch (err) {
      // Already linked: treat as success so PUT stays idempotent.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  private async unrelate(
    relation: 'tags' | 'collections',
    bookmarkId: string,
    otherId: string,
  ) {
    await this.bookmarks
      .createQueryBuilder()
      .relation(Bookmark, relation)
      .of(bookmarkId)
      .remove(otherId);
  }
}
