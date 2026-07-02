// Generic single-column tabbed preview with a Copy button on the active tab.
//
// Used by the OCR Image and Parse Table tabs where the result is a single
// column (no page previews) and we want to flip between the rendered view,
// the raw source text, the CSV / JSON formats, etc.
//
// The BoundingBoxViewer has its own (richer) tab strip because it also owns
// the page-preview image grid and the hover-sync between overlay and cards.

import { useState, type ReactNode } from 'react';
import { copyToClipboard } from '@/lib/utils';

export interface PreviewTab {
  /** Stable id used as React key + tab state. */
  id: string;
  /** Visible label on the pill. */
  label: string;
  /** Body to render inside the content area. */
  content: ReactNode;
  /**
   * Plain-text payload for the Copy button. When omitted, the Copy button is
   * hidden (e.g. for the rendered table grid where there's no obvious "copy
   * the table as text" representation).
   */
  copyText?: string;
  /** Optional hint shown under the Copy button (e.g. "what gets saved to .md"). */
  copyHint?: string;
}

export interface ResultPreviewTabsProps {
  tabs: PreviewTab[];
  /** id of the initially-active tab. Defaults to tabs[0].id. */
  defaultTab?: string;
}

export function ResultPreviewTabs({ tabs, defaultTab }: ResultPreviewTabsProps) {
  const [active, setActive] = useState<string>(defaultTab ?? tabs[0]?.id ?? '');
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  if (!tab) return null;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-ink-400">{tab.label}</div>
        <div
          role="tablist"
          aria-label="Result view"
          className="inline-flex flex-wrap overflow-hidden rounded-md border border-ink-700 bg-ink-900/50 text-[11px]"
        >
          {tabs.map((t) => {
            const isActive = t.id === active;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(t.id)}
                className={`px-2.5 py-1 transition-colors ${
                  isActive
                    ? 'bg-ink-700 text-ink-50'
                    : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-50'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="relative">
        {tab.copyText !== undefined && (
          <div className="absolute right-2 top-2 z-10">
            <button
              onClick={async () => {
                await copyToClipboard(tab.copyText!);
              }}
              className="rounded-md border border-ink-700 bg-ink-900/70 px-2.5 py-1 text-[11px] text-ink-200 hover:bg-ink-800"
              title="Copy this view"
            >
              Copy
            </button>
          </div>
        )}
        <div className={tab.copyText !== undefined ? 'pr-24' : ''}>{tab.content}</div>
        {tab.copyHint && (
          <div className="mt-1 text-[11px] text-ink-500">{tab.copyHint}</div>
        )}
      </div>
    </div>
  );
}
