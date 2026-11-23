import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { paginate, Paginated } from '../common/dto/paginated.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Collection } from './collection.entity';
import { CreateCollectionDto, UpdateCollectionDto } from './dto/collection.dto';

@Injectable()
export class CollectionsService {
  constructor(
    @InjectRepository(Collection)
    private readonly collections: Repository<Collection>,
  ) {}

  async findAll(
    userId: string,
    q: PaginationQueryDto,
  ): Promise<Paginated<Collection>> {
    const [items, total] = await this.collections.findAndCount({
      where: { userId },
      order: { createdAt: q.order },
      skip: q.skip,
      take: q.limit,
    });
    return paginate(items, total, q.page, q.limit);
  }

  async findOne(userId: string, id: string): Promise<Collection> {
    const c = await this.collections.findOneBy({ id, userId });
    if (!c) throw new NotFoundException('Collection not found');
    return c;
  }

  create(userId: string, dto: CreateCollectionDto): Promise<Collection> {
    return this.collections.save(this.collections.create({ ...dto, userId }));
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateCollectionDto,
  ): Promise<Collection> {
    const c = await this.findOne(userId, id);
    return this.collections.save(this.collections.merge(c, dto));
  }

  async remove(userId: string, id: string): Promise<void> {
    const res = await this.collections.delete({ id, userId });
    if (!res.affected) throw new NotFoundException('Collection not found');
  }
}
