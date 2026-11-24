import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CollectionsModule } from '../collections/collections.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { IngestionQueueModule } from '../ingestion/queue/ingestion-queue.module';
import { TagsModule } from '../tags/tags.module';
import { BookmarkContent } from './bookmark-content.entity';
import { BookmarkIdentityService } from './bookmark-identity.service';
import { Bookmark } from './bookmark.entity';
import { BookmarksController } from './bookmarks.controller';
import { BookmarksService } from './bookmarks.service';
import { CollectionBookmarksController } from './collection-bookmarks.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Bookmark, BookmarkContent]),
    IngestionQueueModule,
    TagsModule,
    CollectionsModule,
    RateLimitModule,
  ],
  controllers: [BookmarksController, CollectionBookmarksController],
  providers: [BookmarksService, BookmarkIdentityService],
  exports: [BookmarksService],
})
export class BookmarksModule {}
