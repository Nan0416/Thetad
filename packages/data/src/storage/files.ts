import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';

/**
 * Crash-safe JSON state writes: write tmp + fsync + rename. A crash at any
 * instant leaves either the complete old file or the complete new one.
 * Synchronous on purpose — a sync sequence cannot be interleaved by the
 * event loop, so no app-level write lock is needed.
 */
export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function readJson<T>(path: string, schema: ZodType<T>): T | null {
  if (!existsSync(path)) return null;
  return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Append-only JSONL journal. One JSON object per line. */
export function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export function* readJsonl(path: string): Generator<unknown> {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim()) yield JSON.parse(line);
  }
}
