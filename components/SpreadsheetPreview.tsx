import { useState, useMemo } from 'react';
import type { SheetData } from '@/lib/documentExport';

export interface SpreadsheetPreviewProps {
  sheets: SheetData[];
  maxHeight?: string;
}

const COL_LETTERS = (n: number): string => {
  let s = '';
  n = n + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

export function SpreadsheetPreview({ sheets, maxHeight = '500px' }: SpreadsheetPreviewProps) {
  const [activeSheet, setActiveSheet] = useState(0);
  const sheet = sheets[activeSheet] ?? sheets[0];

  const maxCols = useMemo(() => {
    if (!sheet) return 0;
    return Math.max(sheet.headers.length, ...sheet.rows.map((r) => r.length));
  }, [sheet]);

  if (!sheet) {
    return (
      <div className="grid place-items-center rounded-lg border border-ink-800 bg-ink-950 p-8 text-sm text-ink-500" style={{ maxHeight }}>
        No data to preview
      </div>
    );
  }

  const colLetters = Array.from({ length: maxCols }, (_, i) => COL_LETTERS(i));

  return (
    <div className="grid gap-2" style={{ maxHeight }}>
      <div className="overflow-auto rounded-lg border border-ink-700 bg-white" style={{ maxHeight: `calc(${maxHeight} - 48px)` }}>
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 border border-ink-300 bg-ink-100 px-2 py-1 text-center text-[10px] text-ink-500" style={{ minWidth: 32 }}>
                #
              </th>
              {colLetters.map((letter) => (
                <th
                  key={letter}
                  className="sticky top-0 z-10 border border-ink-300 bg-ink-100 px-2 py-1 text-center text-[10px] font-semibold text-ink-500"
                  style={{ minWidth: 80 }}
                >
                  {letter}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="bg-ink-50">
              <td className="sticky left-0 z-10 border border-ink-300 bg-ink-100 px-2 py-1 text-center text-[10px] font-semibold text-ink-500">1</td>
              {sheet.headers.map((h, ci) => (
                <td
                  key={ci}
                  className="border border-ink-300 px-2 py-1 font-semibold text-ink-900"
                  style={{ fontFamily: "'Segoe UI', 'Noto Sans Khmer', sans-serif" }}
                >
                  {h || <span className="text-ink-400">—</span>}
                </td>
              ))}
              {maxCols > sheet.headers.length &&
                Array.from({ length: maxCols - sheet.headers.length }, (_, i) => (
                  <td key={`pad-h-${i}`} className="border border-ink-300 bg-ink-50" />
                ))}
            </tr>
            {sheet.rows.map((row, ri) => (
              <tr key={ri} className="even:bg-ink-50/50">
                <td className="sticky left-0 z-10 border border-ink-300 bg-ink-100 px-2 py-1 text-center text-[10px] text-ink-500">
                  {ri + 2}
                </td>
                {Array.from({ length: maxCols }, (_, ci) => {
                  const cell = row[ci] ?? '';
                  return (
                    <td
                      key={ci}
                      className={`border border-ink-300 px-2 py-1 ${cell ? 'text-ink-800' : 'text-ink-400'}`}
                      style={{ fontFamily: "'Segoe UI', 'Noto Sans Khmer', sans-serif" }}
                    >
                      {cell || <span>—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sheets.length > 1 && (
        <div className="flex flex-wrap gap-1 border-t border-ink-700 pt-2">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActiveSheet(i)}
              className={`rounded-md px-3 py-1 text-xs transition-colors ${
                i === activeSheet
                  ? 'bg-accent text-ink-50'
                  : 'border border-ink-700 bg-ink-900/60 text-ink-300 hover:bg-ink-800'
              }`}
            >
              {s.name}
              <span className="ml-1.5 text-[10px] opacity-60">
                {s.rows.length} row{s.rows.length !== 1 ? 's' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
