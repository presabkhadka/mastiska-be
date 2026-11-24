export type MatchSource = 'vector' | 'text';

export interface Candidate {
  chunkId: string;
  bookmarkId: string;
  contentHash: string;
}

export interface Fused<T extends Candidate> {
  item: T;
  score: number;
  matchedBy: MatchSource[];
}

export interface FuseOptions {
  /** RRF constant; 60 is the value from the original paper. */
  k: number;
  limit: number;
  perBookmark: number;
  /** Multiplier per list; lets a weaker retriever contribute less. */
  weights: Record<MatchSource, number>;
}

export const DEFAULT_FUSE_OPTIONS: FuseOptions = {
  k: 60,
  limit: 10,
  perBookmark: 3,
  // Tuned with `pnpm eval:retrieval --sweep`: 0.7 is the largest text weight
  // that doesn't push vector's correct top hit down.
  weights: { vector: 1, text: 0.7 },
};

/**
 * Reciprocal Rank Fusion: score = sum of 1 / (k + rank) over the lists a
 * chunk appears in. Uses ranks only, so vector distances and text ranks
 * don't need to be on the same scale.
 */
export function fuse<T extends Candidate>(
  lists: Partial<Record<MatchSource, T[]>>,
  opts: FuseOptions = DEFAULT_FUSE_OPTIONS,
): Fused<T>[] {
  const byChunk = new Map<string, Fused<T>>();
  for (const [source, items] of Object.entries(lists) as [
    MatchSource,
    T[] | undefined,
  ][]) {
    if (!items) continue;
    items.forEach((item, index) => {
      const entry = byChunk.get(item.chunkId) ?? {
        item,
        score: 0,
        matchedBy: [],
      };
      entry.score += opts.weights[source] / (opts.k + index + 1);
      entry.matchedBy.push(source);
      byChunk.set(item.chunkId, entry);
    });
  }

  const ranked = [...byChunk.values()].sort((a, b) => b.score - a.score);

  // Identical passages (same page saved under two URLs) count once, and no
  // single bookmark can fill the whole result list.
  const seenHashes = new Set<string>();
  const perBookmark = new Map<string, number>();
  const out: Fused<T>[] = [];
  for (const r of ranked) {
    if (seenHashes.has(r.item.contentHash)) continue;
    const count = perBookmark.get(r.item.bookmarkId) ?? 0;
    if (count >= opts.perBookmark) continue;
    seenHashes.add(r.item.contentHash);
    perBookmark.set(r.item.bookmarkId, count + 1);
    out.push(r);
    if (out.length >= opts.limit) break;
  }
  return out;
}
