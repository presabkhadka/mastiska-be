export enum ProcessingState {
  Pending = 'pending',
  Fetching = 'fetching',
  Fetched = 'fetched',
  Extracting = 'extracting',
  Ready = 'ready',
  Failed = 'failed',
  Unsupported = 'unsupported',
}

const S = ProcessingState;

export const PROCESSING_TRANSITIONS: Readonly<
  Record<ProcessingState, readonly ProcessingState[]>
> = {
  [S.Pending]: [S.Fetching],
  [S.Fetching]: [S.Fetched, S.Pending, S.Failed, S.Unsupported],
  [S.Fetched]: [S.Extracting],
  [S.Extracting]: [S.Ready, S.Fetched, S.Failed, S.Unsupported],
  [S.Ready]: [S.Pending],
  [S.Failed]: [S.Pending],
  [S.Unsupported]: [S.Pending],
};

/** Owned by a worker; stuck here = crashed worker. */
export const IN_PROGRESS_STATES: readonly ProcessingState[] = [
  S.Fetching,
  S.Extracting,
];

export function canTransition(
  from: ProcessingState,
  to: ProcessingState,
): boolean {
  return PROCESSING_TRANSITIONS[from].includes(to);
}

export class IllegalStateTransitionError extends Error {
  constructor(
    readonly from: ProcessingState,
    readonly to: ProcessingState,
  ) {
    super(`Illegal processing state transition: ${from} -> ${to}`);
    this.name = 'IllegalStateTransitionError';
  }
}

export function assertTransition(
  from: ProcessingState,
  to: ProcessingState,
): void {
  if (!canTransition(from, to)) throw new IllegalStateTransitionError(from, to);
}
