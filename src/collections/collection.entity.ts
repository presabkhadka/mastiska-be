import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToMany,
  ManyToOne,
} from 'typeorm';
import { Bookmark } from '../bookmarks/bookmark.entity';
import { BaseEntity } from '../common/entities/base.entity';
import { User } from '../users/user.entity';

/**
 * HAND-CODE (plan.md §3 "Collections and tags"): integrity constraints beyond
 * the join-table PK. E.g. should name be unique per user? Should the DB (not
 * just the service) guarantee a bookmark and collection share an owner?
 */
@Entity('collections')
@Index('idx_collections_user_created', ['userId', 'createdAt'])
export class Collection extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @ManyToMany(() => Bookmark, (b) => b.collections)
  bookmarks?: Bookmark[];
}
