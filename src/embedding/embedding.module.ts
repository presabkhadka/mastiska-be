import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMBEDDING_DIMENSIONS } from '../bookmarks/bookmark-chunk.entity';
import { GeminiEmbedder } from './gemini-embedder';

@Module({
  providers: [
    {
      provide: GeminiEmbedder,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new GeminiEmbedder({
          apiKey: config.get<string>('GEMINI_API_KEY') ?? '',
          model: config.getOrThrow<string>('EMBEDDING_MODEL'),
          dimensions: EMBEDDING_DIMENSIONS,
        }),
    },
  ],
  exports: [GeminiEmbedder],
})
export class EmbeddingModule {}
