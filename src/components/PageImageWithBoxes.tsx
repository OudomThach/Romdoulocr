import { useState } from 'react';
import type { LayoutRegion, PageResult } from '@/types/api';
import { bboxToPct, colorForRegion, fmtPct } from '@/lib/utils';
import { RegionReadButton } from '@/components/RegionReocr';
import type { BackendId } from '@/lib/backend';

export interface PageImageWithBoxesProps {
  page: PageResult;
  imageUrl?: string;
  showBoxes?: boolean;
  maxHeight?: string;
  onHoverRegion?: (index: number | null) => void;
  hoverIdx?: number | null;
  /** Backend for the "Read area" crop; defaults to the active OCR backend. */
  regionBackend?: BackendId;
}

export function PageImageWithBoxes({
  page,
  imageUrl,
  showBoxes = true,
  maxHeight = '700px',
  onHoverRegion,
  hoverIdx,
  regionBackend,
}: PageImageWithBoxesProps) {
  const [internalHover, setInternalHover] = useState<number | null>(null);
  const activeIdx = hoverIdx ?? internalHover;
  const setHover = (i: number | null) => {
    setInternalHover(i);
    onHoverRegion?.(i);
  };

  return (
    <div
      className="relative overflow-auto rounded-lg border border-ink-800 bg-ink-950"
      style={{ maxHeight }}
    >
      {imageUrl && (
        <div className="absolute right-2 top-2 z-20">
          <RegionReadButton imageUrl={imageUrl} backend={regionBackend} variant="solid" />
        </div>
      )}
      <div className="min-w-fit p-2">
        <div
          className="relative mx-auto"
          style={{
            width: '100%',
            minWidth: `${Math.min(1400, page.width)}px`,
            aspectRatio: `${page.width} / ${page.height}`,
          }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={`Page ${page.page_number}`}
              className="absolute inset-0 h-full w-full object-contain"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center rounded bg-ink-900 text-sm text-ink-500">
              No image preview available
              <span className="mt-1 text-xs">
                ({page.regions.length} regions detected · {page.width} × {page.height} px)
              </span>
            </div>
          )}

          {showBoxes &&
            page.regions.map((r, i) => (
              <RegionOverlay
                key={`r-${i}`}
                region={r}
                pageW={page.width}
                pageH={page.height}
                active={activeIdx === i}
                onEnter={() => setHover(i)}
                onLeave={() => setHover(null)}
              />
            ))}
        </div>
      </div>
    </div>
  );
}

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
        border: `2px solid ${color}`,
        background: active ? `${color}33` : `${color}15`,
        boxShadow: active ? `0 0 0 2px ${color}66` : 'none',
        zIndex: active ? 10 : 1,
      }}
    />
  );
}
