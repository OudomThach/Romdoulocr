import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCEPTED_EXTENSIONS, fmtBytes, isImage, isPdf } from '@/lib/utils';

export interface FileDropzoneProps {
  multiple?: boolean;
  accept: 'pdf-or-image' | 'image-only';
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}

const MIME_ACCEPT = '.pdf,application/pdf,image/png,image/jpeg,image/bmp,image/tiff,image/webp';

export function FileDropzone({ multiple, accept, files, onChange, disabled }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isOver, setIsOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = useCallback(
    (incoming: FileList | File[] | null): File[] | null => {
      if (!incoming) return null;
      const arr = Array.from(incoming);
      for (const f of arr) {
        if (accept === 'image-only' && !isImage(f.name)) {
          setError(
            isPdf(f.name)
              ? `${f.name} is a PDF. Switch to "Parse Document" for PDF support.`
              : `${f.name} is not a supported image (PNG, JPG, BMP, TIFF, WEBP).`,
          );
          return null;
        }
        if (accept === 'pdf-or-image' && !isPdf(f.name) && !isImage(f.name)) {
          setError(`${f.name} is not a supported file type (PDF, PNG, JPG, BMP, TIFF, WEBP).`);
          return null;
        }
      }
      setError(null);
      return arr;
    },
    [accept],
  );

  const commitFiles = useCallback(
    (next: File[]) => {
      onChange(multiple ? [...files, ...next] : next.slice(0, 1));
    },
    [files, multiple, onChange],
  );

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (disabled) return;
      // Skip if this dropzone lives in a hidden (display:none) tab — every tab
      // stays mounted, so without this a paste would land in all of them.
      if (rootRef.current && rootRef.current.offsetParent === null) return;
      const pasted = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
      if (pasted.length === 0) return;
      const valid = validate(pasted);
      if (valid) commitFiles(valid);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [accept, commitFiles, disabled, validate]);

  const onDrop = useCallback(
    (ev: React.DragEvent) => {
      ev.preventDefault();
      setIsOver(false);
      if (disabled) return;
      const next = validate(ev.dataTransfer.files);
      if (next) commitFiles(next);
    },
    [commitFiles, disabled, validate],
  );

  const onPick = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      const next = validate(ev.target.files);
      if (next) commitFiles(next);
      ev.target.value = '';
    },
    [commitFiles, validate],
  );

  const removeAt = (idx: number) => onChange(files.filter((_, i) => i !== idx));

  return (
    <div ref={rootRef}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setIsOver(true);
        }}
        onDragLeave={() => setIsOver(false)}
        onDrop={onDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled) inputRef.current?.click();
        }}
        className={`group relative flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-4 text-center transition-all duration-200 ${
          disabled
            ? 'border-slate-200 bg-slate-50 opacity-60'
            : isOver
              ? 'scale-[1.02] border-slate-500 bg-slate-100 shadow-md'
              : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept === 'image-only' ? 'image/*' : MIME_ACCEPT}
          multiple={!!multiple}
          onChange={onPick}
          className="sr-only"
          disabled={disabled}
        />
        <div className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-slate-200 text-slate-950 transition-transform duration-200 group-hover:scale-110">
          <UploadIcon className="h-5 w-5" />
        </div>
        <div className="text-sm font-semibold text-slate-950">
          {files.length > 0 ? 'Add more or click to replace' : 'Drop a PDF or image here'}
        </div>
        <div className="mt-1 text-xs text-slate-500">or click to browse · paste an image anywhere</div>
      </div>

      <div className="mt-2 text-[11px] text-slate-500">Accepted: {ACCEPTED_EXTENSIONS}</div>

      {error && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {files.length > 0 && (
        <ul className="mt-4 space-y-2">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                  {isPdf(f.name) ? 'PDF' : isImage(f.name) ? 'IMG' : 'FILE'}
                </span>
                <span className="truncate text-sm text-slate-800">{f.name}</span>
                <span className="shrink-0 text-xs text-slate-500">{fmtBytes(f.size)}</span>
              </div>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  removeAt(i);
                }}
                className="rounded px-2 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-950"
                disabled={disabled}
                aria-label={`Remove ${f.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12" strokeLinecap="round" />
      <path d="m7 8 5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 15v4h14v-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
