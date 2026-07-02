import type { DocumentResult, PageResult, LayoutRegion } from '@/types/api';
import { parsePipeTable, type ParsedTable } from '@/lib/tableExport';

export interface WordPreviewProps {
  doc: DocumentResult;
  maxHeight?: string;
}

export function WordPreview({ doc, maxHeight = '500px' }: WordPreviewProps) {
  return (
    <div className="overflow-auto rounded-lg border border-ink-700 bg-ink-200 p-4" style={{ maxHeight }}>
      <div className="mx-auto max-w-[8.5in] bg-white px-[1in] py-[1in] shadow-lg" style={{ fontFamily: "'Segoe UI', 'Noto Sans Khmer', sans-serif", lineHeight: 1.6 }}>
        {doc.pages.map((page, pi) => (
          <div key={pi} className={pi > 0 ? 'mt-8 border-t border-ink-200 pt-8' : ''}>
            {pi > 0 && (
              <div className="mb-4 text-center text-[10px] uppercase tracking-widest text-ink-400">
                — Page Break —
              </div>
            )}
            <PageContent page={page} />
          </div>
        ))}
        {doc.pages.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-400">No content</div>
        )}
      </div>
    </div>
  );
}

function PageContent({ page }: { page: PageResult }) {
  return (
    <div className="space-y-3">
      {page.regions.map((region, i) => (
        <RegionElement key={i} region={region} />
      ))}
      {page.regions.length === 0 && (
        <div className="py-4 text-center text-sm text-ink-400">No regions on this page</div>
      )}
    </div>
  );
}

function RegionElement({ region }: { region: LayoutRegion }) {
  const text = (region.text ?? '').trim();
  if (!text) return null;

  switch (region.region_type) {
    case 'title':
      return <h1 className="text-2xl font-bold text-ink-900 border-b border-ink-200 pb-1">{text}</h1>;
    case 'heading':
      return <h2 className="text-xl font-semibold text-ink-800 mt-4">{text}</h2>;
    case 'caption':
      return <p className="text-center text-sm italic text-ink-600">{text}</p>;
    case 'table': {
      const parsed = parsePipeTable(text);
      if (parsed) return <WordTable table={parsed} />;
      return <pre className="text-xs text-ink-700 bg-ink-50 p-3 rounded border border-ink-200 overflow-auto">{text}</pre>;
    }
    default:
      return <p className="text-sm text-ink-800 whitespace-pre-wrap">{text}</p>;
  }
}

function WordTable({ table }: { table: ParsedTable }) {
  return (
    <div className="my-3 overflow-auto">
      <table className="w-full border-collapse text-sm" style={{ fontFamily: "'Segoe UI', 'Noto Sans Khmer', sans-serif" }}>
        <thead>
          <tr>
            {table.headers.map((h, i) => (
              <th key={i} className="border border-ink-400 bg-ink-100 px-3 py-1.5 text-left font-semibold text-ink-900">
                {h || <span className="text-ink-400">—</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 1 ? 'bg-ink-50' : ''}>
              {table.headers.map((_, ci) => {
                const cell = row[ci] ?? '';
                return (
                  <td key={ci} className="border border-ink-300 px-3 py-1.5 text-ink-800">
                    {cell || <span className="text-ink-400">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
