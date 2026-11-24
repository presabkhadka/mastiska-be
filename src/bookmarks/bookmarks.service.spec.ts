import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { CollectionsService } from '../collections/collections.service';
import {
  IllegalStateTransitionError,
  ProcessingState,
} from '../ingestion/processing-state';
import { TagsService } from '../tags/tags.service';
import { BookmarkIdentityService } from './bookmark-identity.service';
import { Bookmark } from './bookmark.entity';
import { BookmarksService } from './bookmarks.service';

describe('BookmarksService', () => {
  let service: BookmarksService;
  const relationBuilder = { of: jest.fn(), add: jest.fn(), remove: jest.fn() };
  const updateBuilder = {
    set: jest.fn(),
    where: jest.fn(),
    execute: jest.fn(),
  };
  const repo = {
    create: jest.fn((x: Partial<Bookmark>) => ({ ...x })),
    save: jest.fn((x: Partial<Bookmark>) =>
      Promise.resolve({ id: 'b1', ...x }),
    ),
    merge: jest.fn((target: object, src: object) => Object.assign(target, src)),
    findOne: jest.fn(),
    existsBy: jest.fn(),
    delete: jest.fn(),
    update: jest.fn<Promise<{ affected: number }>, [object, object]>(),
    createQueryBuilder: jest.fn(() => ({
      relation: jest.fn(() => relationBuilder),
      update: jest.fn(() => updateBuilder),
    })),
  };
  const identity = { canonicalize: jest.fn((u: string) => `canon:${u}`) };
  const tags = { findOne: jest.fn() };
  const collections = { findOne: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    relationBuilder.of.mockReturnValue(relationBuilder);
    updateBuilder.set.mockReturnValue(updateBuilder);
    updateBuilder.where.mockReturnValue(updateBuilder);
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
      processingState: ProcessingState.Pending,
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

  it('update writes only user-owned columns, scoped by user', async () => {
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({ id: 'b1' });
    await service.update('u1', 'b1', { title: 'T', isFavorite: true });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'b1', userId: 'u1' },
      { title: 'T', isFavorite: true },
    );
  });

  it('update isRead keeps the first read time and clears it', async () => {
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({ id: 'b1' });
    await service.update('u1', 'b1', { isRead: true });
    const set = repo.update.mock.calls[0][1] as { readAt: () => string };
    expect(set.readAt()).toBe('COALESCE(read_at, now())');

    await service.update('u1', 'b1', { isRead: false });
    expect(repo.update.mock.calls[1][1]).toEqual({ readAt: null });
  });

  it('update 404s when the bookmark is not owned', async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    await expect(
      service.update('u1', 'b1', { title: 'T' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('transitionProcessingState is a compare-and-set on the current state', async () => {
    updateBuilder.execute.mockResolvedValue({ affected: 1 });
    await expect(
      service.transitionProcessingState(
        'b1',
        ProcessingState.Pending,
        ProcessingState.Fetching,
      ),
    ).resolves.toBe(true);
    expect(updateBuilder.where).toHaveBeenCalledWith(
      'id = :id AND processing_state = :from',
      { id: 'b1', from: ProcessingState.Pending },
    );
  });

  it('transitionProcessingState returns false when another worker won', async () => {
    updateBuilder.execute.mockResolvedValue({ affected: 0 });
    await expect(
      service.transitionProcessingState(
        'b1',
        ProcessingState.Pending,
        ProcessingState.Fetching,
      ),
    ).resolves.toBe(false);
  });

  it('transitionProcessingState rejects illegal transitions before touching the DB', async () => {
    await expect(
      service.transitionProcessingState(
        'b1',
        ProcessingState.Pending,
        ProcessingState.Ready,
      ),
    ).rejects.toBeInstanceOf(IllegalStateTransitionError);
    expect(updateBuilder.execute).not.toHaveBeenCalled();
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
