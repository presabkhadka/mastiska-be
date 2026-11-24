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
    const m = this.dataSource.manager;
    if (await this.nameTaken(m, args.name, ctx.userId)) {
      return `A collection named "${args.name}" already exists`;
    }
    const missing = await this.unownedIds(m, args, ctx.userId);
    return missing.length ? `Bookmarks not found: ${missing.join(', ')}` : null;
  }

  async execute(args: CreateCollectionArgs, ctx: ToolContext) {
    const m = ctx.manager ?? this.dataSource.manager;
    // Re-checked inside the approval transaction: a bookmark may have been deleted meanwhile.
    const missing = await this.unownedIds(m, args, ctx.userId, !!ctx.manager);
    if (missing.length)
      throw new ToolError(`Bookmarks not found: ${missing.join(', ')}`);

    // ON CONFLICT instead of catching: a unique violation would abort the approval transaction.
    const inserted = await m.query<{ id: string; name: string }[]>(
      `INSERT INTO collections (user_id, name, description) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, lower(name)) DO NOTHING
       RETURNING id, name`,
      [ctx.userId, args.name, args.description ?? null],
    );
    const collection = inserted[0];
    if (!collection) {
      throw new ToolError(`A collection named "${args.name}" already exists`);
    }
    const ids = args.bookmarkIds ?? [];
    if (ids.length) {
      await m.query(
        `INSERT INTO bookmark_collections (bookmark_id, collection_id, user_id)
         SELECT unnest($1::uuid[]), $2, $3
         ON CONFLICT DO NOTHING`,
        [ids, collection.id, ctx.userId],
      );
    }
    return {
      collectionId: collection.id,
      name: collection.name,
      bookmarkCount: ids.length,
    };
  }

  private nameTaken(m: EntityManager, name: string, userId: string) {
    return m
      .createQueryBuilder(Collection, 'c')
      .where('c.user_id = :userId AND lower(c.name) = lower(:name)', {
        userId,
        name,
      })
      .getExists();
  }

  private async unownedIds(
    m: EntityManager,
    args: CreateCollectionArgs,
    userId: string,
    lock = false,
  ) {
    const ids = args.bookmarkIds ?? [];
    if (!ids.length) return [];
    // FOR SHARE inside the approval transaction: a concurrent delete waits instead of breaking the link insert.
    const owned = await m.find(Bookmark, {
      where: { id: In(ids), userId },
      select: { id: true },
      ...(lock && { lock: { mode: 'pessimistic_read' as const } }),
    });
    const ownedIds = new Set(owned.map((b) => b.id));
    return ids.filter((id) => !ownedIds.has(id));
  }
}
