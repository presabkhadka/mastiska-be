import { Injectable } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RetrievalService } from '../../retrieval/retrieval.service';
import { AssistantTool, ToolContext } from './tool.types';

export class SearchLibraryArgs {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  query: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  limit?: number;

  @IsOptional()
  @Matches(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
  domain?: string;

  @IsOptional()
  @IsUUID()
  tagId?: string;

  @IsOptional()
  @IsUUID()
  collectionId?: string;
}

@Injectable()
export class SearchLibraryTool implements AssistantTool<SearchLibraryArgs> {
  readonly name = 'searchLibrary';
  readonly description =
    "Search the user's saved bookmarks (articles) by meaning and keywords. Returns the best matching passages with the bookmark id, title and URL.";
  readonly parameters = {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description: 'What to look for, in natural language.',
      },
      limit: { type: 'INTEGER', description: 'Max passages, 1-8 (default 5).' },
      domain: {
        type: 'STRING',
        description: 'Only bookmarks from this host, e.g. wikipedia.org.',
      },
      tagId: {
        type: 'STRING',
        description: 'Only bookmarks with this tag id.',
      },
      collectionId: {
        type: 'STRING',
        description: 'Only bookmarks in this collection id.',
      },
    },
    required: ['query'],
  };
  readonly argsType = SearchLibraryArgs;
  readonly requiresApproval = false;

  constructor(private readonly retrieval: RetrievalService) {}

  async execute(args: SearchLibraryArgs, ctx: ToolContext) {
    const res = await this.retrieval.search(ctx.userId, {
      q: args.query,
      mode: 'hybrid',
      limit: args.limit ?? 5,
      domain: args.domain,
      tagId: args.tagId,
      collectionId: args.collectionId,
    });
    return {
      degraded: res.degraded,
      results: res.results.map((r) => ({
        bookmarkId: r.bookmarkId,
        title: r.title,
        url: r.url,
        section: r.section,
        similarity:
          r.similarity === null ? null : Number(r.similarity.toFixed(3)),
        excerpt: r.content.slice(0, 600),
      })),
    };
  }
}
