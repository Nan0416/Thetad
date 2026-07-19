import { appendJsonl } from '@thetad/data';
import { join } from 'node:path';
import type { Config } from './config';

export interface EngineStatus {
  mode: 'paper' | 'live';
  running: boolean;
  tickCount: number;
  lastTickUtc: string | null;
}

type Listener = (event: { type: string; data: unknown }) => void;

/**
 * The reconcile loop. Level-triggered: every tick assembles a snapshot,
 * calls evaluate(), passes intents through the risk layer, and reconciles
 * order state. v0 ticks and journals only — wiring to MarketData/Broker
 * lands with the position manager.
 */
export class Engine {
  private timer: NodeJS.Timeout | null = null;
  private tickCount = 0;
  private lastTickUtc: string | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly config: Config,
    private readonly tickIntervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const asof = new Date().toISOString();
    this.tickCount += 1;
    this.lastTickUtc = asof;
    // TODO(engine): snapshot -> evaluate -> risk layer -> order manager.
    const record = { type: 'tick', asof, n: this.tickCount, mode: this.config.mode };
    appendJsonl(join(this.config.journalDir, `${asof.slice(0, 10)}.jsonl`), record);
    this.emit({ type: 'tick', data: record });
  }

  status(): EngineStatus {
    return {
      mode: this.config.mode,
      running: this.timer !== null,
      tickCount: this.tickCount,
      lastTickUtc: this.lastTickUtc,
    };
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: { type: string; data: unknown }): void {
    for (const listener of this.listeners) listener(event);
  }
}
