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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator';
import { CreateNoteDto, UpdateNoteDto } from './dto/note.dto';
import { NotesService } from './notes.service';

@ApiTags('notes')
@ApiBearerAuth()
@Controller('bookmarks/:bookmarkId/notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Param('bookmarkId', ParseUUIDPipe) bookmarkId: string,
  ) {
    return this.notes.findAll(user.id, bookmarkId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('bookmarkId', ParseUUIDPipe) bookmarkId: string,
    @Body() dto: CreateNoteDto,
  ) {
    return this.notes.create(user.id, bookmarkId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('bookmarkId', ParseUUIDPipe) bookmarkId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNoteDto,
  ) {
    return this.notes.update(user.id, bookmarkId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('bookmarkId', ParseUUIDPipe) bookmarkId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notes.remove(user.id, bookmarkId, id);
  }
}
