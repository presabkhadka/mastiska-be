import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CollectionsModule } from '../collections/collections.module';
import { TagsModule } from '../tags/tags.module';
import { BookmarkIdentityService } from './bookmark-identity.service';
import { Bookmark } from './bookmark.entity';
import { BookmarksController } from './bookmarks.controller';
import { BookmarksService } from './bookmarks.service';
import { CollectionBookmarksController } from './collection-bookmarks.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Bookmark]),
    TagsModule,
    CollectionsModule,
  ],
  controllers: [BookmarksController, CollectionBookmarksController],
  providers: [BookmarksService, BookmarkIdentityService],
  exports: [BookmarksService],
})
export class BookmarksModule {}
