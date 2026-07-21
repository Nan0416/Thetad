import { useEffect, useState } from 'react';
import { ResearchPage } from './pages/research-page';
import { StatusPage } from './pages/status-page';
import { VolatilityPage } from './pages/volatility-page';
import { cn } from './lib/cn';

const ROUTES = [
  { hash: '#/status', label: 'status' },
  { hash: '#/research', label: 'payoff' },
  { hash: '#/volatility', label: 'volatility' },
] as const;

const PLANNED = ['screener', 'execution', 'review'] as const;

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || '#/status');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/status');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function App() {
  const route = useHashRoute();
  return (
    <div className="mx-auto max-w-5xl px-8 pt-6 pb-12">
      <header className="mb-6 flex items-baseline gap-6">
        <h1 className="text-lg font-bold">θ thetad</h1>
        <nav className="flex gap-4">
          {ROUTES.map(({ hash, label }) => (
            <a
              key={hash}
              href={hash}
              className={cn(
                'pb-0.5 text-ink-2 no-underline hover:text-ink',
                route.startsWith(hash) && 'border-b-2 border-accent text-ink',
              )}
            >
              {label}
            </a>
          ))}
          {PLANNED.map((label) => (
            <span key={label} className="cursor-default text-muted" title="coming later">
              {label}
            </span>
          ))}
        </nav>
      </header>
      {route.startsWith('#/research') ? (
        <ResearchPage />
      ) : route.startsWith('#/volatility') ? (
        <VolatilityPage />
      ) : (
        <StatusPage />
      )}
    </div>
  );
}
