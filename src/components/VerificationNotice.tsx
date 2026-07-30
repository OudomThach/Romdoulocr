/**
 * "Check this before you trust it" banner, shown with every extraction result.
 *
 * OCR output looks authoritative — clean text in a tidy box — and that is exactly
 * the problem. Khmer stacked consonants, low-contrast scans and table borders all
 * produce plausible-looking wrong characters rather than obvious garbage, and a
 * number that is quietly wrong is worse than one that is visibly missing. This
 * sits next to the result so nobody pastes it into a report unread.
 *
 * Deliberately not dismissible: it applies to every result, not just the first.
 */
export function VerificationNotice({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
        <WarnIcon className="mt-px h-3.5 w-3.5 flex-none" />
        <span>
          <span className="font-semibold">Extracted — please verify.</span> Compare against the
          source before using it; check numbers, dates and names especially.
        </span>
      </p>
    );
  }

  return (
    <div
      role="note"
      className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <WarnIcon className="mt-0.5 h-4 w-4 flex-none" />
      <div className="min-w-0 text-xs leading-relaxed">
        <span className="font-semibold">Extracted text needs verification.</span>{' '}
        Always recheck against the original before using this. OCR can misread stacked Khmer
        consonants, faint scans and table cells in ways that still look correct — pay closest
        attention to <span className="font-medium">numbers, dates, names and totals</span>.
      </div>
    </div>
  );
}

function WarnIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 9v4" strokeLinecap="round" />
      <path d="M12 17h.01" strokeLinecap="round" />
      <path
        d="M10.3 3.9 2.4 17.5A1.9 1.9 0 0 0 4 20.4h16a1.9 1.9 0 0 0 1.6-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z"
        strokeLinejoin="round"
      />
    </svg>
  );
}
