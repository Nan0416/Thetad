import { useMemo, useState } from 'react';
import { SkewHeatmap, type SkewRights } from '../components/skew-heatmap';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { fetchSkew, fmtUsd, type SkewResponse } from '../lib/api';
import { isoDaysAgo } from '../lib/dates';
import { useTheme } from '../theme';

const RIGHTS_CHOICES: readonly { readonly value: SkewRights; readonly label: string }[] = [
  { value: 'both', label: 'both' },
  { value: 'C', label: 'calls' },
  { value: 'P', label: 'puts' },
];

function fmtIvCell(closeCents: number | null, iv: number | null): string {
  if (closeCents === null) return '—';
  return iv === null
    ? `${fmtUsd(closeCents)} · n/a`
    : `${fmtUsd(closeCents)} · ${(iv * 100).toFixed(1)}%`;
}

/** The heatmap's accessible twin: every plotted value, one row per strike × expiration. */
function SkewTable({ data }: { readonly data: SkewResponse }) {
  const rows = useMemo(() => {
    const out: {
      readonly key: string;
      readonly expirationIso: string;
      readonly dte: number;
      readonly strikeCents: number;
      readonly cell: readonly (number | null)[];
    }[] = [];
    for (let s = data.strikesCents.length - 1; s >= 0; s--) {
      data.expirations.forEach((expiration, e) => {
        const cell = data.grid[s]![e];
        if (!cell) return;
        out.push({
          key: `${expiration.expirationIso}-${data.strikesCents[s]}`,
          expirationIso: expiration.expirationIso,
          dte: expiration.dte,
          strikeCents: data.strikesCents[s]!,
          cell,
        });
      });
    }
    return out;
  }, [data]);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Strike</TableHead>
          <TableHead>Expiration</TableHead>
          <TableHead>DTE</TableHead>
          <TableHead>Call close · IV</TableHead>
          <TableHead>Put close · IV</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell>{fmtUsd(row.strikeCents)}</TableCell>
            <TableCell>{row.expirationIso}</TableCell>
            <TableCell>{row.dte}</TableCell>
            <TableCell>{fmtIvCell(row.cell[0]!, row.cell[1]!)}</TableCell>
            <TableCell>{fmtIvCell(row.cell[2]!, row.cell[3]!)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function SkewPage() {
  const theme = useTheme();
  const todayIso = useMemo(
    () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    [],
  );

  const [symbolInput, setSymbolInput] = useState('SPY');
  const [dateInput, setDateInput] = useState(isoDaysAgo(120, todayIso));
  const [moneynessInput, setMoneynessInput] = useState('15');
  const [maxDteInput, setMaxDteInput] = useState('120');
  const [includeDailies, setIncludeDailies] = useState(false);
  const [allStrikes, setAllStrikes] = useState(false);
  const [rights, setRights] = useState<SkewRights>('both');
  const [showTable, setShowTable] = useState(false);
  const [data, setData] = useState<SkewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    const sym = symbolInput.trim().toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(sym)) {
      setError('enter a stock symbol (1–6 letters)');
      return;
    }
    if (!dateInput || dateInput >= todayIso) {
      setError('pick a past date — only completed contract histories are researchable');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const moneynessPct = Number(moneynessInput);
      const maxDte = Number(maxDteInput);
      const response = await fetchSkew(sym, dateInput, {
        ...(moneynessPct > 0 && { moneynessPct }),
        ...(maxDte > 0 && { maxDte }),
        includeDailies,
        allStrikes,
      });
      setData(response);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      {data ? (
        <>
          <p className="text-xs text-muted">
            {data.symbol} on {data.dateIso} · spot {fmtUsd(data.spotCents)} · rate{' '}
            {(data.rate * 100).toFixed(2)}% · {data.expirations.length} expirations ×{' '}
            {data.strikesCents.length} strikes
            {data.droppedExpirations > 0 &&
              ` · ${data.droppedExpirations} expirations thinned to fit the axis`}
            {data.untradedExpirations > 0 &&
              ` · ${data.untradedExpirations} with no trades on the date (hidden)`}
          </p>
          {showTable ? (
            <SkewTable data={data} />
          ) : (
            <SkewHeatmap data={data} rights={rights} theme={theme} />
          )}
        </>
      ) : (
        <div className="chart-wrap flex h-[440px] items-center justify-center p-8 text-center text-muted">
          <p className="max-w-lg">
            Enter an underlying and a past date, then Confirm to draw that day&apos;s implied-vol
            surface: expirations across, strikes up, IV as color, each cell split ▌ call / ▐ put.
            Equity index skew shows as darker puts below spot; the smile as dark wings either side;
            the term structure as columns lightening (or darkening) to the right. Contracts still
            open today are included — a past session&apos;s close is final — but far-dated weeklies
            only list a few weeks ahead, so distant columns are monthlies and quarterlies.
          </p>
        </div>
      )}

      {error && <p className="text-danger">{error}</p>}
      {busy && (
        <p className="text-muted">
          loading… (a cold chain fetches a couple thousand contracts in batches; the first run for a
          symbol/date can take ~30s)
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-hairline bg-surface p-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="skew-symbol" className="text-xs tracking-wider text-muted uppercase">
            Underlying
          </label>
          <Input
            id="skew-symbol"
            className="w-24"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="skew-date" className="text-xs tracking-wider text-muted uppercase">
            As-of date
          </label>
          <Input
            id="skew-date"
            type="date"
            min="2024-02-01"
            max={todayIso}
            value={dateInput}
            onChange={(e) => setDateInput(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="skew-moneyness" className="text-xs tracking-wider text-muted uppercase">
            Moneyness ±%
          </label>
          <Input
            id="skew-moneyness"
            className="w-20"
            type="number"
            min={2}
            max={50}
            value={moneynessInput}
            onChange={(e) => setMoneynessInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="skew-dte" className="text-xs tracking-wider text-muted uppercase">
            Max DTE
          </label>
          <Input
            id="skew-dte"
            className="w-20"
            type="number"
            min={1}
            max={730}
            value={maxDteInput}
            onChange={(e) => setMaxDteInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeDailies}
            onChange={(e) => setIncludeDailies(e.target.checked)}
          />
          daily expirations
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allStrikes}
            onChange={(e) => setAllStrikes(e.target.checked)}
          />
          all strikes
        </label>
        <Button onClick={confirm} disabled={busy}>
          Confirm
        </Button>
        {data && (
          <>
            <span className="mx-1 h-9 border-l border-hairline" />
            <div className="flex items-end gap-1">
              {RIGHTS_CHOICES.map((choice) => (
                <Button
                  key={choice.value}
                  size="sm"
                  variant={rights === choice.value ? 'default' : 'outline'}
                  onClick={() => setRights(choice.value)}
                >
                  {choice.label}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              variant={showTable ? 'default' : 'outline'}
              onClick={() => setShowTable((v) => !v)}
            >
              table
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
