import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { DataSource, EntityManager, In } from 'typeorm';
import { Bookmark } from '../../bookmarks/bookmark.entity';
import { Collection } from '../../collections/collection.entity';
import { AssistantTool, ToolContext, ToolError } from './tool.types';

export class CreateCollectionArgs {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  bookmarkIds?: string[];
}

@Injectable()
export class CreateCollectionTool implements AssistantTool<CreateCollectionArgs> {
  readonly name = 'createCollection';
  readonly description =
    "Create a collection, optionally containing some of the user's bookmarks (by bookmark id). Requires the user's approval before it runs.";
  readonly parameters = {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING', description: 'Collection name (max 100 chars).' },
      description: { type: 'STRING', description: 'Optional description.' },
      bookmarkIds: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description:
          'Ids of bookmarks to add (from searchLibrary or getResource results).',
      },
    },
    required: ['name'],
  };
  readonly argsType = CreateCollectionArgs;
  readonly requiresApproval = true;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async describe(
    args: CreateCollectionArgs,
    ctx: ToolContext,
  ): Promise<string> {
    const ids = args.bookmarkIds ?? [];
    if (!ids.length) return `create the empty collection "${args.name}"`;
    const bookmarks = await this.dataSource.manager.find(Bookmark, {
      where: { id: In(ids), userId: ctx.userId },
      select: { id: true, title: true, originalUrl: true },
    });
    const titles = bookmarks.map((b) => `"${b.title ?? b.originalUrl}"`);
    return `create the collection "${args.name}" with ${titles.length} bookmark${titles.length === 1 ? '' : 's'}: ${titles.join(', ')}`;
  }

  async precheck(args: CreateCollectionArgs, ctx: ToolContext) {
    const missing = await this.unownedIds(
      this.dataSource.manager,
      args,
      ctx.userId,
    );
    return missing.length ? `Bookmarks not found: ${missing.join(', ')}` : null;
  }

  async execute(args: CreateCollectionArgs, ctx: ToolContext) {
    const m = ctx.manager ?? this.dataSource.manager;
    // Re-checked inside the approval transaction: a bookmark may have been deleted meanwhile.
    const missing = await this.unownedIds(m, args, ctx.userId);
    if (missing.length)
      throw new ToolError(`Bookmarks not found: ${missing.join(', ')}`);

    const collection = await m.save(
      m.create(Collection, {
        userId: ctx.userId,
        name: args.name,
        description: args.description ?? null,
      }),
    );
    const ids = args.bookmarkIds ?? [];
    if (ids.length) {
      await m
        .createQueryBuilder()
        .insert()
        .into('bookmark_collections')
        .values(
          ids.map((bookmarkId) => ({
            bookmark_id: bookmarkId,
            collection_id: collection.id,
          })),
        )
        .orIgnore()
        .execute();
    }
    return {
      collectionId: collection.id,
      name: collection.name,
      bookmarkCount: ids.length,
    };
  }

  private async unownedIds(
    m: EntityManager,
    args: CreateCollectionArgs,
    userId: string,
  ) {
    const ids = args.bookmarkIds ?? [];
    if (!ids.length) return [];
    const owned = await m.find(Bookmark, {
      where: { id: In(ids), userId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((b) => b.id));
    return ids.filter((id) => !ownedIds.has(id));
  }
}
