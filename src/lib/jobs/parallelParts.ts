/** Split work into N parts and run every part at the same time. */

export const PARALLEL_PARTS = Math.max(
  1,
  Number(process.env.PARALLEL_PARTS || 10) || 10,
);

/** Round-robin so each part gets a similar load. */
export function splitIntoParts<T>(
  items: readonly T[],
  parts: number = PARALLEL_PARTS,
): T[][] {
  if (!items.length) return [];
  const n = Math.max(1, Math.min(parts, items.length));
  const out: T[][] = Array.from({ length: n }, () => []);
  items.forEach((item, i) => {
    out[i % n].push(item);
  });
  return out;
}

/**
 * Run up to `parts` workers in parallel. Each worker gets one shard.
 * Empty shards are skipped.
 */
export async function mapPartsParallel<T, R>(
  items: readonly T[],
  parts: number,
  worker: (shard: T[], partIndex: number, partCount: number) => Promise<R>,
): Promise<R[]> {
  const shards = splitIntoParts(items, parts);
  if (!shards.length) return [];
  return Promise.all(
    shards.map((shard, i) => worker(shard, i, shards.length)),
  );
}
