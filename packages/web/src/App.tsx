import React, { useEffect, useState } from 'react';

interface EngineStatus {
  mode: string;
  running: boolean;
  tickCount: number;
  lastTickUtc: string | null;
}

export function App() {
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
    <main style={{ fontFamily: 'ui-monospace, monospace', padding: '2rem', maxWidth: 640 }}>
      <h1>
        θ thetad{' '}
        <span style={{ fontSize: '0.5em', color: connected ? 'green' : 'crimson' }}>
          {connected ? 'connected' : 'disconnected'}
        </span>
      </h1>
      <p style={{ color: '#666' }}>an open-source daemon that sells time</p>
      {status ? (
        <dl>
          <dt>mode</dt>
          <dd>{status.mode}</dd>
          <dt>engine</dt>
          <dd>{status.running ? 'running' : 'stopped'}</dd>
          <dt>ticks</dt>
          <dd>{status.tickCount}</dd>
          <dt>last tick</dt>
          <dd>{status.lastTickUtc ?? '—'}</dd>
        </dl>
      ) : (
        <p>waiting for daemon…</p>
      )}
    </main>
  );
}
