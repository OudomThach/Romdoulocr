// Character / Word Error Rate for OCR evaluation against ground truth.
//
// CER is the right primary metric for Khmer (no spaces between words). WER is
// meaningful for space-delimited languages (English); for Khmer it would need a
// word segmenter, so treat WER as English-oriented. Both normalize Unicode to
// NFC and collapse whitespace first so the comparison is fair.

function normalize(s: string): string {
  return (s ?? '')
    .normalize('NFC')
    // Strip zero-width characters BEFORE collapsing whitespace. These are
    // invisible (Khmer datasets use U+200B as a word boundary; ZWNJ/ZWJ are
    // shaping hints; U+FEFF is a BOM) — they carry no glyph, so counting them
    // as edits would unfairly inflate CER when one side has them and the other
    // doesn't. JS \s does NOT match U+200B, so this must be explicit.
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein edit distance over a token array (chars or words). Two-row DP. */
function editDistance<T>(a: T[], b: T[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

/** Character Error Rate (0..1+). Iterates by code point (Khmer-safe). */
export function cer(reference: string, hypothesis: string): number {
  const ref = [...normalize(reference)];
  const hyp = [...normalize(hypothesis)];
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(ref, hyp) / ref.length;
}

/** Word Error Rate (0..1+). Whitespace-tokenized — English-oriented. */
export function wer(reference: string, hypothesis: string): number {
  const ref = normalize(reference).split(' ').filter(Boolean);
  const hyp = normalize(hypothesis).split(' ').filter(Boolean);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(ref, hyp) / ref.length;
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// --------------------------------------------------------------------------- //
// Character diff (for highlighting OCR errors against ground truth)
// --------------------------------------------------------------------------- //

/**
 * One run of the aligned diff between reference and hypothesis:
 *   equal   — char matches in both (render normal)
 *   replace — substitution; `text` is the HYPOTHESIS char the OCR produced
 *   insert  — extra char in the hypothesis not in the reference
 *   delete  — char in the reference MISSING from the hypothesis (`text` is the
 *             reference char, so the reader sees what was dropped)
 */
export interface DiffToken {
  kind: 'equal' | 'replace' | 'insert' | 'delete';
  text: string;
}

// Guard: a full Levenshtein matrix is O(n·m). Beyond this product we skip the
// diff and render the hypothesis plain (only matters for very long documents;
// dataset OCR lines are tiny).
const DIFF_CELL_CAP = 4_000_000;

/**
 * Character-level diff of `hypothesis` against `reference` (same NFC +
 * zero-width normalization as CER, so the diff matches the score). Returns a
 * left-to-right token stream you can render as a tracked-changes view.
 */
export function diffChars(reference: string, hypothesis: string): DiffToken[] {
  const a = [...normalize(reference)];
  const b = [...normalize(hypothesis)];
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.length ? [{ kind: 'insert', text: b.join('') }] : [];
  if (m === 0) return [{ kind: 'delete', text: a.join('') }];
  if (n * m > DIFF_CELL_CAP) return [{ kind: 'equal', text: b.join('') }];

  // Full DP matrix so we can backtrace the alignment.
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  const out: DiffToken[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      out.push({ kind: 'equal', text: a[i - 1] });
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      out.push({ kind: 'replace', text: b[j - 1] }); // OCR substituted this char
      i--; j--;
    } else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      out.push({ kind: 'insert', text: b[j - 1] }); // extra char in OCR output
      j--;
    } else {
      out.push({ kind: 'delete', text: a[i - 1] }); // reference char OCR missed
      i--;
    }
  }
  out.reverse();

  // Coalesce adjacent same-kind tokens so rendering uses far fewer runs.
  const merged: DiffToken[] = [];
  for (const t of out) {
    const last = merged[merged.length - 1];
    if (last && last.kind === t.kind) last.text += t.text;
    else merged.push({ ...t });
  }
  return merged;
}
