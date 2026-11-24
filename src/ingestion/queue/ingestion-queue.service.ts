import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  EMBED_QUEUE,
  embedJobId,
  EXTRACT_QUEUE,
  extractJobId,
  FETCH_QUEUE,
  fetchJobId,
  IngestionJobData,
  STAGE_JOB_OPTIONS,
} from './ingestion-queue.constants';

const ENQUEUE_TIMEOUT_MS = 2_000;

@Injectable()
export class IngestionQueue {
  constructor(
    @InjectQueue(FETCH_QUEUE)
    private readonly fetchQueue: Queue<IngestionJobData>,
    @InjectQueue(EXTRACT_QUEUE)
    private readonly extractQueue: Queue<IngestionJobData>,
    @InjectQueue(EMBED_QUEUE)
    private readonly embedQueue: Queue<IngestionJobData>,
  ) {}

  // jobId dedups: adding while a job for this bookmark/stage exists is a no-op.
  enqueueFetch(bookmarkId: string): Promise<void> {
    return this.add(this.fetchQueue, fetchJobId(bookmarkId), bookmarkId);
  }

  enqueueExtract(bookmarkId: string): Promise<void> {
    return this.add(this.extractQueue, extractJobId(bookmarkId), bookmarkId);
  }

  enqueueEmbed(bookmarkId: string): Promise<void> {
    return this.add(this.embedQueue, embedJobId(bookmarkId), bookmarkId);
  }

  // Bounded so a Redis outage can't hang the API; the sweeper re-enqueues.
  private async add(
    queue: Queue<IngestionJobData>,
    jobId: string,
    bookmarkId: string,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`enqueue ${jobId} timed out`)),
        ENQUEUE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        queue.add(queue.name, { bookmarkId }, { ...STAGE_JOB_OPTIONS, jobId }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
