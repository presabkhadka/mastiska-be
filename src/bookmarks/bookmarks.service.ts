import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CollectionsService } from '../collections/collections.service';
import { isUniqueViolation } from '../common/db-errors';
import { paginate, Paginated } from '../common/dto/paginated.dto';
import { TagsService } from '../tags/tags.service';
import { BookmarkIdentityService } from './bookmark-identity.service';
import { Bookmark } from './bookmark.entity';
import { BookmarkQueryDto } from './dto/bookmark-query.dto';
import { CreateBookmarkDto } from './dto/create-bookmark.dto';
import { UpdateBookmarkDto } from './dto/update-bookmark.dto';

@Injectable()
export class BookmarksService {
  constructor(
    @InjectRepository(Bookmark)
    private readonly bookmarks: Repository<Bookmark>,
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

  /**
   * HAND-CODE (plan.md §2A/§2B): duplicate-save handling and enqueueing
   * ingestion belong here once identity rules and job lifecycle are defined.
   */
  async create(userId: string, dto: CreateBookmarkDto): Promise<Bookmark> {
    const bookmark = this.bookmarks.create({
      userId,
      originalUrl: dto.url,
      canonicalUrl: this.identity.canonicalize(dto.url),
      title: dto.title ?? null,
    });
    return this.bookmarks.save(bookmark);
  }

  /**
   * HAND-CODE (plan.md §2C "safe updates when ingestion and user edits happen
   * concurrently"): this is a plain read-modify-write. Once ingestion writes to
   * the same row (e.g. title), decide on version checks or column ownership.
   */
  async update(
    userId: string,
    id: string,
    dto: UpdateBookmarkDto,
  ): Promise<Bookmark> {
    const b = await this.findOne(userId, id);
    const { isRead, ...fields } = dto;
    this.bookmarks.merge(b, fields);
    if (isRead === true && !b.readAt) b.readAt = new Date();
    if (isRead === false) b.readAt = null;
    return this.bookmarks.save(b);
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
