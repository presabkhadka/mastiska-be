import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator';
import { BookmarksService } from './bookmarks.service';
import { BookmarkQueryDto } from './dto/bookmark-query.dto';
import { CreateBookmarkDto } from './dto/create-bookmark.dto';
import { UpdateBookmarkDto } from './dto/update-bookmark.dto';

@ApiTags('bookmarks')
@ApiBearerAuth()
@Controller('bookmarks')
export class BookmarksController {
  constructor(private readonly bookmarks: BookmarksService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() q: BookmarkQueryDto) {
    return this.bookmarks.findAll(user.id, q);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookmarks.findOne(user.id, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBookmarkDto) {
    return this.bookmarks.create(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBookmarkDto,
  ) {
    return this.bookmarks.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookmarks.remove(user.id, id);
  }

  @Put(':id/tags/:tagId')
  @HttpCode(204)
  addTag(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
  ) {
    return this.bookmarks.addTag(user.id, id, tagId);
  }

  @Delete(':id/tags/:tagId')
  @HttpCode(204)
  removeTag(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
  ) {
    return this.bookmarks.removeTag(user.id, id, tagId);
  }
}
