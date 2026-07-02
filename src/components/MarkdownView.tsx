// Tiny markdown renderer — headings, paragraphs, pipe tables, bold/italic/code,
// and inline images (![alt](url)). Zero runtime deps.

import type { ReactNode } from 'react';
import { copyToClipboard } from '@/lib/utils';

interface Block {
  kind: 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'table' | 'hr' | 'image';
  text?: string;
  rows?: string[][];
  url?: string;
  alt?: string;
}

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.trim() === '') {
      i++;
      continue;
    }
    if (/^---+$/.test(ln.trim())) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }
    // Image: ![alt](url)
    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(ln.trim());
    if (img) {
      blocks.push({ kind: 'image', alt: img[1], url: img[2] });
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(ln);
    if (h) {
      const level = h[1].length;
      blocks.push({ kind: `h${level}` as Block['kind'], text: h[2].trim() });
      i++;
      continue;
    }
    // Pipe table. Accept both strict Markdown tables with a separator row
    // and OCR-style pipe rows without one.
    if (/^\s*\|/.test(ln) && /\|/.test(ln)) {
      const headerCells = splitRow(ln);
      if (i + 1 < lines.length && /^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$/.test(lines[i + 1])) {
        const rows: string[][] = [headerCells];
        i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i]) && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        blocks.push({ kind: 'table', rows });
        continue;
      }
      if (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1]) && lines[i + 1].includes('|')) {
        const rows: string[][] = [];
        while (i < lines.length && /^\s*\|/.test(lines[i]) && lines[i].includes('|')) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        blocks.push({ kind: 'table', rows });
        continue;
      }
    }
    // Plain paragraph
    const para: string[] = [ln];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^#{1,4}\s/.test(lines[i]) && !/^---+$/.test(lines[i].trim()) && !/^!\[/.test(lines[i].trim())) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', text: para.join(' ') });
  }
  return blocks;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function renderInline(text: string): ReactNode[] {
  const out: React.ReactNode[] = [];
  let key = 0;
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/;
  let rest = text;
  while (rest.length > 0) {
    const m = re.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={`b-${key++}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={`i-${key++}`}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith('`')) {
      out.push(
        <code key={`c-${key++}`} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em] text-slate-900">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export function MarkdownView({
  source,
  maxHeight = '560px',
  showCopy = true,
}: {
  source: string;
  maxHeight?: string;
  showCopy?: boolean;
}) {
  const blocks = parseMarkdown(source);

  if (blocks.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm italic text-slate-500">
        (empty markdown)
      </div>
    );
  }

  return (
    <div className="relative">
      {showCopy && (
        <div className="absolute right-2 top-2 z-10">
          <button
            onClick={async () => {
              await copyToClipboard(source);
            }}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
            title="Copy markdown source"
          >
            Copy MD
          </button>
        </div>
      )}
      <div
        className="overflow-auto rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-950"
        style={{ maxHeight, paddingRight: showCopy ? '7rem' : undefined }}
      >
        <article
          className="grid gap-3"
          style={{ fontFamily: "'Noto Sans Khmer', 'Khmer OS Siemreap', 'Segoe UI', sans-serif" }}
        >
          {blocks.map((b, idx) => {
            switch (b.kind) {
              case 'h1':
                return (
                  <h1 key={idx} className="border-b border-slate-200 pb-2 text-xl font-semibold text-slate-950">
                    {b.text}
                  </h1>
                );
              case 'h2':
                return (
                  <h2 key={idx} className="mt-2 text-lg font-semibold text-slate-950">
                    {b.text}
                  </h2>
                );
              case 'h3':
                return (
                  <h3 key={idx} className="text-base font-semibold text-slate-900">
                    {b.text}
                  </h3>
                );
              case 'h4':
                return (
                  <h4 key={idx} className="text-sm font-semibold text-slate-800">
                    {b.text}
                  </h4>
                );
              case 'hr':
                return <hr key={idx} className="my-1 border-slate-200" />;
              case 'table':
                return <PipeTable key={idx} rows={b.rows!} />;
              case 'image':
                return (
                  <figure key={idx} className="my-2">
                    <img
                      src={b.url}
                      alt={b.alt ?? ''}
                      className="mx-auto max-h-80 rounded-lg border border-slate-200 object-contain"
                    />
                    {b.alt && (
                      <figcaption className="mt-1.5 text-center text-[11px] text-slate-500">
                        {b.alt}
                      </figcaption>
                    )}
                  </figure>
                );
              case 'p':
              default:
                return (
                  <p key={idx} className="leading-[1.85] text-slate-950">
                    {renderInline(b.text ?? '')}
                  </p>
                );
            }
          })}
        </article>
      </div>
    </div>
  );
}

function PipeTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return null;
  const [header, ...body] = rows;
  return (
    <div className="overflow-auto rounded-none border border-slate-300">
      <table className="min-w-full border-collapse text-[15px] leading-relaxed">
        <thead>
          <tr>
            {header.map((c, i) => (
              <th
                key={i}
                className="border-b border-r border-slate-300 bg-slate-100 px-4 py-3 text-left align-top font-semibold text-slate-950 last:border-r-0"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className="border-b border-slate-300 odd:bg-white even:bg-slate-50 last:border-b-0">
              {r.map((c, ci) => (
                <td key={ci} className="border-r border-slate-300 px-4 py-3 align-top text-slate-950 last:border-r-0">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
