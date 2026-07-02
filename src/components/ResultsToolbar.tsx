import { useState } from 'react';
import {
  copyToClipboard,
  downloadBytes,
  downloadJson,
  downloadText,
} from '@/lib/utils';
import { resultToMarkdown, resultToSearchablePdf } from '@/lib/exporters';
import { downloadZip, type ZipEntry } from '@/lib/zipExport';
import type { DocumentResult } from '@/types/api';
import { CopyMenu } from '@/components/CopyMenu';

export interface ResultsToolbarProps {
  /** Plain-text payload for copy / download-as-text. */
  text: string;
  /** Filename for downloads (without extension). */
  filenameBase: string;
  /** Optional JSON payload — when present, the JSON button is shown. */
  json?: unknown;
  /** Optional DocumentResult — enables Markdown + searchable PDF exports. */
  documentResult?: DocumentResult;
  /** Render the .md / .pdf buttons as disabled while exporting. */
  exporting?: 'pdf' | 'zip' | null;
  onExportingChange?: (state: 'pdf' | 'zip' | null) => void;
  /**
   * Optional: when provided, the toolbar gets a "Download all (.zip)" button
   * that bundles every supplied entry into one archive. The function is
   * called lazily at click time, so heavy serialization (e.g. per-result
   * PDF generation) only happens when the user actually wants the zip.
   */
  zipBundle?: { filename: string; entries: () => ZipEntry[] | Promise<ZipEntry[]> };
  /**
   * Optional Markdown source for the Copy dropdown. When omitted, the menu
   * falls back to Plain + Per-page only.
   */
  markdownSource?: string;
  /**
   * Optional Per-page blocks text (e.g. "--- Page N ---\n...") for a
   * page-level copy option. If omitted, the per-page option is hidden.
   */
  perPageText?: string;
}

export function ResultsToolbar({
  text,
  filenameBase,
  json,
  documentResult,
  exporting,
  onExportingChange,
  zipBundle,
  markdownSource,
  perPageText,
}: ResultsToolbarProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const onDownloadMd = () => {
    if (!documentResult && !markdownSource) return;
    const md = documentResult ? resultToMarkdown(documentResult) : (markdownSource ?? '');
    downloadText(`${filenameBase}.md`, md, 'text/markdown;charset=utf-8');
  };

  const onDownloadPdf = async () => {
    if (!documentResult || !onExportingChange) return;
    onExportingChange('pdf');
    try {
      const bytes = await resultToSearchablePdf(documentResult);
      downloadBytes(`${filenameBase}.pdf`, bytes, 'application/pdf');
    } finally {
      onExportingChange(null);
    }
  };

  const onDownloadZip = async () => {
    if (!zipBundle || !onExportingChange) return;
    onExportingChange('zip');
    try {
      const entries = await Promise.resolve(zipBundle.entries());
      await downloadZip(zipBundle.filename, entries);
    } finally {
      onExportingChange(null);
    }
  };

  // Build the copy-menu items dynamically based on what we have.
  const copyItems = [
    {
      id: 'plain',
      label: 'Plain text',
      hint: `${text.length.toLocaleString()} ch`,
      onSelect: onCopy,
    },
  ];
  if (markdownSource && markdownSource.trim().length > 0) {
    copyItems.push({
      id: 'markdown',
      label: 'Markdown',
      hint: `${markdownSource.length.toLocaleString()} ch`,
      onSelect: async () => {
        await copyToClipboard(markdownSource);
      },
    });
  }
  if (perPageText && perPageText.trim().length > 0) {
    copyItems.push({
      id: 'per-page',
      label: 'Per-page blocks',
      hint: `${perPageText.length.toLocaleString()} ch`,
      onSelect: async () => {
        await copyToClipboard(perPageText);
      },
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CopyMenu label={copied ? 'Copied!' : 'Copy text'} items={copyItems} />
      <button onClick={() => downloadText(`${filenameBase}.txt`, text)} className="btn-secondary">
        .txt
      </button>
      {(documentResult || (markdownSource && markdownSource.trim().length > 0)) && (
        <button onClick={onDownloadMd} className="btn-secondary">
          .md
        </button>
      )}
      {documentResult && onExportingChange && (
        <button onClick={onDownloadPdf} disabled={exporting === 'pdf'} className="btn-secondary">
          {exporting === 'pdf' ? 'Building…' : '.pdf'}
        </button>
      )}
      {json !== undefined && (
        <button onClick={() => downloadJson(`${filenameBase}.json`, json)} className="btn-secondary">
          .json
        </button>
      )}
      {zipBundle && onExportingChange && (
        <button
          onClick={onDownloadZip}
          disabled={exporting === 'zip'}
          className="btn-secondary"
          title="Download every result on this page in one archive"
        >
          {exporting === 'zip' ? 'Zipping…' : 'All (.zip)'}
        </button>
      )}
    </div>
  );
}
