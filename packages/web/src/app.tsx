import { useEffect, useState } from 'react';
import { cn } from './lib/cn';
import { ResearchCatalog } from './pages/research-catalog';
import { StatusPage } from './pages/status-page';
import { findResearchChart } from './research-charts';

const NAV = [
  { hash: '#/status', label: 'status' },
  { hash: '#/research', label: 'research' },
] as const;

const PLANNED = ['screener', 'execution', 'review'] as const;

/** The hash split into a leading section and the rest, e.g. research/daily-payoff. */
function useRoute(): { section: string; sub: string } {
  const parse = () => {
    // Bare URL (no hash) defaults to the status section, so its nav item highlights.
    const path = window.location.hash.replace(/^#\/?/, '') || 'status';
    const slash = path.indexOf('/');
    return slash === -1
      ? { section: path, sub: '' }
      : { section: path.slice(0, slash), sub: path.slice(slash + 1) };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function ResearchSection({ sub }: { sub: string }) {
  if (!sub) return <ResearchCatalog />;
  const chart = findResearchChart(sub);
  if (!chart) {
    return (
      <section className="space-y-2">
        <p className="text-danger">Unknown research chart: {sub}</p>
        <a href="#/research" className="text-accent no-underline hover:underline">
          ← back to research
        </a>
      </section>
    );
  }
  const Chart = chart.Component;
  return (
    <div className="space-y-3">
      <nav className="text-xs text-muted">
        <a href="#/research" className="text-accent no-underline hover:underline">
          research
        </a>
        {' / '}
        {chart.title}
      </nav>
      <Chart />
    </div>
  );
}

export function App() {
  const { section, sub } = useRoute();
  return (
    <div className="mx-auto max-w-5xl px-8 pt-6 pb-12">
      <header className="mb-6 flex items-baseline gap-6">
        <h1 className="text-lg font-bold">θ thetad</h1>
        <nav className="flex gap-4">
          {NAV.map(({ hash, label }) => (
            <a
              key={hash}
              href={hash}
              className={cn(
                'pb-0.5 text-ink-2 no-underline hover:text-ink',
                `#/${section}` === hash && 'border-b-2 border-accent text-ink',
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
      {section === 'research' ? <ResearchSection sub={sub} /> : <StatusPage />}
    </div>
  );
}
