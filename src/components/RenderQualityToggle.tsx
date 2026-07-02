import { useSyncExternalStore } from 'react';
import {
  getBackend,
  subscribeBackend,
  getRenderQuality,
  setRenderQuality,
  subscribeRenderQuality,
  type BackendId,
  type RenderQuality,
} from '@/lib/backend';

/**
 * vLLM render-quality (DPI) selector. surya-ocr-2 resolves dense tables/text
 * better at higher DPI, so this lets the user trade speed for fidelity. Only
 * relevant to the local vLLM backend (the Modal default rasterizes server-side
 * and ignores DPI), so the control hides itself unless vLLM is active.
 */
const OPTIONS: { id: RenderQuality; label: string; title: string }[] = [
  { id: 'low', label: 'Low', title: 'Fastest — 96 DPI' },
  { id: 'balanced', label: 'Med', title: 'Balanced — 150 DPI (default)' },
  { id: 'high', label: 'High', title: 'Best for dense tables — 300 DPI (slower)' },
];

export function RenderQualityToggle() {
  const backend = useSyncExternalStore(subscribeBackend, getBackend, () => 'default' as BackendId);
  const quality = useSyncExternalStore(
    subscribeRenderQuality,
    getRenderQuality,
    () => 'balanced' as RenderQuality,
  );

  if (backend !== 'vllm') return null;

  return (
    <div
      role="group"
      aria-label="vLLM render quality"
      className="hidden items-center rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm sm:flex"
      title="vLLM render quality (DPI). Higher resolves dense tables better but is slower."
    >
      <span className="px-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">DPI</span>
      {OPTIONS.map((opt) => {
        const active = quality === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => setRenderQuality(opt.id)}
            aria-pressed={active}
            title={opt.title}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              active
                ? 'bg-slate-950 text-white'
                : 'text-slate-500 hover:bg-slate-50 hover:text-slate-950'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
