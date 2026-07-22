import { existsSync, readFileSync } from 'node:fs';
import type { ZodType } from 'zod';
import { atomicWriteJson } from '../storage/files';

export interface TieredCacheSpec<V> {
  /** Cache file path — also the in-memory memo key. */
  readonly path: string;
  readonly schema: ZodType<V>;
  /** Whether a validated cache file may be served without refetching (default: always). */
  readonly isUsable?: (cached: V) => boolean;
  readonly fetch: () => Promise<V>;
}

/** getMany() spec: tiers 1–2 as in get(); tier 3 is the caller's batched fetch. */
export type TieredCachePeekSpec<V> = Omit<TieredCacheSpec<V>, 'fetch'>;

/**
 * The three-tier read path every dataset in the DataCatalog shares:
 *   1. memory  — return the memoized value if still usable
 *   2. file    — zod-validate the cache file; memoize and return if usable
 *   3. provider — fetch, write the file atomically, memoize, return
 * A value that fails validation or the isUsable rule falls through to the
 * next tier — including the memo, so freshness rules (e.g. a 24h TTL on
 * current-year files) hold in a long-running process. forceRefresh skips
 * tiers 1-2.
 */
export class TieredCache {
  private readonly memo = new Map<string, unknown>();

  async get<V>(spec: TieredCacheSpec<V>, forceRefresh = false): Promise<V> {
    if (!forceRefresh) {
      if (this.memo.has(spec.path)) {
        const memoized = this.memo.get(spec.path) as V;
        if (spec.isUsable?.(memoized) ?? true) return memoized;
      }

      const cached = this.readFile(spec);
      if (cached !== null && (spec.isUsable?.(cached) ?? true)) {
        this.memo.set(spec.path, cached);
        return cached;
      }
    }

    const fetched = await spec.fetch();
    atomicWriteJson(spec.path, fetched);
    this.memo.set(spec.path, fetched);
    return fetched;
  }

  /**
   * Bulk read over the same three tiers: memory and file are checked per
   * spec, then a single batched fetch covers every miss. fetchMissing
   * receives the indices (into specs) that fell through and must return one
   * value per index; each is written atomically and memoized exactly as in
   * get(). Results align with specs.
   */
  async getMany<V>(
    specs: readonly TieredCachePeekSpec<V>[],
    fetchMissing: (missingIndices: readonly number[]) => Promise<readonly V[]>,
  ): Promise<readonly V[]> {
    const results = new Array<V>(specs.length);
    const missing: number[] = [];
    specs.forEach((spec, index) => {
      if (this.memo.has(spec.path)) {
        const memoized = this.memo.get(spec.path) as V;
        if (spec.isUsable?.(memoized) ?? true) {
          results[index] = memoized;
          return;
        }
      }
      const cached = this.readFile(spec);
      if (cached !== null && (spec.isUsable?.(cached) ?? true)) {
        this.memo.set(spec.path, cached);
        results[index] = cached;
        return;
      }
      missing.push(index);
    });
    if (missing.length > 0) {
      const fetched = await fetchMissing(missing);
      if (fetched.length !== missing.length) {
        throw new Error(`bulk fetch returned ${fetched.length} values for ${missing.length} misses`);
      }
      missing.forEach((index, i) => {
        const value = fetched[i]!;
        atomicWriteJson(specs[index]!.path, value);
        this.memo.set(specs[index]!.path, value);
        results[index] = value;
      });
    }
    return results;
  }

  private readFile<V>(spec: TieredCachePeekSpec<V>): V | null {
    if (!existsSync(spec.path)) return null;
    const parsed = spec.schema.safeParse(JSON.parse(readFileSync(spec.path, 'utf8')));
    return parsed.success ? parsed.data : null;
  }
}
