import { useLocale, type Locale } from '@/lib/i18n';

/**
 * EN | ខ្មែរ segmented pill — switches the UI language. Lives in the top bar so
 * it's reachable on both desktop and mobile.
 */
export function LanguageToggle() {
  const { locale, setLocale } = useLocale();

  const seg = (value: Locale, label: string) => {
    const active = locale === value;
    return (
      <button
        type="button"
        onClick={() => setLocale(value)}
        aria-pressed={active}
        className={`px-2.5 py-1.5 text-xs font-semibold transition-colors ${
          active
            ? 'bg-accent text-white shadow-[0_0_14px_-2px_rgb(var(--c-accent)/0.7)] dark:text-slate-950'
            : 'text-slate-500 hover:text-slate-950'
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      className="flex overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
      role="group"
      aria-label="Interface language"
      title="Interface language"
    >
      {seg('en', 'EN')}
      {seg('km', 'ខ្មែរ')}
    </div>
  );
}
