import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { Bookmark } from '../bookmarks/bookmark.entity';
import { BaseEntity } from '../common/entities/base.entity';

/** Ownership is derived from the parent bookmark. */
@Entity('notes')
@Index('idx_notes_bookmark_created', ['bookmarkId', 'createdAt'])
export class Note extends BaseEntity {
  @Column({ name: 'bookmark_id', type: 'uuid' })
  bookmarkId: string;

  @ManyToOne(() => Bookmark, (b) => b.notes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bookmark_id' })
  bookmark?: Bookmark;

  @Column({ type: 'text' })
  body: string;
}
