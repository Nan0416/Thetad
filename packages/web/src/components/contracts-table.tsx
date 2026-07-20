import { fmtUsd, type ExpirationFrequency, type OptionRight } from '../lib/api';
import { cn } from '../lib/cn';
import { Badge } from './ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

export interface ContractRow {
  readonly occSymbol: string;
  readonly right: OptionRight;
  readonly frequency: ExpirationFrequency | null;
  readonly expirationIso: string;
  readonly strikeCents: number;
}

/** Rows are expired contracts only — the page filters the rest out. */
export interface ContractsTableProps {
  readonly rows: readonly ContractRow[];
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (row: ContractRow) => void;
}

const FREQUENCY_STYLES: Record<ExpirationFrequency, string> = {
  daily: 'text-muted',
  weekly: 'text-ink-2',
  monthly: 'text-accent',
  quarterly: 'text-good',
};

export function ContractsTable({ rows, selected, onToggle }: ContractsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>OCC</TableHead>
          <TableHead>Right</TableHead>
          <TableHead>Frequency</TableHead>
          <TableHead>Expiration</TableHead>
          <TableHead className="text-right">Strike</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const isSelected = selected.has(row.occSymbol);
          return (
            <TableRow
              key={row.occSymbol}
              onClick={() => onToggle(row)}
              aria-selected={isSelected}
              className={cn('cursor-pointer', isSelected && 'bg-accent/10 hover:bg-accent/15')}
            >
              <TableCell className="font-medium">{row.occSymbol}</TableCell>
              <TableCell>
                <Badge variant="outline">{row.right === 'P' ? 'put' : 'call'}</Badge>
              </TableCell>
              <TableCell className={row.frequency ? FREQUENCY_STYLES[row.frequency] : 'text-muted'}>
                {row.frequency ?? '—'}
              </TableCell>
              <TableCell>{row.expirationIso}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtUsd(row.strikeCents)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
