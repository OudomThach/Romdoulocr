import { useState } from 'react';
import type { PageResult, VisualRegionCrop } from '@/types/api';
import { JsonTree } from '@/components/JsonTree';
import { PageImageWithBoxes } from '@/components/PageImageWithBoxes';
import { copyToClipboard, colorForRegion, fmtPct } from '@/lib/utils';
import { downloadPageHtml, downloadPageXlsx, downloadPageCsvs, countTablesInPage } from '@/lib/tableExport';

export interface SideBySidePreviewProps {
  page: PageResult;
  imageUrl?: string;
  bilingual?: boolean;
  tableCrops?: VisualRegionCrop[];
  figureCrops?: VisualRegionCrop[];
  imageCrops?: VisualRegionCrop[];
}

export function SideBySidePreview({
  page,
  imageUrl,
}: SideBySidePreviewProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const jsonText = JSON.stringify(page, null, 2);
  const tableCount = countTablesInPage(page);
  const baseName = `page-${page.page_number}`;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-ink-400">
          Page {page.page_number} · {page.regions.length} regions{tableCount > 0 && ` · ${tableCount} table(s)`}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => downloadPageHtml(page, baseName)}
          className="btn-secondary text-xs"
          title="Export this page as a standalone HTML file with rendered tables and headings"
        >
          Export .html
        </button>
        <button
          onClick={() => downloadPageXlsx(page, baseName)}
          className="btn-secondary text-xs"
          title="Export as Excel-openable spreadsheet (tables become real spreadsheet cells)"
        >
          Export .xls
        </button>
        {tableCount > 0 && (
          <button
            onClick={() => downloadPageCsvs(page, baseName)}
            className="btn-secondary text-xs"
            title={`Export ${tableCount} table(s) as CSV file(s)`}
          >
            Export .csv {tableCount > 1 ? `(${tableCount})` : ''}
          </button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card overflow-hidden p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-wide text-ink-400">
              Page JSON
            </div>
            <button
              onClick={async () => {
                await copyToClipboard(jsonText);
              }}
              className="rounded-md border border-ink-700 bg-ink-900/70 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800"
              title="Copy page JSON"
            >
              Copy
            </button>
          </div>
          <JsonTree data={page} maxHeight="700px" />
        </div>

        <div className="card overflow-hidden p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-wide text-ink-400">
              Page image · {page.width} × {page.height} px
            </div>
            <span className="text-[11px] text-ink-500">{page.regions.length} regions</span>
          </div>
          <PageImageWithBoxes
            page={page}
            imageUrl={imageUrl}
            showBoxes
            maxHeight="700px"
            hoverIdx={hoverIdx}
            onHoverRegion={setHoverIdx}
          />
          {page.regions.length > 0 && (
            <div className="mt-2 max-h-32 overflow-auto rounded-md border border-ink-800 bg-ink-900/40 p-2">
              <div className="flex flex-wrap gap-1.5">
                {page.regions.map((r, i) => {
                  const color = colorForRegion(r.region_type);
                  return (
                    <button
                      key={i}
                      onMouseEnter={() => setHoverIdx(i)}
                      onMouseLeave={() => setHoverIdx(null)}
                      className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
                        hoverIdx === i ? 'bg-ink-700 text-ink-50' : 'border-ink-700 bg-ink-900/60 text-ink-300 hover:bg-ink-800'
                      }`}
                      style={hoverIdx === i ? { borderColor: color } : {}}
                    >
                      <span style={{ color }}>{r.region_type}</span>{' '}
                      <span className="text-ink-500">#{i + 1} · {fmtPct(r.confidence)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
