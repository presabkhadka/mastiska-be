import {
  Column,
  Entity,
  JoinColumn,
  ManyToMany,
  ManyToOne,
  Unique,
} from 'typeorm';
import { Bookmark } from '../bookmarks/bookmark.entity';
import { BaseEntity } from '../common/entities/base.entity';
import { User } from '../users/user.entity';

@Entity('tags')
@Unique('uq_tags_user_name', ['userId', 'name'])
export class Tag extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ length: 50 })
  name: string;

  @ManyToMany(() => Bookmark, (b) => b.tags)
  bookmarks?: Bookmark[];
}
