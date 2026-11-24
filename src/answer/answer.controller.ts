import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator';
import { AnswerService, AskResponse } from './answer.service';
import { AskRateLimitGuard } from './ask-rate-limit.guard';
import { AskDto } from './dto/ask.dto';

@ApiTags('ask')
@ApiBearerAuth()
@Controller('ask')
export class AnswerController {
  constructor(private readonly answers: AnswerService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(AskRateLimitGuard)
  ask(
    @CurrentUser() user: AuthUser,
    @Body() dto: AskDto,
  ): Promise<AskResponse> {
    return this.answers.ask(user.id, dto);
  }
}
