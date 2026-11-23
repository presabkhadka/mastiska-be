import {
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator';
import { BookmarksService } from './bookmarks.service';

/**
 * Collection membership. Lives in the bookmarks module (which owns the join
 * table) to avoid a circular module dependency. List a collection's bookmarks
 * with GET /bookmarks?collectionId=...
 */
@ApiTags('collections')
@ApiBearerAuth()
@Controller('collections/:collectionId/bookmarks')
export class CollectionBookmarksController {
  constructor(private readonly bookmarks: BookmarksService) {}

  @Put(':bookmarkId')
  @HttpCode(204)
  add(
    @CurrentUser() user: AuthUser,
    @Param('collectionId', ParseUUIDPipe) collectionId: string,
    @Param('bookmarkId', ParseUUIDPipe) bookmarkId: string,
  ) {
    return this.bookmarks.addToCollection(user.id, collectionId, bookmarkId);
  }

  @Delete(':bookmarkId')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('collectionId', ParseUUIDPipe) collectionId: string,
    @Param('bookmarkId', ParseUUIDPipe) bookmarkId: string,
  ) {
    return this.bookmarks.removeFromCollection(
      user.id,
      collectionId,
      bookmarkId,
    );
  }
}
