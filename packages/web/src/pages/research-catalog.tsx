import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { RESEARCH_CHARTS } from '../research-charts';

/** Landing page for the research section: one row per chart, click to open. */
export function ResearchCatalog() {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-bold">Research charts</h2>
        <p className="text-sm text-muted">
          Tools for understanding options dynamics from cached market data. Pick one to open it.
        </p>
      </div>
      <div className="rounded-md border border-hairline bg-surface">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-64">Chart</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {RESEARCH_CHARTS.map((chart) => (
              <TableRow
                key={chart.slug}
                className="cursor-pointer"
                onClick={() => {
                  window.location.hash = `#/research/${chart.slug}`;
                }}
              >
                <TableCell className="align-top">
                  <a
                    href={`#/research/${chart.slug}`}
                    className="font-medium text-accent no-underline hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {chart.title}
                  </a>
                  <div className="text-xs text-muted">research/{chart.slug}</div>
                </TableCell>
                <TableCell className="py-2.5 align-top text-ink-2">{chart.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
