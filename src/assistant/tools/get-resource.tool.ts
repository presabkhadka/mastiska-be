import { Injectable, NotFoundException } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import { Bookmark } from '../../bookmarks/bookmark.entity';
import { BookmarksService } from '../../bookmarks/bookmarks.service';
import { AssistantTool, ToolContext, ToolError } from './tool.types';

export class GetResourceArgs {
  @IsUUID()
  bookmarkId: string;
}

const EXCERPT_CHARS = 4000;

@Injectable()
export class GetResourceTool implements AssistantTool<GetResourceArgs> {
  readonly name = 'getResource';
  readonly description =
    'Get one saved bookmark by id: title, URL, tags, collections, reading status and the start of its article text.';
  readonly parameters = {
    type: 'OBJECT',
    properties: {
      bookmarkId: { type: 'STRING', description: 'Bookmark id (uuid).' },
    },
    required: ['bookmarkId'],
  };
  readonly argsType = GetResourceArgs;
  readonly requiresApproval = false;

  constructor(private readonly bookmarks: BookmarksService) {}

  async execute(args: GetResourceArgs, ctx: ToolContext) {
    let b: Bookmark;
    try {
      b = await this.bookmarks.findOne(ctx.userId, args.bookmarkId);
    } catch (err) {
      if (err instanceof NotFoundException)
        throw new ToolError('Bookmark not found');
      throw err;
    }
    const content = await this.bookmarks
      .getContent(ctx.userId, b.id)
      .catch((err: unknown) => {
        if (err instanceof NotFoundException) return null;
        throw err;
      });
    return {
      bookmarkId: b.id,
      title: b.title,
      url: b.originalUrl,
      processingState: b.processingState,
      isFavorite: b.isFavorite,
      isArchived: b.isArchived,
      read: b.readAt !== null,
      savedAt: b.createdAt,
      tags: (b.tags ?? []).map((t) => t.name),
      collections: (b.collections ?? []).map((c) => ({
        id: c.id,
        name: c.name,
      })),
      siteName: content?.siteName ?? null,
      wordCount: content?.wordCount ?? null,
      excerpt: content?.textContent?.slice(0, EXCERPT_CHARS) ?? null,
    };
  }
}
