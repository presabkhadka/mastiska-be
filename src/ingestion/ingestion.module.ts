import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookmarkChunk } from '../bookmarks/bookmark-chunk.entity';
import { BookmarkContent } from '../bookmarks/bookmark-content.entity';
import { Bookmark } from '../bookmarks/bookmark.entity';
import { BookmarksModule } from '../bookmarks/bookmarks.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { ContentExtractor } from './extract/content-extractor';
import { SafeFetcher } from './fetch/safe-fetcher';
import {
  EmbedProcessor,
  ExtractProcessor,
  FetchProcessor,
  SweepProcessor,
} from './ingestion.processors';
import { IngestionService } from './ingestion.service';
import { IngestionQueueModule } from './queue/ingestion-queue.module';

/** Workers. Runs in the API process for now. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Bookmark, BookmarkContent, BookmarkChunk]),
    BookmarksModule,
    EmbeddingModule,
    IngestionQueueModule,
  ],
  providers: [
    IngestionService,
    { provide: SafeFetcher, useFactory: () => new SafeFetcher() },
    { provide: ContentExtractor, useFactory: () => new ContentExtractor() },
    FetchProcessor,
    ExtractProcessor,
    EmbedProcessor,
    SweepProcessor,
  ],
})
export class IngestionModule {}
