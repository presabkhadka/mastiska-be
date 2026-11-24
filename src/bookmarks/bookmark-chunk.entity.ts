import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Bookmark } from './bookmark.entity';

/** Must match the vector column size; changing it needs a migration and a re-embed. */
export const EMBEDDING_DIMENSIONS = 768;

/** A passage of a bookmark's article. Title/URL come from the bookmark. */
@Entity('bookmark_chunks')
@Index('uq_bookmark_chunks_position', ['bookmarkId', 'position'], {
  unique: true,
})
export class BookmarkChunk {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'bookmark_id', type: 'uuid' })
  bookmarkId: string;

  @ManyToOne(() => Bookmark, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bookmark_id' })
  bookmark?: Bookmark;

  @Column({ type: 'int' })
  position: number;

  /** Heading path, e.g. "History > Early work". */
  @Column({ type: 'text', nullable: true })
  section: string | null;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'token_estimate', type: 'int' })
  tokenEstimate: number;

  /** sha256 of the embedding input; lets unchanged chunks keep their vector. */
  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash: string;

  // HNSW (vector_cosine_ops) index is managed in migrations; TypeORM can't express it.
  @Index('idx_bookmark_chunks_embedding', { synchronize: false })
  @Column({
    type: 'vector',
    length: EMBEDDING_DIMENSIONS,
    nullable: true,
    select: false,
  })
  embedding: number[] | null;

  @Column({
    name: 'embedding_model',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  embeddingModel: string | null;

  @Column({ name: 'embedded_at', type: 'timestamptz', nullable: true })
  embeddedAt: Date | null;

  /** Maintained by Postgres; headings weigh more than body text. */
  @Index('idx_bookmark_chunks_search', { synchronize: false })
  @Column({
    name: 'search_vector',
    type: 'tsvector',
    generatedType: 'STORED',
    asExpression: `setweight(to_tsvector('english', coalesce("section", '')), 'A') || setweight(to_tsvector('english', "content"), 'B')`,
    select: false,
    insert: false,
    update: false,
  })
  searchVector?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
