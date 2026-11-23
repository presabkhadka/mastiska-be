import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.users.findOneBy({ id });
  }

  /** Includes passwordHash, which is excluded from selects by default. */
  findByEmailWithPassword(email: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email: email.toLowerCase() })
      .getOne();
  }

  create(data: {
    email: string;
    passwordHash: string;
    displayName?: string;
  }): Promise<User> {
    return this.users.save(
      this.users.create({
        email: data.email.toLowerCase(),
        passwordHash: data.passwordHash,
        displayName: data.displayName ?? null,
      }),
    );
  }
}
