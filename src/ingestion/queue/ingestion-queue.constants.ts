import type { JobsOptions } from 'bullmq';

export const FETCH_QUEUE = 'ingest-fetch';
export const EXTRACT_QUEUE = 'ingest-extract';
export const EMBED_QUEUE = 'ingest-embed';
export const SWEEP_QUEUE = 'ingest-sweep';
export const REFRESH_QUEUE = 'ingest-refresh';
export const REFRESH_PLAN_QUEUE = 'ingest-refresh-plan';

/** Embed-queue job name for embedding new chunks of a bookmark that stays ready (after a refresh). */
export const REEMBED_JOB = 'reembed';

export interface IngestionJobData {
  bookmarkId: string;
}

// Completed/failed jobs are removed so the same jobId can be enqueued again;
// the bookmark row (processing_state/error) is the durable record.
export const STAGE_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  // Jitter spreads each wait over [50%, 100%] so mass failures don't retry in lockstep.
  backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
  removeOnComplete: true,
  removeOnFail: true,
};

export const fetchJobId = (bookmarkId: string) => `fetch-${bookmarkId}`;
export const extractJobId = (bookmarkId: string) => `extract-${bookmarkId}`;
export const embedJobId = (bookmarkId: string) => `embed-${bookmarkId}`;
export const refreshJobId = (bookmarkId: string) => `refresh-${bookmarkId}`;
export const reembedJobId = (bookmarkId: string) => `reembed-${bookmarkId}`;

// A refresh is retried by the next scheduled run, not by BullMQ.
export const REFRESH_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
};
