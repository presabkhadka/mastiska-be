import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import {
  EMBED_QUEUE,
  EXTRACT_QUEUE,
  FETCH_QUEUE,
  REFRESH_PLAN_QUEUE,
  REFRESH_QUEUE,
  SWEEP_QUEUE,
} from './ingestion-queue.constants';
import { IngestionQueue } from './ingestion-queue.service';

/** Producer side only, so BookmarksModule can enqueue without importing the workers. */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: FETCH_QUEUE },
      { name: EXTRACT_QUEUE },
      { name: EMBED_QUEUE },
      { name: SWEEP_QUEUE },
      { name: REFRESH_QUEUE },
      { name: REFRESH_PLAN_QUEUE },
    ),
  ],
  providers: [IngestionQueue],
  exports: [IngestionQueue, BullModule],
})
export class IngestionQueueModule {}
