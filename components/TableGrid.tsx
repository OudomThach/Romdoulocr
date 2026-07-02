// Shared HTML table renderer for both the `/parse-table` result and the
// in-browser preview of the table regions detected inside a normal document
// parse. Cells are addressed by row/col (0-indexed) and rendered into a fixed
// grid with hover highlights and confidence-aware styling.

import { useMemo, useState } from 'react';
import type { TableCell } from '@/types/api';
import { fmtPct } from '@/lib/utils';

export interface TableGridProps {
  cells: TableCell[];
  rows: number;
  cols: number;
  compact?: boolean;
}

export function TableGrid({ cells, rows, cols, compact = false }: TableGridProps) {
  const grid = useMemo(() => {
    const map = new Map<string, TableCell>();
    for (const cell of cells) map.set(`${cell.row}:${cell.col}`, cell);
    return map;
  }, [cells]);

  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const pad = compact ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm';
  const thPad = compact ? 'px-2 py-1 text-[10px]' : 'px-3 py-1.5 text-xs';
  const avg = cells.length > 0
    ? cells.reduce((sum, cell) => sum + (cell.confidence ?? 0), 0) / cells.length
    : 0;

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>
          {rows} x {cols} - {cells.length} cells
        </span>
        {cells.length > 0 && (
          <span title="Average cell confidence">
            avg conf <span className="font-mono text-slate-700">{fmtPct(avg)}</span>
          </span>
        )}
      </div>
      <div className="overflow-auto rounded-lg border border-slate-300 bg-white">
        <table className="min-w-full border-collapse">
          <tbody>
            {Array.from({ length: rows }, (_, rowIndex) => (
              <tr key={rowIndex} className="border-b border-slate-300 odd:bg-white even:bg-slate-50 last:border-b-0">
                {Array.from({ length: cols }, (_, colIndex) => {
                  const cell = grid.get(`${rowIndex}:${colIndex}`);
                  const key = `${rowIndex}:${colIndex}`;
                  const text = cell?.text ?? '';
                  const conf = cell?.confidence ?? 0;
                  const active = hoverKey === key;
                  const lowConf = conf > 0 && conf < 0.6;

                  return (
                    <td
                      key={key}
                      onMouseEnter={() => setHoverKey(key)}
                      onMouseLeave={() => setHoverKey(null)}
                      title={cell ? `${fmtPct(conf)} confidence` : 'empty cell'}
                      className={`border-r border-slate-300 align-top text-slate-950 last:border-r-0 transition-colors ${pad} ${
                        active ? 'bg-slate-100' : lowConf ? 'bg-rose-50 text-rose-900' : ''
                      }`}
                    >
                      {text || <span className="italic text-slate-400">empty</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={thPad + ' text-slate-500'}>
        Tip: <span className="text-rose-600">pink-tinted cells</span> have low confidence
        (&lt; 60%). Hover any cell to see its score.
      </div>
    </div>
  );
}
