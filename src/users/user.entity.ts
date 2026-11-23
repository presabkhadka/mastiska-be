import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../common/entities/base.entity';

@Entity('users')
export class User extends BaseEntity {
  /** Stored lower-cased; uniqueness is enforced by the DB. */
  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash', select: false })
  passwordHash: string;

  @Column({ name: 'display_name', type: 'varchar', nullable: true })
  displayName: string | null;
}
