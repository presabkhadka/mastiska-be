export abstract class IngestionError extends Error {
  abstract readonly permanent: boolean;
}

/** Worth retrying: timeouts, resets, 5xx, 429. */
export class TransientIngestionError extends IngestionError {
  readonly permanent = false;
  constructor(message: string) {
    super(message);
    this.name = 'TransientIngestionError';
  }
}

/** Retrying won't help: blocked address, 4xx, not HTML, no readable content. */
export class PermanentIngestionError extends IngestionError {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentIngestionError';
  }
}

export function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}
