// Merge a "full-page" OCR pass (detect_layout=false) into the structured
// layout result, appending only the text lines the layout pass missed.
//
// Strategy: the structured result is the base (it has the good layout/regions).
// For each page we collect every line already present, then append any line the
// full-page pass found that isn't already there as one extra region. We ONLY
// add — never remove — so this can't drop correctly-detected text. If anything
// was appended we clear full_text / translated_text so every consumer
// (Copy Clean Text, .txt export, markdown) recomputes from the now-complete
// region set instead of the server's original merged string.

import type { DocumentResult, PageResult, TextLine } from '@/types/api';

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Every non-empty OCR line on a page, from region.lines or region.text. */
function pageLines(page: PageResult): { text: string; english_text?: string | null }[] {
  const out: { text: string; english_text?: string | null }[] = [];
  for (const region of page.regions) {
    if (region.lines && region.lines.length > 0) {
      for (const line of region.lines) {
        const t = (line.text ?? '').trim();
        if (t) out.push({ text: t, english_text: line.english_text });
      }
    } else {
      const t = (region.text ?? '').trim();
      if (t) {
        for (const part of t.split('\n').map((s) => s.trim()).filter(Boolean)) {
          out.push({ text: part, english_text: region.english_text });
        }
      }
    }
  }
  return out;
}

/**
 * Returns a new DocumentResult with full-page-only text appended per page.
 * `base` and `fullPage` are matched by page_number.
 */
export function mergeFullPageText(base: DocumentResult, fullPage: DocumentResult): DocumentResult {
  const fullByNum = new Map<number, PageResult>();
  for (const p of fullPage.pages) fullByNum.set(p.page_number, p);

  let appendedAny = false;

  const pages = base.pages.map((page) => {
    const fp = fullByNum.get(page.page_number);
    if (!fp) return page;

    const present = new Set(pageLines(page).map((l) => norm(l.text)));
    const missing = pageLines(fp).filter((l) => l.text && !present.has(norm(l.text)));
    if (missing.length === 0) return page;

    appendedAny = true;
    const lines: TextLine[] = missing.map((l) => ({
      bbox: { points: [], confidence: 0 },
      text: l.text,
      confidence: 0,
      english_text: l.english_text ?? null,
    }));
    const extraRegion = {
      bbox: { points: [], confidence: 0 },
      region_type: 'paragraph',
      lines,
      text: missing.map((l) => l.text).join('\n'),
      confidence: 0,
      english_text: missing.map((l) => l.english_text || l.text).join('\n'),
    };
    return { ...page, regions: [...page.regions, extraRegion] };
  });

  if (!appendedAny) return base;

  return {
    ...base,
    pages,
    // Force consumers to recompute from the now-complete regions.
    full_text: undefined,
    translated_text: undefined,
  };
}
