import type { LayoutRegion, PageResult, VisualRegionCrop } from '@/types/api';
import { colorForRegion, copyToClipboard, fmtPct } from '@/lib/utils';
import { parsePipeTable, type ParsedTable } from '@/lib/tableExport';

export interface PageDocumentPreviewProps {
  page: PageResult;
  bilingual?: boolean;
  tableCrops?: VisualRegionCrop[];
  figureCrops?: VisualRegionCrop[];
  imageCrops?: VisualRegionCrop[];
  maxHeight?: string;
}

export function PageDocumentPreview({
  page,
  bilingual,
  tableCrops,
  figureCrops,
  imageCrops,
  maxHeight = '600px',
}: PageDocumentPreviewProps) {
  return (
    <div
      className="overflow-auto rounded-lg border border-ink-800 bg-ink-950/40 p-4"
      style={{ maxHeight }}
    >
      <div className="mx-auto max-w-3xl space-y-3">
        {page.regions.map((region, i) => (
          <RegionBlock
            key={i}
            region={region}
            index={i}
            pageNumber={page.page_number}
            bilingual={bilingual}
            tableCrops={tableCrops}
            figureCrops={figureCrops}
            imageCrops={imageCrops}
          />
        ))}
        {page.regions.length === 0 && (
          <div className="py-8 text-center text-sm text-ink-500">No regions detected on this page.</div>
        )}
      </div>
    </div>
  );
}

function RegionBlock({
  region,
  index,
  pageNumber,
  bilingual,
  tableCrops,
  figureCrops,
  imageCrops,
}: {
  region: LayoutRegion;
  index: number;
  pageNumber: number;
  bilingual?: boolean;
  tableCrops?: VisualRegionCrop[];
  figureCrops?: VisualRegionCrop[];
  imageCrops?: VisualRegionCrop[];
}) {
  const text = (region.text ?? '').trim();
  const hasText = text.length > 0;
  const isTitle = region.region_type === 'title';
  const isHeading = region.region_type === 'heading';
  const isCaption = region.region_type === 'caption';
  const isTable = region.region_type === 'table';
  const isFigure = region.region_type === 'figure';
  const isImage = region.region_type === 'image';
  const isVisual = isImage || isFigure;
  const color = colorForRegion(region.region_type);

  const parsedTable: ParsedTable | null = isTable ? parsePipeTable(text) : null;

  const matchingCrop = isVisual
    ? findMatchingCrop(region, pageNumber, isFigure ? figureCrops : imageCrops)
    : isTable
      ? findMatchingCrop(region, pageNumber, tableCrops)
      : null;

  return (
    <div
      className="rounded-lg border border-ink-800/70 bg-ink-900/40 p-3 transition-colors hover:border-ink-700"
      data-region-index={index}
      data-region-type={region.region_type}
    >
      <div className="mb-2 flex items-center justify-between text-[11px]">
        <span className="badge" style={{ borderColor: `${color}66`, color }}>
          {region.region_type} · #{index + 1}
        </span>
        <div className="flex items-center gap-2 text-ink-500">
          <span>{fmtPct(region.confidence)}</span>
          <span>· {region.lines.length} line(s)</span>
          {hasText && (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                await copyToClipboard(text);
              }}
              className="rounded border border-ink-700 bg-ink-900/60 px-1.5 py-0.5 text-[10px] text-ink-300 hover:bg-ink-800 hover:text-ink-50"
              title="Copy this region's text"
            >
              Copy
            </button>
          )}
        </div>
      </div>

      {(isImage || isFigure) && matchingCrop && (
        <img
          src={`data:image/png;base64,${matchingCrop.crop_base64}`}
          alt={`${region.region_type} preview`}
          className="mb-2 max-h-48 w-full rounded-md border border-ink-800 bg-white object-contain"
        />
      )}
      {(isImage || isFigure) && !matchingCrop && (
        <div className="mb-2 rounded-md border border-ink-800 bg-ink-950/50 px-3 py-6 text-center text-xs text-ink-500">
          {region.region_type} region — no crop returned
        </div>
      )}
      {isTable && matchingCrop && (
        <img
          src={`data:image/png;base64,${matchingCrop.crop_base64}`}
          alt="table crop"
          className="mb-2 max-h-32 w-full rounded-md border border-ink-800 bg-white object-contain"
        />
      )}

      {parsedTable ? (
        <RenderedTable table={parsedTable} bilingual={bilingual} region={region} />
      ) : bilingual && hasText && !isVisual ? (
        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded-md bg-ink-950/40 p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-500">Source</div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-100">
              {region.khmer_text ?? region.text}
            </p>
          </div>
          <div className="rounded-md bg-ink-950/40 p-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-500">Translation</div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-200">
              {region.english_text ?? <span className="italic text-ink-500">(no translation)</span>}
            </p>
          </div>
        </div>
      ) : hasText ? (
        isTitle ? (
          <h1 className="text-lg font-bold text-ink-50">{text}</h1>
        ) : isHeading ? (
          <h2 className="text-base font-semibold text-ink-50">{text}</h2>
        ) : isCaption ? (
          <p className="text-sm italic text-ink-300">{text}</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-100">{text}</p>
        )
      ) : !isVisual ? (
        <p className="text-sm italic text-ink-500">(no text)</p>
      ) : null}
    </div>
  );
}

