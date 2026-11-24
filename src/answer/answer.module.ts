import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { AnswerController } from './answer.controller';
import { AnswerService } from './answer.service';
import { AskRateLimitGuard } from './ask-rate-limit.guard';
import { GeminiGenerator } from './gemini-generator';

@Module({
  imports: [RetrievalModule, RateLimitModule],
  controllers: [AnswerController],
  providers: [
    AnswerService,
    AskRateLimitGuard,
    {
      provide: GeminiGenerator,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new GeminiGenerator({
          apiKey: config.get<string>('GEMINI_API_KEY') ?? '',
          models: [
            config.getOrThrow<string>('ANSWER_MODEL'),
            ...(config.get<string>('ANSWER_FALLBACK_MODELS') ?? '').split(','),
          ]
            .map((m) => m.trim())
            .filter(Boolean),
        }),
    },
  ],
  exports: [GeminiGenerator],
})
export class AnswerModule {}
