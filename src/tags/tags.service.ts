import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { CreateTagDto, UpdateTagDto } from './dto/tag.dto';
import { Tag } from './tag.entity';

@Injectable()
export class TagsService {
  constructor(@InjectRepository(Tag) private readonly tags: Repository<Tag>) {}

  findAll(userId: string): Promise<Tag[]> {
    return this.tags.find({ where: { userId }, order: { name: 'ASC' } });
  }

  async findOne(userId: string, id: string): Promise<Tag> {
    const tag = await this.tags.findOneBy({ id, userId });
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  async create(userId: string, dto: CreateTagDto): Promise<Tag> {
    return this.saveOrConflict(this.tags.create({ ...dto, userId }));
  }

  async update(userId: string, id: string, dto: UpdateTagDto): Promise<Tag> {
    const tag = await this.findOne(userId, id);
    return this.saveOrConflict(this.tags.merge(tag, dto));
  }

  async remove(userId: string, id: string): Promise<void> {
    const res = await this.tags.delete({ id, userId });
    if (!res.affected) throw new NotFoundException('Tag not found');
  }

  private async saveOrConflict(tag: Tag): Promise<Tag> {
    try {
      return await this.tags.save(tag);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Tag "${tag.name}" already exists`);
      }
      throw err;
    }
  }
}
