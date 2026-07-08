/**
 * Transform-to-tidy client.
 *
 * Sends an extracted Markdown table to the tidy-adapter sidecar (which calls the
 * Anthropic Messages API) and gets back a "tidy" reshape — wide/matrix tables
 * unpivoted into long format, obvious OCR noise cleaned, non-Latin text
 * preserved. This is a transform step, independent of the OCR backend toggle.
 *
 * nginx proxies /api-tidy/* → tidy-adapter:8092 at home; hosted builds can point
 * VITE_TIDY_URL at an absolute funnel URL (same pattern as VITE_VLLM_URL).
 */

const TIDY_BASE = (import.meta.env.VITE_TIDY_URL ?? '/api-tidy').replace(/\/$/, '');

export interface TidyResult {
  columns: string[];
  rows: string[][];
  tidy_markdown: string;
  tidy_csv: string;
  notes: string;
  model: string;
}

export interface TidyHealth {
  status: string;
  ready: boolean;
  model?: string;
  message?: string;
}

async function detailFrom(res: Response, fallback: string): Promise<string> {
  try {
    const j = await res.json();
    if (j && typeof j.detail === 'string') return j.detail;
  } catch {
    // non-JSON body — use the fallback
  }
  return fallback;
}

export async function transformToTidy(
  markdown: string,
  opts?: { instructions?: string; signal?: AbortSignal },
): Promise<TidyResult> {
  const res = await fetch(`${TIDY_BASE}/tidy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, instructions: opts?.instructions }),
    signal: opts?.signal,
  });
  if (!res.ok) {
    throw new Error(await detailFrom(res, `Tidy transform failed (${res.status})`));
  }
  return (await res.json()) as TidyResult;
}

export async function tidyHealth(signal?: AbortSignal): Promise<TidyHealth> {
  const res = await fetch(`${TIDY_BASE}/health`, { signal });
  if (!res.ok) throw new Error(`Tidy backend offline (${res.status})`);
  return (await res.json()) as TidyHealth;
}
