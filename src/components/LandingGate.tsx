import { RomdoulLogo } from '@/components/RomdoulLogo';
import { LanguageToggle } from '@/components/LanguageToggle';
import { toast } from '@/hooks/useToastStore';
import { useLocale } from '@/lib/i18n';

/**
 * Guest gate — the branded welcome screen shown before entering the app.
 * Only "Continue as guest" is live (and deliberately FIRST, per product
 * choice); Google / email / create-account are visible but marked coming
 * soon (no auth backend yet) and just toast an explanation.
 */
export function LandingGate({ onEnter }: { onEnter: () => void }) {
  const { t } = useLocale();

  const soon = () => toast.info(t('landing.soonToast'));

  const soonBadge = (
    <span className="badge absolute -top-2 right-3 border-accent2/40 bg-white text-[10px] text-accent2">
      {t('landing.soon')}
    </span>
  );

  return (
    <div className="relative z-10 flex min-h-screen w-full items-center justify-center p-4">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>

      <section className="panel-raised rise-in w-full max-w-md p-6 text-center sm:p-10">
        {/* Brand */}
        <div className="mx-auto mb-4 grid h-24 w-24 place-items-center rounded-3xl bg-accent/10 text-accent ring-1 ring-accent/30">
          <RomdoulLogo className="h-16 w-16 drop-shadow-[0_0_20px_rgba(0,229,255,0.55)]" />
        </div>
        <h1 className="display">
          Romdoul <span className="text-accent dark:drop-shadow-[0_0_10px_rgba(0,229,255,0.7)]">OCR</span>
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-600">{t('landing.tagline')}</p>

        {/* What it does */}
        <ul className="mx-auto mt-5 max-w-sm space-y-2 text-left text-sm text-slate-600">
          {(['landing.feature1', 'landing.feature2', 'landing.feature3'] as const).map((k) => (
            <li key={k} className="flex items-start gap-2.5">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/10 text-accent">
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 13 4 4L19 7" />
                </svg>
              </span>
              {t(k)}
            </li>
          ))}
        </ul>

        <div className="temple-ridge mx-auto my-6 w-40" />

        {/* Auth options — guest FIRST and primary. */}
        <div className="grid gap-3">
          <button type="button" onClick={onEnter} className="btn-primary min-h-12 w-full text-base">
            {t('landing.guest')}
          </button>

          <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-slate-400">
            <span className="h-px flex-1 bg-slate-200" />
            {t('landing.or')}
            <span className="h-px flex-1 bg-slate-200" />
          </div>

          <button type="button" onClick={soon} className="btn-secondary relative min-h-12 w-full">
            {soonBadge}
            <GoogleIcon className="h-4 w-4" />
            {t('landing.google')}
          </button>
          <button type="button" onClick={soon} className="btn-secondary relative min-h-12 w-full">
            {soonBadge}
            <MailIcon className="h-4 w-4" />
            {t('landing.email')}
          </button>
          <button type="button" onClick={soon} className="btn-ghost relative min-h-11 w-full">
            {soonBadge}
            {t('landing.create')}
          </button>
        </div>
      </section>
    </div>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M21.6 12.23c0-.68-.06-1.36-.19-2.02H12v3.83h5.4a4.6 4.6 0 0 1-2 3.02v2.5h3.22c1.9-1.74 2.98-4.3 2.98-7.33Z" />
      <path d="M12 21.5c2.7 0 4.96-.9 6.62-2.42l-3.23-2.5c-.9.6-2.05.95-3.39.95-2.6 0-4.8-1.76-5.6-4.12H3.07v2.58A10 10 0 0 0 12 21.5Z" opacity=".8" />
      <path d="M6.4 13.4a6 6 0 0 1 0-3.8V7.02H3.07a10 10 0 0 0 0 8.96L6.4 13.4Z" opacity=".6" />
      <path d="M12 6.46c1.47 0 2.79.5 3.83 1.5l2.86-2.86A10 10 0 0 0 3.07 7.02L6.4 9.6c.8-2.36 3-4.13 5.6-4.13Z" opacity=".9" />
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
