import { useSyncExternalStore } from 'react';
import { SettingToggle } from '@/components/ExtractionSettingsCard';
import { LanguageToggle } from '@/components/LanguageToggle';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import { useTheme } from '@/hooks/useTheme';
import { getMutedSnapshot, subscribeMute, toggleMuted } from '@/lib/sound';
import { useLocale } from '@/lib/i18n';

/**
 * Global settings sheet (gear button in the top bar). Doubles as the only
 * place on PHONES to reach theme/sound — the sidebar (their desktop home)
 * is hidden below the sm breakpoint.
 */
export function SettingsModal({
  onClose,
  onBackToWelcome,
}: {
  onClose: () => void;
  onBackToWelcome: () => void;
}) {
  const { t } = useLocale();
  const { theme, setTheme } = useTheme();
  const muted = useSyncExternalStore(subscribeMute, getMutedSnapshot, () => false);
  const extraction = useSettingsStore((s) => s.extraction);
  const setExtraction = useSettingsStore((s) => s.setExtraction);
  const useCtc = useSettingsStore((s) => s.ocr.useCtc);
  const setOcr = useSettingsStore((s) => s.setOcr);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.title')}
      onClick={onClose}
    >
      <section
        className="panel-raised toast-in max-h-[90vh] w-full max-w-md overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-slate-950">{t('settings.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-slate-950"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="grid gap-3">
          {/* Language */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <span className="text-sm font-medium text-slate-950">{t('settings.language')}</span>
            <LanguageToggle />
          </div>

          <SettingToggle
            label={t('settings.dark')}
            hint={t('settings.dark.hint')}
            checked={theme === 'dark'}
            onChange={(v) => setTheme(v ? 'dark' : 'light')}
          />
          <SettingToggle
            label={t('settings.sound')}
            hint={t('settings.sound.hint')}
            checked={!muted}
            onChange={(v) => {
              if (v === muted) toggleMuted();
            }}
          />

          <div className="mt-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            {t('settings.extraction')}
          </div>
          <SettingToggle
            label={t('ocr.highRes')}
            hint={t('ocr.highRes.hint')}
            checked={extraction.highRes}
            onChange={(v) => setExtraction({ highRes: v })}
          />
          <SettingToggle
            label={t('ocr.fullPage')}
            hint={t('ocr.fullPage.hint')}
            checked={extraction.fullPageOcr}
            onChange={(v) => setExtraction({ fullPageOcr: v })}
          />
          <SettingToggle
            label={t('ocr.ctc')}
            hint={t('ocr.ctc.hint')}
            checked={useCtc}
            onChange={(v) => setOcr({ useCtc: v })}
          />

          <div className="mt-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            {t('settings.account')}
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <span className="badge border-accent/40 bg-accent/10 text-accent">{t('settings.guest')}</span>
            <button type="button" onClick={onBackToWelcome} className="btn-ghost text-xs">
              {t('settings.backToWelcome')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
