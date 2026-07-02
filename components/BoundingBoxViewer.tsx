import { useMemo, useState } from 'react';
import type { LayoutRegion, PageResult, VisualRegionCrop } from '@/types/api';
import { bboxToPct, colorForRegion, copyToClipboard, fmtPct } from '@/lib/utils';
import { MarkdownViewer } from '@/components/MarkdownViewer';
import { CopyMenu } from '@/components/CopyMenu';
import { JsonTree } from '@/components/JsonTree';
import { SideBySidePreview } from '@/components/SideBySidePreview';
import { resultToMarkdown } from '@/lib/exporters';

export interface BoundingBoxViewerProps {
  page: PageResult;
  /**
   * When provided, renders this image as the background and overlays the regions.
   * For PDFs without a pre-rendered image, only the text view is shown.
   */
  imageUrl?: string;
  /** Whether to render the overlay layer. */
  showBoxes?: boolean;
  /** Optional document-level full text — enables the "Full text" tab. */
  fullText?: string;
  /** Optional Markdown source — enables the "Markdown" + "MD source" tabs. */
  markdownSource?: string;
  /** Optional JSON source — enables the "JSON" tab. */
  jsonSource?: string;
  /**
   * Optional doc-level visual-region crops. The OCR pipeline returns these in
   * `DocumentResult.table_crops` / `figure_crops` / `image_crops` and we use
   * them to render an actual image preview for image/figure/table regions
   * (matched by bbox overlap on the same page).
   */
  tableCrops?: VisualRegionCrop[];
  figureCrops?: VisualRegionCrop[];
  imageCrops?: VisualRegionCrop[];
  /** When true, region cards show source + translation side-by-side. */
  bilingual?: boolean;
}

type RightView = 'regions' | 'fullText' | 'markdown' | 'json' | 'preview';

