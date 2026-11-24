import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { UserRateLimitGuard } from '../common/rate-limit/user-rate-limit.guard';
import { AssistantService } from './assistant.service';
import { CreateConversationDto, SendMessageDto } from './dto/send-message.dto';

const AssistantRateLimit = UserRateLimitGuard(
  'assistant',
  'ASSISTANT_RATE_LIMIT_PER_MINUTE',
  'ASSISTANT_RATE_LIMIT_PER_DAY',
);

@ApiTags('assistant')
@ApiBearerAuth()
@Controller('conversations')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateConversationDto) {
    return this.assistant.createConversation(user.id, dto.title);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.assistant.listConversations(user.id, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistant.getConversation(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.assistant.deleteConversation(user.id, id);
  }

  @Post(':id/messages')
  @HttpCode(200)
  @UseGuards(AssistantRateLimit)
  send(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.assistant.sendMessage(user.id, id, dto);
  }

  @Post(':id/tool-calls/:toolCallId/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('toolCallId', ParseUUIDPipe) toolCallId: string,
  ) {
    return this.assistant.decide(user.id, id, toolCallId, true);
  }

  @Post(':id/tool-calls/:toolCallId/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('toolCallId', ParseUUIDPipe) toolCallId: string,
  ) {
    return this.assistant.decide(user.id, id, toolCallId, false);
  }
}
