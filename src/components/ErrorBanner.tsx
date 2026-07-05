import type { ApiError } from '@/lib/api';

export interface ErrorBannerProps {
  error: unknown;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  const { title, detail, status } = parseError(error);
  return (
    <div className="rise-in flex gap-3 rounded-xl border border-rose-300/60 bg-rose-50/80 px-4 py-3 text-sm text-rose-800 shadow-sm backdrop-blur dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4m0 4h.01" strokeLinecap="round" />
        </svg>
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 font-semibold">
          {title}
          {status !== null && (
            <span className="badge border-rose-300 text-rose-700 dark:border-rose-500/40 dark:text-rose-300">HTTP {status}</span>
          )}
        </div>
        {detail && <p className="mt-1 text-rose-700/80 dark:text-rose-300/90">{detail}</p>}
      </div>
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
