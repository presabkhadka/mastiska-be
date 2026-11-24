import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../embedding/embedding.module';
import { RetrievalService } from './retrieval.service';
import { SearchController } from './search.controller';

@Module({
  imports: [EmbeddingModule],
  controllers: [SearchController],
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
