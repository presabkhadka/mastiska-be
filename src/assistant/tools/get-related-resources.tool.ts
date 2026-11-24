import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { DataSource } from 'typeorm';
import { BookmarksService } from '../../bookmarks/bookmarks.service';
import { AssistantTool, ToolContext, ToolError } from './tool.types';

export class GetRelatedResourcesArgs {
  @IsUUID()
  bookmarkId: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  limit?: number;
}

@Injectable()
export class GetRelatedResourcesTool implements AssistantTool<GetRelatedResourcesArgs> {
  readonly name = 'getRelatedResources';
  readonly description =
    'Find other saved bookmarks most similar in content to a given bookmark.';
  readonly parameters = {
    type: 'OBJECT',
    properties: {
      bookmarkId: {
        type: 'STRING',
        description: 'Bookmark id (uuid) to find related ones for.',
      },
      limit: { type: 'INTEGER', description: 'Max results, 1-5 (default 3).' },
    },
    required: ['bookmarkId'],
  };
  readonly argsType = GetRelatedResourcesArgs;
  readonly requiresApproval = false;

  constructor(
    private readonly bookmarks: BookmarksService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async execute(args: GetRelatedResourcesArgs, ctx: ToolContext) {
    await this.bookmarks
      .assertOwned(ctx.userId, args.bookmarkId)
      .catch((err: unknown) => {
        if (err instanceof NotFoundException)
          throw new ToolError('Bookmark not found');
        throw err;
      });
    // Centroid of the bookmark's chunk vectors vs every chunk of the user's other bookmarks.
    const rows: {
      bookmarkId: string;
      title: string | null;
      url: string;
      similarity: string;
    }[] = await this.dataSource.query(
      `WITH target AS (
           SELECT avg(embedding) AS v FROM bookmark_chunks
           WHERE bookmark_id = $1 AND embedding IS NOT NULL
         )
         SELECT b.id AS "bookmarkId", b.title, b.original_url AS url,
                max(1 - (c.embedding <=> target.v)) AS similarity
         FROM bookmark_chunks c
         JOIN bookmarks b ON b.id = c.bookmark_id
         CROSS JOIN target
         WHERE b.user_id = $2 AND b.id <> $1 AND b.processing_state = 'ready'
           AND c.embedding IS NOT NULL AND target.v IS NOT NULL
         GROUP BY b.id
         ORDER BY similarity DESC
         LIMIT $3`,
      [args.bookmarkId, ctx.userId, args.limit ?? 3],
    );
    return {
      related: rows.map((r) => ({
        ...r,
        similarity: Number(Number(r.similarity).toFixed(3)),
      })),
    };
  }
}