/** Renders a single page: background image (if any) + bbox overlays + region list. */
export function BoundingBoxViewer({
  page,
  imageUrl,
  showBoxes = true,
  fullText,
  markdownSource,
  jsonSource,
  tableCrops,
  figureCrops,
  imageCrops,
  bilingual,
}: BoundingBoxViewerProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [view, setView] = useState<RightView>('regions');

  const hasFullText = !!fullText && fullText.trim().length > 0;
  const hasMarkdown = !!markdownSource && markdownSource.trim().length > 0;
  const hasJson = !!jsonSource && jsonSource.trim().length > 0;

  // Per-page joined text — used by Copy buttons across all views.
  const perPageText = useMemo(
    () =>
      `--- Page ${page.page_number} ---\n` +
      page.regions
        .map((rg) => rg.text?.trim() ?? '')
        .filter((t) => t.length > 0)
        .join('\n\n'),
    [page],
  );

  // Per-page regions as plain text (type + text per region, with line breaks).
  const perPageRegions = useMemo(
    () =>
      page.regions
        .map((rg, i) => {
          const t = rg.text?.trim() ?? '';
          if (!t) return `[${rg.region_type} #${i + 1}] (no text)`;
          return `[${rg.region_type} #${i + 1}] ${t}`;
        })
        .join('\n\n'),
    [page.regions],
  );

  const viewLabel =
    view === 'fullText'
      ? 'Full text'
      : view === 'markdown'
        ? 'Markdown'
        : view === 'json'
            ? 'JSON'
            : view === 'preview'
              ? 'Side-by-side preview'
              : 'Regions';

  if (view === 'preview') {
    return (
      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs uppercase tracking-wide text-ink-400">{viewLabel}</div>
          <div
            role="tablist"
            aria-label="Right column view"
            className="inline-flex flex-wrap overflow-hidden rounded-md border border-ink-700 bg-ink-900/50 text-[11px]"
          >
            <TabBtn label="Regions" view="regions" current={view} setView={setView} />
            {hasFullText && (
              <TabBtn label="Full text" view="fullText" current={view} setView={setView} />
            )}
            {hasMarkdown && (
              <TabBtn label="Markdown" view="markdown" current={view} setView={setView} />
            )}
            {hasJson && <TabBtn label="JSON" view="json" current={view} setView={setView} />}
            <TabBtn label="Preview" view="preview" current={view} setView={setView} />
          </div>
        </div>
        <SideBySidePreview
          page={page}
          imageUrl={imageUrl}
          bilingual={bilingual}
          tableCrops={tableCrops}
          figureCrops={figureCrops}
          imageCrops={imageCrops}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <div className="card overflow-hidden p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-ink-400">
          <span>
            Page {page.page_number} · {page.width} × {page.height} px
          </span>
          <span>{page.regions.length} regions</span>
        </div>
        <div
          className="relative mx-auto overflow-hidden rounded-lg border border-ink-800 bg-ink-950"
          style={{
            aspectRatio: `${page.width} / ${page.height}`,
            width: '100%',
            maxWidth: `min(100%, ${(600 * page.width / page.height).toFixed(0)}px)`,
          }}
        >
          {imageUrl ? (
            <img src={imageUrl} alt={`Page ${page.page_number}`} className="absolute inset-0 h-full w-full object-contain" />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-xs text-ink-500">
              No preview · {page.regions.length} text regions detected
            </div>
          )}

          {showBoxes &&
            page.regions.map((r, i) => (
              <RegionOverlay
                key={`r-${i}`}
                region={r}
                pageW={page.width}
                pageH={page.height}
                active={hoverIdx === i}
                onEnter={() => setHoverIdx(i)}
                onLeave={() => setHoverIdx(null)}
              />
            ))}
        </div>
      </div>

      <div className="card p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-xs uppercase tracking-wide text-ink-400">
            {viewLabel}
          </div>
          <div
            role="tablist"
            aria-label="Right column view"
            className="inline-flex flex-wrap overflow-hidden rounded-md border border-ink-700 bg-ink-900/50 text-[11px]"
          >
            <TabBtn label="Regions" view="regions" current={view} setView={setView} />
            {hasFullText && (
              <TabBtn label="Full text" view="fullText" current={view} setView={setView} />
            )}
            {hasMarkdown && (
              <TabBtn label="Markdown" view="markdown" current={view} setView={setView} />
            )}
            {hasJson && <TabBtn label="JSON" view="json" current={view} setView={setView} />}
            <TabBtn label="Preview" view="preview" current={view} setView={setView} />
          </div>
        </div>

        {view === 'regions' && (
          <RegionsPanel
            page={page}
            hoverIdx={hoverIdx}
            setHoverIdx={setHoverIdx}
            perPageRegions={perPageRegions}
            perPageText={perPageText}
            tableCrops={tableCrops}
            figureCrops={figureCrops}
            imageCrops={imageCrops}
            bilingual={bilingual}
          />
        )}
        {view === 'fullText' && hasFullText && (
          <FullTextBlock text={fullText!} pageText={perPageText} />
        )}
        {view === 'markdown' && hasMarkdown && (
          <MarkdownViewer source={markdownSource!} />
        )}

        {view === 'json' && hasJson && (
          <JsonTree data={safeParse(jsonSource!) ?? jsonSource} maxHeight="560px" />
        )}
      </div>
    </div>
  );
}

function TabBtn({
  label,
  view,
  current,
  setView,
}: {
  label: string;
  view: RightView;
  current: RightView;
  setView: (v: RightView) => void;
}) {
  const active = view === current;
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={() => setView(view)}
      className={`px-2 py-1 transition-colors ${
        active ? 'bg-ink-700 text-ink-50' : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-50'
      }`}
    >
      {label}
    </button>
  );
}

function CopyChip({ label, text }: { label: string; text: string }) {
  return (
    <button
      onClick={async () => {
        await copyToClipboard(text);
      }}
      className="rounded-md border border-ink-700 bg-ink-900/70 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800"
      title={`Copy ${label.toLowerCase()}`}
    >
      Copy {label}
    </button>
  );
}

function RegionsPanel({
  page,
  hoverIdx,
  setHoverIdx,
  perPageRegions,
  perPageText,
  tableCrops,
  figureCrops,
  imageCrops,
  bilingual,
}: {
  page: PageResult;
  hoverIdx: number | null;
  setHoverIdx: (i: number | null) => void;
  perPageRegions: string;
  perPageText: string;
  tableCrops?: VisualRegionCrop[];
  figureCrops?: VisualRegionCrop[];
  imageCrops?: VisualRegionCrop[];
  bilingual?: boolean;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <CopyChip label="regions" text={perPageRegions} />
        <CopyChip label="text" text={perPageText} />
      </div>
      <ul className="max-h-[560px] space-y-3 overflow-auto pr-1">
        {page.regions.map((r, i) => (
          <RegionCard
            key={`rc-${i}`}
            region={r}
            index={i}
            pageNumber={page.page_number}
            active={hoverIdx === i}
            onEnter={() => setHoverIdx(i)}
            onLeave={() => setHoverIdx(null)}
            tableCrops={tableCrops}
            figureCrops={figureCrops}
            imageCrops={imageCrops}
            bilingual={bilingual}
          />
        ))}
        {page.regions.length === 0 && <li className="text-sm text-ink-500">No regions detected.</li>}
      </ul>
    </div>
  );
}

