import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToMany,
  ManyToOne,
  Unique,
} from 'typeorm';
import { Bookmark } from '../bookmarks/bookmark.entity';
import { BaseEntity } from '../common/entities/base.entity';
import { User } from '../users/user.entity';

@Entity('collections')
@Index('idx_collections_user_created', ['userId', 'createdAt'])
@Unique('uq_collections_id_user', ['id', 'userId'])
export class Collection extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  // Real index is UNIQUE (user_id, lower(name)), created in the migration.
  @Index('uq_collections_user_lower_name', { synchronize: false })
  @Column({ length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @ManyToMany(() => Bookmark, (b) => b.collections)
  bookmarks?: Bookmark[];
}
