// Builds a self-contained HTML document for a Compare run so it can be
// downloaded and reviewed offline: both backends side-by-side, each showing the
// detected region boxes over the source image (document mode) plus its markdown.

import type { CompareRecord } from '@/lib/storage';
import { normalizeOcrResponse, type DocumentResult, type TableResult } from '@/types/api';
import { resultToMarkdown } from '@/lib/exporters';
import { bboxToPct, colorForRegion } from '@/lib/utils';

type PaneData = CompareRecord['panes'][number]['data'];

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function paneMarkdown(mode: CompareRecord['mode'], data: PaneData): string {
  if (mode === 'document') return resultToMarkdown(data as DocumentResult);
  if (mode === 'table') return (data as TableResult).structured_text || '';
  return normalizeOcrResponse(data).text || '';
}

function boxesBlock(data: PaneData, imgDataUrl: string): string {
  const page = (data as DocumentResult).pages?.[0];
  if (!page) return '';
  const boxes = page.regions
    .map((r) => {
      const p = bboxToPct(r.bbox, page.width, page.height);
      const c = colorForRegion(r.region_type);
      return `<div class="box" style="left:${p.left}%;top:${p.top}%;width:${p.width}%;height:${p.height}%;border-color:${c}"></div>`;
    })
    .join('');
  return `<div class="imgwrap" style="aspect-ratio:${page.width}/${page.height}"><img src="${imgDataUrl}" alt="source"/>${boxes}</div>`;
}

function columnsHtml(mode: CompareRecord['mode'], panes: CompareRecord['panes'], imgDataUrl?: string): string {
  return panes
    .map((p) => {
      const name = p.backend === 'vllm' ? 'Surya OCR 2 · vLLM' : 'Khmer Parsing API';
      const boxes = mode === 'document' && imgDataUrl ? boxesBlock(p.data, imgDataUrl) : '';
      const md = paneMarkdown(mode, p.data);
      return `<section class="col"><h2>${esc(name)} <span class="ms">${(p.ms / 1000).toFixed(1)}s</span></h2>${boxes}<pre>${esc(md)}</pre></section>`;
    })
    .join('');
}

const STYLE = `<style>
body{font-family:'Segoe UI','Noto Sans Khmer',system-ui,sans-serif;margin:24px;color:#0f172a;background:#fbfbfc}
h1{font-size:18px;margin:0 0 4px}.meta{color:#64748b;font-size:13px;margin-bottom:16px}
.item{margin:0 0 26px;padding:0 0 22px;border-bottom:1px solid #e2e8f0}
.itemtitle{font-size:15px;margin:0 0 10px}.itemtitle .pref{font-size:12px;color:#64748b;font-weight:400}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}
.col h2{font-size:15px;margin:0 0 8px;display:flex;align-items:center;gap:8px}
.col h2 .ms{font-size:12px;color:#64748b;font-weight:400}
.imgwrap{position:relative;width:100%;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;background:#0a0b12;margin-bottom:10px}
.imgwrap img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.box{position:absolute;border:2px solid;border-radius:2px;box-sizing:border-box}
pre{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font-family:'Noto Sans Khmer',ui-monospace,monospace}
@media(max-width:760px){.cols{grid-template-columns:1fr}}
</style>`;

export function buildCompareHtml(opts: {
  filename: string;
  mode: CompareRecord['mode'];
  panes: CompareRecord['panes'];
  preferred?: string;
  imgDataUrl?: string;
  generatedAt: string;
}): string {
  const { filename, mode, panes, preferred, imgDataUrl, generatedAt } = opts;
  return `<!doctype html><html lang="km"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comparison — ${esc(
    filename,
  )}</title>${STYLE}</head><body>
<h1>Comparison — ${esc(filename)}</h1>
<div class="meta">Mode: ${esc(mode)} · ${esc(generatedAt)}${preferred ? ` · preferred: ${esc(preferred)}` : ''}</div>
<div class="cols">${columnsHtml(mode, panes, imgDataUrl)}</div>
</body></html>`;
}

export interface BatchCompareItem {
  filename: string;
  mode: CompareRecord['mode'];
  panes: CompareRecord['panes'];
  preferred?: string;
  imgDataUrl?: string;
}

export function buildBatchCompareHtml(opts: { items: BatchCompareItem[]; generatedAt: string }): string {
  const sections = opts.items
    .map((it, i) => {
      const pref = it.preferred ? ` <span class="pref">preferred: ${esc(it.preferred)}</span>` : '';
      return `<div class="item"><h2 class="itemtitle">${i + 1}. ${esc(it.filename)}${pref}</h2><div class="cols">${columnsHtml(
        it.mode,
        it.panes,
        it.imgDataUrl,
      )}</div></div>`;
    })
    .join('');
  return `<!doctype html><html lang="km"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Batch comparison (${opts.items.length})</title>${STYLE}</head><body>
<h1>Batch comparison — ${opts.items.length} item(s)</h1>
<div class="meta">${esc(opts.generatedAt)}</div>
${sections}
</body></html>`;
}
