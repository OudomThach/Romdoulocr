//
// MarkdownViewer — Preview / Source tabs with edit, save, download, copy.
//
import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { copyToClipboard, downloadText } from '@/lib/utils';

interface MarkdownViewerProps {
  source: string;
  onSave?: (newSource: string) => void;
  filename?: string;
  maxHeight?: string;
}

type TabId = 'preview' | 'source';

export function MarkdownViewer({ source, onSave, filename, maxHeight = '560px' }: MarkdownViewerProps) {
  const [tab, setTab] = useState<TabId>('preview');
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  const [copied, setCopied] = useState(false);

  const activeSource = isEditing ? draft : source;

  const handleCopy = useCallback(async () => {
    await copyToClipboard(activeSource);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [activeSource]);

  const handleDownload = useCallback(() => {
    const name = filename
      ? `${filename.replace(/\.[^.]+$/, '')}.md`
      : 'document.md';
    downloadText(name, activeSource, 'text/markdown;charset=utf-8');
  }, [activeSource, filename]);

  const handleSave = useCallback(() => {
    setIsEditing(false);
    onSave?.(draft);
  }, [draft, onSave]);

  const handleEdit = useCallback(() => {
    if (isEditing) {
      // Cancel edit: discard changes
      setDraft(source);
      setIsEditing(false);
    } else {
      setDraft(source);
      setIsEditing(true);
      setTab('source');
    }
  }, [isEditing, source]);

  return (
    <div className="flex flex-col gap-2">
      {/* Tab bar + actions */}
      <div className="flex items-center justify-between gap-2">
        <div
          role="tablist"
          className="inline-flex overflow-hidden rounded-md border border-ink-700 bg-ink-900/50 text-[11px]"
        >
          <TabBtn active={tab === 'preview'} onClick={() => setTab('preview')}>
            Preview
          </TabBtn>
          <TabBtn active={tab === 'source'} onClick={() => setTab('source')}>
            Source
          </TabBtn>
        </div>

        <div className="flex items-center gap-1">
          <ActionBtn onClick={handleEdit} title={isEditing ? 'Cancel editing' : 'Edit markdown'}>
            <PencilIcon />
            <span className="hidden sm:inline">{isEditing ? 'Cancel' : 'Edit'}</span>
          </ActionBtn>
          {isEditing && (
            <ActionBtn onClick={handleSave} title="Save changes">
              <CheckIcon />
              <span className="hidden sm:inline">Save</span>
            </ActionBtn>
          )}
          <ActionBtn onClick={handleCopy} title="Copy to clipboard">
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
          </ActionBtn>
          <ActionBtn onClick={handleDownload} title="Download .md file">
            <DownloadIcon />
            <span className="hidden sm:inline">.md</span>
          </ActionBtn>
        </div>
      </div>

      {/* Content */}
      <div
        className="overflow-auto rounded-lg border border-ink-800 bg-ink-950/60 p-4"
        style={{ maxHeight }}
      >
        {tab === 'preview' ? (
          <div className="prose prose-invert prose-sm max-w-none
            prose-headings:text-ink-50 prose-headings:font-semibold
            prose-h1:text-lg prose-h1:border-b prose-h1:border-ink-800 prose-h1:pb-1.5
            prose-h2:text-base prose-h2:mt-4
            prose-h3:text-sm prose-h3:text-accent
            prose-p:text-ink-100 prose-p:leading-relaxed
            prose-a:text-accent
            prose-strong:text-ink-50
            prose-code:bg-ink-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-accent
            prose-pre:bg-ink-950 prose-pre:border prose-pre:border-ink-800
            prose-img:rounded-lg prose-img:border prose-img:border-ink-800 prose-img:mx-auto prose-img:max-h-80
            prose-li:text-ink-200
            prose-blockquote:border-l-accent prose-blockquote:text-ink-300
          ">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {activeSource}
            </ReactMarkdown>
          </div>
        ) : (
          <textarea
            value={activeSource}
            onChange={(e) => setDraft(e.target.value)}
            readOnly={!isEditing}
            className={`w-full h-full min-h-[300px] resize-y font-mono text-xs leading-relaxed bg-transparent text-ink-200 outline-none ${
              isEditing
                ? 'border border-ink-600 rounded-md p-2 focus:border-accent'
                : 'border-none p-0 cursor-default'
            }`}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-2.5 py-1 transition-colors ${
        active ? 'bg-ink-700 text-ink-50' : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-50'
      }`}
    >
      {children}
    </button>
  );
}

function ActionBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1 rounded-md border border-ink-700 bg-ink-900/60 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-800 hover:text-ink-50 transition-colors"
    >
      {children}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
