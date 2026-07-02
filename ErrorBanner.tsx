import type { ApiError } from '@/lib/api';

export interface ErrorBannerProps {
  error: unknown;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  const { title, detail, status } = parseError(error);
  return (
    <div className="rounded-lg border border-rose-800/60 bg-rose-900/30 px-4 py-3 text-sm text-rose-200">
      <div className="flex items-center gap-2 font-medium">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4m0 4h.01" strokeLinecap="round" />
        </svg>
        {title}
        {status !== null && <span className="badge border-rose-700/60 text-rose-300">HTTP {status}</span>}
      </div>
      {detail && <p className="mt-1 text-rose-300/90">{detail}</p>}
    </div>
  );
}

function parseError(error: unknown): { title: string; detail: string; status: number | null } {
  if (error && typeof error === 'object' && 'status' in error && 'body' in error) {
    const e = error as ApiError;
    return { title: 'API request failed', detail: e.message, status: e.status };
  }
  if (error instanceof Error) return { title: 'Something went wrong', detail: error.message, status: null };
  return { title: 'Unexpected error', detail: String(error), status: null };
}
