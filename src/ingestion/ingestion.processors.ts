import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { Attempt, IngestionService } from './ingestion.service';
import {
  EMBED_QUEUE,
  EXTRACT_QUEUE,
  FETCH_QUEUE,
  IngestionJobData,
  REEMBED_JOB,
  REFRESH_PLAN_QUEUE,
  REFRESH_QUEUE,
  SWEEP_QUEUE,
} from './queue/ingestion-queue.constants';

const attemptOf = (job: Job): Attempt => ({
  made: job.attemptsMade,
  max: job.opts.attempts ?? 1,
});

// Fetch is network-bound, extract is CPU-bound: separate queues so each
// gets its own concurrency.
@Processor(FETCH_QUEUE, { concurrency: 5 })
export class FetchProcessor extends WorkerHost {
  constructor(private readonly ingestion: IngestionService) {
    super();
  }

  process(job: Job<IngestionJobData>) {
    return this.ingestion.fetch(job.data.bookmarkId, attemptOf(job));
  }
}

@Processor(EXTRACT_QUEUE, { concurrency: 2 })
export class ExtractProcessor extends WorkerHost {
  constructor(private readonly ingestion: IngestionService) {
    super();
  }

  process(job: Job<IngestionJobData>) {
    return this.ingestion.extract(job.data.bookmarkId, attemptOf(job));
  }
}

// Gemini free tier has low request limits; the limiter is per queue across
// all workers (stored in Redis). Each job makes ceil(chunks / 50) requests.
// Read from env at import time because decorator options are static.
const EMBED_JOBS_PER_MINUTE = Number(process.env.EMBED_JOBS_PER_MINUTE) || 20;

@Processor(EMBED_QUEUE, {
  concurrency: 1,
  limiter: { max: EMBED_JOBS_PER_MINUTE, duration: 60_000 },
})
export class EmbedProcessor extends WorkerHost {
  constructor(private readonly ingestion: IngestionService) {
    super();
  }

  process(job: Job<IngestionJobData>) {
    return job.name === REEMBED_JOB
      ? this.ingestion.reembed(job.data.bookmarkId)
      : this.ingestion.embed(job.data.bookmarkId, attemptOf(job));
  }
}

export const SWEEP_EVERY_MS = 60_000;

@Processor(SWEEP_QUEUE, { concurrency: 1 })
export class SweepProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly ingestion: IngestionService,
    @InjectQueue(SWEEP_QUEUE) private readonly sweepQueue: Queue,
  ) {
    super();
  }

  // A job scheduler (not setInterval) so only one sweep runs per interval
  // across all app instances.
  async onModuleInit() {
    await this.sweepQueue.upsertJobScheduler(
      'ingestion-sweep',
      { every: SWEEP_EVERY_MS },
      { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
  }

  process() {
    return this.ingestion.sweep();
  }
}

// Trickles a scheduled batch out instead of fetching hundreds of pages at once.
@Processor(REFRESH_QUEUE, {
  concurrency: 3,
  limiter: { max: 30, duration: 60_000 },
})
export class RefreshProcessor extends WorkerHost {
  constructor(private readonly ingestion: IngestionService) {
    super();
  }

  process(job: Job<IngestionJobData>) {
    return this.ingestion.refresh(job.data.bookmarkId);
  }
}

@Processor(REFRESH_PLAN_QUEUE, { concurrency: 1 })
export class RefreshPlanProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly config: ConfigService,
    @InjectQueue(REFRESH_PLAN_QUEUE) private readonly planQueue: Queue,
  ) {
    super();
  }

  // Cron job scheduler: one planning run per slot across all app instances.
  async onModuleInit() {
    await this.planQueue.upsertJobScheduler(
      'content-refresh',
      {
        pattern: this.config.getOrThrow<string>('REFRESH_CRON'),
        tz: this.config.getOrThrow<string>('REFRESH_TIMEZONE'),
      },
      { name: 'plan', opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
  }

  process() {
    return this.ingestion.planRefreshes(
      this.config.getOrThrow<number>('REFRESH_MAX_PER_RUN'),
      this.config.getOrThrow<number>('REFRESH_MAX_PER_USER_PER_RUN'),
    );
  }
}