function FullTextBlock({ text, pageText }: { text: string; pageText: string }) {
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10 flex gap-1.5">
        <CopyMenu
          label="Copy"
          compact
          items={[
            {
              id: 'all',
              label: 'Copy whole document',
              hint: `${text.length.toLocaleString()} ch`,
              onSelect: async () => {
                await copyToClipboard(text);
              },
            },
            {
              id: 'page',
              label: 'Copy this page',
              hint: `${pageText.length.toLocaleString()} ch`,
              onSelect: async () => {
                await copyToClipboard(pageText);
              },
            },
          ]}
        />
      </div>
      <div
        className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-ink-800 bg-ink-950/60 p-3 pr-28 text-sm text-ink-100"
        style={{ lineHeight: 1.65 }}
      >
        {text}
      </div>
    </div>
  );
}

/** Pre-formatted code block with a single Copy button. */
function RegionOverlay({
  region,
  pageW,
  pageH,
  active,
  onEnter,
  onLeave,
}: {
  region: LayoutRegion;
  pageW: number;
  pageH: number;
  active: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const pct = bboxToPct(region.bbox, pageW, pageH);
  const color = colorForRegion(region.region_type);
  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      title={`${region.region_type} · ${fmtPct(region.confidence)}`}
      className="absolute rounded-sm transition-opacity"
      style={{
        left: `${pct.left}%`,
        top: `${pct.top}%`,
        width: `${pct.width}%`,
        height: `${pct.height}%`,
        border: `1.5px solid ${color}`,
        background: active ? `${color}22` : `${color}11`,
        boxShadow: active ? `0 0 0 1px ${color}55` : 'none',
      }}
    />
  );
}

/**
 * Find the visual-region crop with the highest IoU (intersection-over-union)
 * bbox overlap against the region. Returns null if no candidate crops are
 * available or none overlap meaningfully.
 */
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

/** Simple axis-aligned IoU on 4-point bboxes. Cheap; good enough for matching. */
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

function ImagePreview({ crop, kind }: { crop: VisualRegionCrop; kind: string }) {
  const sizeKB = Math.round((crop.crop_base64.length * 0.75) / 1024);
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-ink-800 bg-ink-950/50">
      <img
        src={`data:image/png;base64,${crop.crop_base64}`}
        alt={`${kind} preview`}
        className="max-h-64 w-full bg-white object-contain"
      />
      <div className="flex items-center justify-between border-t border-ink-800 px-2 py-1 text-[10px] text-ink-500">
        <span>
          Generated {kind} crop · {sizeKB} KB · conf {fmtPct(crop.confidence)}
        </span>
        <button
          onClick={async (e) => {
            e.stopPropagation();
            await copyToClipboard(`data:image/png;base64,${crop.crop_base64}`);
          }}
          className="rounded border border-ink-700 bg-ink-900/60 px-1.5 py-0.5 text-[10px] text-ink-300 hover:bg-ink-800 hover:text-ink-50"
          title="Copy base64 data URI"
        >
          Copy
        </button>
      </div>
    </div>
  );
}

