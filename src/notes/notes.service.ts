import { Injectable, NotFoundException } from '@nestjs/common';
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

  /**
   * HAND-CODE (plan.md §2C): last-write-wins. Add a version check if
   * concurrent edits from multiple clients must not clobber each other.
   */
  async update(
    userId: string,
    bookmarkId: string,
    id: string,
    dto: UpdateNoteDto,
  ): Promise<Note> {
    const note = await this.findOwned(userId, bookmarkId, id);
    note.body = dto.body;
    return this.notes.save(note);
  }

  async remove(userId: string, bookmarkId: string, id: string): Promise<void> {
    await this.bookmarks.assertOwned(userId, bookmarkId);
    const res = await this.notes.delete({ id, bookmarkId });
    if (!res.affected) throw new NotFoundException('Note not found');
  }

  private async findOwned(
    userId: string,
    bookmarkId: string,
    id: string,
  ): Promise<Note> {
    await this.bookmarks.assertOwned(userId, bookmarkId);
    const note = await this.notes.findOneBy({ id, bookmarkId });
    if (!note) throw new NotFoundException('Note not found');
    return note;
  }
}
