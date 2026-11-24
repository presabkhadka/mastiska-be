import { Candidate, DEFAULT_FUSE_OPTIONS, fuse } from './fusion';

const c = (id: string, bookmarkId = 'b1', contentHash = id): Candidate => ({
  chunkId: id,
  bookmarkId,
  contentHash,
});
const ids = (r: { item: Candidate }[]) => r.map((x) => x.item.chunkId);
const equal = { ...DEFAULT_FUSE_OPTIONS, weights: { vector: 1, text: 1 } };

describe('fuse (reciprocal rank fusion)', () => {
  it('ranks items found by both retrievers above items found by one', () => {
    const out = fuse(
      {
        vector: [c('a', 'b1'), c('both', 'b2')],
        text: [c('x', 'b3'), c('both', 'b2')],
      },
      equal,
    );
    expect(ids(out)[0]).toBe('both');
    expect(out[0].matchedBy).toEqual(['vector', 'text']);
  });

  it('a lower text weight lets the vector winner keep first place', () => {
    const lists = {
      vector: [c('v1', 'b1'), c('shared', 'b2')],
      text: [c('t1', 'b3'), c('shared', 'b2')],
    };
    // Equal weights: shared (2nd in both) beats v1 (1st in vector only).
    expect(ids(fuse(lists, equal))[0]).toBe('shared');
    const weighted = fuse(lists, {
      ...equal,
      weights: { vector: 1, text: 0.01 },
    });
    expect(ids(weighted)[0]).toBe('v1');
  });

  it('skips a missing list', () => {
    expect(ids(fuse({ vector: [c('a')], text: undefined }))).toEqual(['a']);
  });

  it('caps passages per bookmark', () => {
    const out = fuse(
      { vector: ['1', '2', '3', '4'].map((i) => c(i, 'b1')) },
      { ...equal, perBookmark: 2 },
    );
    expect(ids(out)).toEqual(['1', '2']);
  });

  it('dedupes identical passages from different bookmarks', () => {
    const out = fuse({
      vector: [c('a', 'b1', 'same'), c('b', 'b2', 'same'), c('c', 'b3')],
    });
    expect(ids(out)).toEqual(['a', 'c']);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`${i}`, `b${i}`));
    expect(fuse({ vector: many }, { ...equal, limit: 5 })).toHaveLength(5);
  });
});