function RegionCard({
  region,
  index,
  pageNumber,
  active,
  onEnter,
  onLeave,
  tableCrops,
  figureCrops,
  imageCrops,
  bilingual,
}: {
  region: LayoutRegion;
  index: number;
  pageNumber: number;
  active: boolean;
  onEnter: () => void;
  onLeave: () => void;
  tableCrops?: VisualRegionCrop[];
  figureCrops?: VisualRegionCrop[];
  imageCrops?: VisualRegionCrop[];
  bilingual?: boolean;
}) {
  const color = colorForRegion(region.region_type);
  // DocLayNet labels the API emits: title, section-header, list-item, text,
  // caption, footnote, table, picture (+ legacy heading/figure/image aliases).
  const isHeading =
    region.region_type === 'section-header' ||
    region.region_type === 'heading' ||
    region.region_type === 'title';
  const isCaption = region.region_type === 'caption' || region.region_type === 'footnote';
  const isListItem = region.region_type === 'list-item';
  const isTable = region.region_type === 'table';
  const isFigure = region.region_type === 'figure';
  const isImage = region.region_type === 'image';
  const isPicture = region.region_type === 'picture';
  const isVisual = isImage || isFigure || isPicture;

  // Look up a doc-level crop for visual regions. `picture` is the real API
  // label; search every crop array since the backend bins them separately.
  const matchingCrop = useMemo(() => {
    if (isVisual)
      return (
        findMatchingCrop(region, pageNumber, imageCrops) ??
        findMatchingCrop(region, pageNumber, figureCrops) ??
        findMatchingCrop(region, pageNumber, tableCrops)
      );
    if (isTable) return findMatchingCrop(region, pageNumber, tableCrops);
    return null;
  }, [region, pageNumber, isVisual, isTable, imageCrops, figureCrops, tableCrops]);

  const hasText = !!(region.text && region.text.trim().length > 0);

  return (
    <li
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className={`rounded-lg border px-3 py-2 transition-colors ${
        active ? 'border-ink-600 bg-ink-800/70' : 'border-ink-800 bg-ink-900/40'
      }`}
    >
      <div className="flex items-center justify-between text-xs">
        <span className="badge" style={{ borderColor: `${color}66`, color }}>
          {region.region_type} · #{index + 1}
        </span>
        <span className="flex items-center gap-2 text-ink-400">
          <span>{fmtPct(region.confidence)}</span>
          {hasText && (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                await copyToClipboard(region.text ?? '');
              }}
              className="rounded border border-ink-700 bg-ink-900/60 px-1.5 py-0.5 text-[10px] text-ink-300 hover:bg-ink-800 hover:text-ink-50"
              title="Copy this region's text"
            >
              Copy
            </button>
          )}
        </span>
      </div>

      {/* Visual regions: prefer the actual cropped image; fall back to a note. */}
      {isVisual && matchingCrop && (
        <ImagePreview crop={matchingCrop} kind={isFigure ? 'figure' : isPicture ? 'picture' : 'image'} />
      )}
      {isVisual && !matchingCrop && (
        <p className="mt-1.5 text-sm italic text-ink-500">
          (image region — no crop returned for this page)
        </p>
      )}
      {isTable && matchingCrop && (
        <ImagePreview crop={matchingCrop} kind="table" />
      )}

      {/* Text body. For tables, render the raw pipe-separated OCR text in a
          monospace <pre> so the column structure stays visible — the OCR
          pipeline doesn't emit structured cells per-region, so any "smart"
          parsing tends to break on mixed-pipe input. */}
      {bilingual && hasText && !isVisual ? (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-500">Source</div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-100">
              {region.khmer_text ?? region.text}
            </p>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-500">Translation</div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-200">
              {region.english_text ?? <span className="italic text-ink-500">(no translation)</span>}
            </p>
          </div>
        </div>
      ) : hasText ? (
        isHeading ? (
          <h4 className="mt-1.5 text-base font-semibold text-ink-50">{region.text}</h4>
        ) : isCaption ? (
          <p className="mt-1.5 text-sm italic text-ink-300">{region.text}</p>
        ) : isTable ? (
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre rounded-md border border-ink-800 bg-ink-950/50 p-3 font-mono text-[11px] leading-relaxed text-ink-100">
            {region.text}
          </pre>
        ) : isListItem ? (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-ink-100">
            {region.text
              .split('\n')
              .map((t) => t.trim())
              .filter(Boolean)
              .map((t, li) => (
                <li key={li} className="break-words">
                  {t}
                </li>
              ))}
          </ul>
        ) : (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-100">
            {region.text}
          </p>
        )
      ) : (
        !isVisual && (
          <p className="mt-1.5 text-sm italic text-ink-500">(no text)</p>
        )
      )}

      <div className="mt-1.5 text-[11px] text-ink-500">
        {region.lines.length} line(s)
        {matchingCrop && <> · crop {Math.round(matchingCrop.confidence * 100)}%</>}
      </div>
    </li>
  );
}

// Re-export the markdown helper so other modules don't need a separate import.
export { resultToMarkdown };

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
