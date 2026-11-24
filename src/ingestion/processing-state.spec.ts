import {
  assertTransition,
  canTransition,
  IllegalStateTransitionError,
  PROCESSING_TRANSITIONS,
  ProcessingState as S,
} from './processing-state';

describe('processing state machine', () => {
  const all = Object.values(S);

  it('defines transitions for every state', () => {
    expect(Object.keys(PROCESSING_TRANSITIONS).sort()).toEqual([...all].sort());
  });

  it.each([
    [S.Pending, S.Fetching],
    [S.Fetching, S.Fetched],
    [S.Fetching, S.Pending],
    [S.Fetching, S.Failed],
    [S.Fetching, S.Unsupported],
    [S.Fetched, S.Extracting],
    [S.Extracting, S.Ready],
    [S.Extracting, S.Fetched],
    [S.Extracting, S.Failed],
    [S.Extracting, S.Unsupported],
    [S.Ready, S.Pending],
    [S.Failed, S.Pending],
    [S.Unsupported, S.Pending],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    [S.Pending, S.Ready],
    [S.Pending, S.Extracting],
    [S.Fetched, S.Ready],
    [S.Ready, S.Fetching],
    [S.Ready, S.Extracting],
    [S.Failed, S.Fetching],
    [S.Unsupported, S.Extracting],
    [S.Extracting, S.Pending],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(
      IllegalStateTransitionError,
    );
  });

  it('rejects self-transitions', () => {
    for (const s of all) expect(canTransition(s, s)).toBe(false);
  });
});
