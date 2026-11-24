import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BookmarksService } from '../bookmarks/bookmarks.service';
import { CreateNoteDto, UpdateNoteDto } from './dto/note.dto';
import { Note } from './note.entity';

/** Every method checks bookmark ownership first; notes have no userId. */
@Injectable()
export class NotesService {
  constructor(
    @InjectRepository(Note) private readonly notes: Repository<Note>,
    private readonly bookmarks: BookmarksService,
  ) {}

  async findAll(userId: string, bookmarkId: string): Promise<Note[]> {
    await this.bookmarks.assertOwned(userId, bookmarkId);
    return this.notes.find({
      where: { bookmarkId },
      order: { createdAt: 'ASC' },
    });
  }

  async create(
    userId: string,
    bookmarkId: string,
    dto: CreateNoteDto,
  ): Promise<Note> {
    await this.bookmarks.assertOwned(userId, bookmarkId);
    return this.notes.save(this.notes.create({ bookmarkId, body: dto.body }));
  }

  async update(
    userId: string,
    bookmarkId: string,
    id: string,
    dto: UpdateNoteDto,
  ): Promise<Note> {
    await this.bookmarks.assertOwned(userId, bookmarkId);
    const res = await this.notes
      .createQueryBuilder()
      .update(Note)
      .set({ body: dto.body, version: () => 'version + 1' })
      .where('id = :id AND bookmark_id = :bookmarkId AND version = :version', {
        id,
        bookmarkId,
        version: dto.version,
      })
      .execute();
    if (res.affected) return this.notes.findOneByOrFail({ id });
    if (await this.notes.existsBy({ id, bookmarkId })) {
      throw new ConflictException(
        'Note was changed since you loaded it; reload and try again',
      );
    }
    throw new NotFoundException('Note not found');
  }

  async remove(userId: string, bookmarkId: string, id: string): Promise<void> {
    await this.bookmarks.assertOwned(userId, bookmarkId);
    const res = await this.notes.delete({ id, bookmarkId });
    if (!res.affected) throw new NotFoundException('Note not found');
  }
}
