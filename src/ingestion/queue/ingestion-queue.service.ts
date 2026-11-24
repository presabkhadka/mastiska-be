import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { JobsOptions, Queue } from 'bullmq';
import {
  EMBED_QUEUE,
  embedJobId,
  EXTRACT_QUEUE,
  extractJobId,
  FETCH_QUEUE,
  fetchJobId,
  IngestionJobData,
  REEMBED_JOB,
  reembedJobId,
  REFRESH_JOB_OPTIONS,
  REFRESH_QUEUE,
  refreshJobId,
  STAGE_JOB_OPTIONS,
} from './ingestion-queue.constants';

// BullMQ: lower number = higher priority. Manual refreshes jump ahead of scheduled ones.
export const MANUAL_REFRESH_PRIORITY = 1;
export const SCHEDULED_REFRESH_PRIORITY = 10;

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
    @InjectQueue(REFRESH_QUEUE)
    private readonly refreshQueue: Queue<IngestionJobData>,
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

  enqueueReembed(bookmarkId: string): Promise<void> {
    return this.add(this.embedQueue, reembedJobId(bookmarkId), bookmarkId, {
      name: REEMBED_JOB,
    });
  }

  enqueueManualRefresh(bookmarkId: string): Promise<void> {
    return this.add(this.refreshQueue, refreshJobId(bookmarkId), bookmarkId, {
      ...REFRESH_JOB_OPTIONS,
      priority: MANUAL_REFRESH_PRIORITY,
    });
  }

  async enqueueScheduledRefreshes(bookmarkIds: string[]): Promise<void> {
    await this.refreshQueue.addBulk(
      bookmarkIds.map((bookmarkId) => ({
        name: REFRESH_QUEUE,
        data: { bookmarkId },
        opts: {
          ...REFRESH_JOB_OPTIONS,
          jobId: refreshJobId(bookmarkId),
          priority: SCHEDULED_REFRESH_PRIORITY,
        },
      })),
    );
  }

  // Bounded so a Redis outage can't hang the API; the sweeper re-enqueues.
  private async add(
    queue: Queue<IngestionJobData>,
    jobId: string,
    bookmarkId: string,
    opts: JobsOptions & { name?: string } = {},
  ): Promise<void> {
    const { name, ...jobOpts } = opts;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`enqueue ${jobId} timed out`)),
        ENQUEUE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        queue.add(
          name ?? queue.name,
          { bookmarkId },
          { ...STAGE_JOB_OPTIONS, ...jobOpts, jobId },
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
