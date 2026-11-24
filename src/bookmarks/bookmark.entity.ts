import {
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { BaseEntity } from '../common/entities/base.entity';
import { ProcessingState } from '../ingestion/processing-state';
import { Collection } from '../collections/collection.entity';
import { Note } from '../notes/note.entity';
import { Tag } from '../tags/tag.entity';
import { User } from '../users/user.entity';

/** A saved resource. */
@Entity('bookmarks')
@Index('idx_bookmarks_user_created', ['userId', 'createdAt'])
// For sweeping rows stuck in an in-progress state (crashed workers).
@Index('idx_bookmarks_processing_state_changed', [
  'processingState',
  'processingStateChangedAt',
])
@Index('uq_bookmarks_user_canonical', ['userId', 'canonicalUrl'], {
  unique: true,
})
export class Bookmark extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  /** Exactly what the user submitted. Never rewritten. */
  @Column({ name: 'original_url', type: 'text' })
  originalUrl: string;

  @Column({ name: 'canonical_url', type: 'text', nullable: true })
  canonicalUrl: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  title: string | null;

  @Column({ name: 'is_favorite', default: false })
  isFavorite: boolean;

  @Column({ name: 'is_archived', default: false })
  isArchived: boolean;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;

  /** Owned by the pipeline; change only via transitionProcessingState. */
  @Column({
    name: 'processing_state',
    type: 'enum',
    enum: ProcessingState,
    enumName: 'bookmark_processing_state',
    default: ProcessingState.Pending,
  })
  processingState: ProcessingState;

  @Column({ name: 'processing_error', type: 'text', nullable: true })
  processingError: string | null;

  @Column({
    name: 'processing_state_changed_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  processingStateChangedAt: Date;

  @ManyToMany(() => Tag, (tag) => tag.bookmarks)
  @JoinTable({
    name: 'bookmark_tags',
    joinColumn: { name: 'bookmark_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags?: Tag[];

  @ManyToMany(() => Collection, (c) => c.bookmarks)
  @JoinTable({
    name: 'bookmark_collections',
    joinColumn: { name: 'bookmark_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'collection_id', referencedColumnName: 'id' },
  })
  collections?: Collection[];

  @OneToMany(() => Note, (n) => n.bookmark)
  notes?: Note[];
}
