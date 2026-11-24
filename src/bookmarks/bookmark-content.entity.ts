import {
  Column,
  CreateDateColumn,
  Index,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Bookmark } from './bookmark.entity';

/** Fetched page and extracted article for a bookmark. Written only by the pipeline. */
@Entity('bookmark_contents')
export class BookmarkContent {
  @PrimaryColumn({ name: 'bookmark_id', type: 'uuid' })
  bookmarkId: string;

  @OneToOne(() => Bookmark, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bookmark_id' })
  bookmark?: Bookmark;

  // --- fetch stage ---

  @Column({ name: 'final_url', type: 'text' })
  finalUrl: string;

  @Column({ name: 'http_status', type: 'smallint' })
  httpStatus: number;

  @Column({ name: 'content_type', type: 'varchar', length: 255 })
  contentType: string;

  @Column({ name: 'raw_html', type: 'text', select: false })
  rawHtml: string;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt: Date;

  // --- extract stage ---

  @Column({ type: 'varchar', length: 500, nullable: true })
  title: string | null;

  @Column({ type: 'text', nullable: true })
  byline: string | null;

  @Column({ name: 'site_name', type: 'text', nullable: true })
  siteName: string | null;

  @Column({ type: 'varchar', length: 35, nullable: true })
  lang: string | null;

  @Column({ type: 'text', nullable: true })
  excerpt: string | null;

  @Column({ name: 'published_time', type: 'text', nullable: true })
  publishedTime: string | null;

  @Column({ name: 'source_canonical_url', type: 'text', nullable: true })
  sourceCanonicalUrl: string | null;

  @Column({ name: 'content_html', type: 'text', nullable: true })
  contentHtml: string | null;

  @Column({ name: 'text_content', type: 'text', nullable: true })
  textContent: string | null;

  @Column({ name: 'word_count', type: 'int', nullable: true })
  wordCount: number | null;

  @Column({ name: 'extracted_at', type: 'timestamptz', nullable: true })
  extractedAt: Date | null;

  // --- Refresh (re-fetching changed pages) ---

  /** sha256 of text_content; a refresh compares it to detect a change. */
  @Column({ name: 'content_hash', type: 'char', length: 64, nullable: true })
  contentHash: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  etag: string | null;

  @Column({
    name: 'last_modified',
    type: 'text',
    nullable: true,
    select: false,
  })
  lastModified: string | null;

  @Column({ name: 'checked_at', type: 'timestamptz', nullable: true })
  checkedAt: Date | null;

  @Index('idx_bookmark_contents_next_check')
  @Column({ name: 'next_check_at', type: 'timestamptz', nullable: true })
  nextCheckAt: Date | null;

  @Column({ name: 'refresh_interval_hours', type: 'int', default: 12 })
  refreshIntervalHours: number;

  @Column({ name: 'refresh_failures', type: 'int', default: 0 })
  refreshFailures: number;

  @Column({ name: 'last_refresh_error', type: 'text', nullable: true })
  lastRefreshError: string | null;

  @Column({ name: 'content_changed_at', type: 'timestamptz', nullable: true })
  contentChangedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