function RenderedTable({ table, bilingual, region }: { table: ParsedTable; bilingual?: boolean; region: LayoutRegion }) {
  const hasTranslation = bilingual && !!region.english_text;
  return (
    <div className="overflow-auto rounded-md border border-ink-800">
      <table className="min-w-full border-collapse text-xs">
        <thead>
          <tr>
            {table.headers.map((h, i) => (
              <th
                key={i}
                className="border-b border-ink-700 bg-ink-800/80 px-2.5 py-1.5 text-left font-semibold text-ink-100"
              >
                {h || <span className="text-ink-600">—</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} className="border-b border-ink-800/60 last:border-b-0">
              {row.map((cell, ci) => (
                <td key={ci} className="px-2.5 py-1.5 align-top text-ink-200">
                  {cell || <span className="text-ink-600">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hasTranslation && (
        <div className="border-t border-ink-800 bg-ink-950/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Translation</div>
          <p className="mt-0.5 text-xs text-ink-300">{region.english_text}</p>
        </div>
      )}
    </div>
  );
}

function findMatchingCrop(
  region: LayoutRegion,
  pageNumber: number,
  crops: VisualRegionCrop[] | undefined,
): VisualRegionCrop | null {
  if (!crops || crops.length === 0) return null;
  let best: { crop: VisualRegionCrop; score: number } | null = null;
  for (const crop of crops) {
    if (crop.page_number !== pageNumber) continue;
    const iou = bboxIou(region.bbox.points, crop.bbox.points);
    if (iou > 0.2 && (!best || iou > best.score)) best = { crop, score: iou };
  }
  return best?.crop ?? null;
}

function bboxIou(a: [number, number][], b: [number, number][]): number {
  const ax = Math.min(...a.map((p) => p[0]));
  const ay = Math.min(...a.map((p) => p[1]));
  const ax2 = Math.max(...a.map((p) => p[0]));
  const ay2 = Math.max(...a.map((p) => p[1]));
  const bx = Math.min(...b.map((p) => p[0]));
  const by = Math.min(...b.map((p) => p[1]));
  const bx2 = Math.max(...b.map((p) => p[0]));
  const by2 = Math.max(...b.map((p) => p[1]));
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay, by));
  const inter = ix * iy;
  if (inter === 0) return 0;
  const areaA = (ax2 - ax) * (ay2 - ay);
  const areaB = (bx2 - bx) * (by2 - by);
  const union = areaA + areaB - inter;
  return inter / union;
}
