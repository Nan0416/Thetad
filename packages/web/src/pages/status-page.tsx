import { useEffect, useState } from 'react';

interface EngineStatus {
  mode: string;
  running: boolean;
  tickCount: number;
  lastTickUtc: string | null;
}

export function StatusPage() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('hello', (e) => {
      setConnected(true);
      setStatus(JSON.parse(e.data));
    });
    events.addEventListener('tick', () => {
      fetch('/api/status')
        .then((r) => r.json())
        .then(setStatus);
    });
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, []);

  return (
    <section>
      <p className={`text-xs ${connected ? 'text-good' : 'text-danger'}`}>
        {connected ? 'connected' : 'disconnected'}
      </p>
      <p className="text-muted">an open-source daemon that sells time</p>
      {status ? (
        <dl className="mt-4 grid w-fit grid-cols-[auto_auto] gap-x-8 gap-y-1">
          <dt className="text-ink-2">mode</dt>
          <dd>{status.mode}</dd>
          <dt className="text-ink-2">engine</dt>
          <dd>{status.running ? 'running' : 'stopped'}</dd>
          <dt className="text-ink-2">ticks</dt>
          <dd>{status.tickCount}</dd>
          <dt className="text-ink-2">last tick</dt>
          <dd>{status.lastTickUtc ?? '—'}</dd>
        </dl>
      ) : (
        <p>waiting for daemon…</p>
      )}
    </section>
  );
}
