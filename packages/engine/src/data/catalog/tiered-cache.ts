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

/**
 * The three-tier read path every dataset in the DataCatalog shares:
 *   1. memory  — return the memoized value
 *   2. file    — zod-validate the cache file; memoize and return if usable
 *   3. provider — fetch, write the file atomically, memoize, return
 * A file that fails validation or the isUsable rule falls through to the
 * provider. forceRefresh skips tiers 1-2.
 */
export class TieredCache {
  private readonly memo = new Map<string, unknown>();

  async get<V>(spec: TieredCacheSpec<V>, forceRefresh = false): Promise<V> {
    if (!forceRefresh) {
      if (this.memo.has(spec.path)) return this.memo.get(spec.path) as V;

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

  private readFile<V>(spec: TieredCacheSpec<V>): V | null {
    if (!existsSync(spec.path)) return null;
    const parsed = spec.schema.safeParse(JSON.parse(readFileSync(spec.path, 'utf8')));
    return parsed.success ? parsed.data : null;
  }
}
