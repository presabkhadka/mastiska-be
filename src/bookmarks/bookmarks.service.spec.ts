import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { CollectionsService } from '../collections/collections.service';
import { TagsService } from '../tags/tags.service';
import { BookmarkIdentityService } from './bookmark-identity.service';
import { Bookmark } from './bookmark.entity';
import { BookmarksService } from './bookmarks.service';

describe('BookmarksService', () => {
  let service: BookmarksService;
  const relationBuilder = { of: jest.fn(), add: jest.fn(), remove: jest.fn() };
  const repo = {
    create: jest.fn((x: Partial<Bookmark>) => ({ ...x })),
    save: jest.fn((x: Partial<Bookmark>) =>
      Promise.resolve({ id: 'b1', ...x }),
    ),
    merge: jest.fn((target: object, src: object) => Object.assign(target, src)),
    findOne: jest.fn(),
    existsBy: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      relation: jest.fn(() => relationBuilder),
    })),
  };
  const identity = { canonicalize: jest.fn((u: string) => `canon:${u}`) };
  const tags = { findOne: jest.fn() };
  const collections = { findOne: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    relationBuilder.of.mockReturnValue(relationBuilder);
    const mod = await Test.createTestingModule({
      providers: [
        BookmarksService,
        { provide: getRepositoryToken(Bookmark), useValue: repo },
        { provide: BookmarkIdentityService, useValue: identity },
        { provide: TagsService, useValue: tags },
        { provide: CollectionsService, useValue: collections },
      ],
    }).compile();
    service = mod.get(BookmarksService);
  });

  it('create stores the original URL untouched and delegates canonicalization', async () => {
    const res = await service.create('u1', { url: 'https://x.dev/a' });
    expect(identity.canonicalize).toHaveBeenCalledWith('https://x.dev/a');
    expect(res).toMatchObject({
      userId: 'u1',
      originalUrl: 'https://x.dev/a',
      canonicalUrl: 'canon:https://x.dev/a',
      title: null,
    });
  });

  it('findOne scopes by user and 404s when not owned', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.findOne('u1', 'b1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1', userId: 'u1' } }),
    );
  });

  it('update isRead sets readAt once and clears it', async () => {
    const b = { id: 'b1', userId: 'u1', readAt: null as Date | null };
    repo.findOne.mockResolvedValue(b);
    await service.update('u1', 'b1', { isRead: true });
    const first = b.readAt;
    expect(first).toBeInstanceOf(Date);

    await service.update('u1', 'b1', { isRead: true });
    expect(b.readAt).toBe(first);

    await service.update('u1', 'b1', { isRead: false });
    expect(b.readAt).toBeNull();
  });

  it('remove 404s when nothing deleted', async () => {
    repo.delete.mockResolvedValue({ affected: 0 });
    await expect(service.remove('u1', 'b1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('addTag is idempotent on unique violation', async () => {
    repo.existsBy.mockResolvedValue(true);
    tags.findOne.mockResolvedValue({ id: 't1' });
    relationBuilder.add.mockRejectedValue(
      new QueryFailedError(
        '',
        [],
        Object.assign(new Error(), { code: '23505' }),
      ),
    );
    await expect(service.addTag('u1', 'b1', 't1')).resolves.toBeUndefined();
  });

  it('addTag rejects a tag owned by someone else', async () => {
    repo.existsBy.mockResolvedValue(true);
    tags.findOne.mockRejectedValue(new NotFoundException());
    await expect(service.addTag('u1', 'b1', 't1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(relationBuilder.add).not.toHaveBeenCalled();
  });
});
