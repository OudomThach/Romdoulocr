import { useSyncExternalStore } from 'react';
import { HealthStatus } from '@/components/HealthStatus';
import { BackendToggle } from '@/components/BackendToggle';
import { RenderQualityToggle } from '@/components/RenderQualityToggle';
import { AngkorWatLogo } from '@/components/AngkorWatLogo';
import { DocumentParserTab } from '@/components/tabs/DocumentParserTab';
import { TranslatedTab } from '@/components/tabs/TranslatedTab';
import { TableParserTab } from '@/components/tabs/TableParserTab';
import { OcrImageTab } from '@/components/tabs/OcrImageTab';
import { CompareTab } from '@/components/tabs/CompareTab';
import { HistoryTab } from '@/components/tabs/HistoryTab';
import { Toaster } from '@/components/Toaster';
import { ShortcutsHelp } from '@/components/ShortcutsHelp';
import { useTheme } from '@/hooks/useTheme';
import { getMutedSnapshot, subscribeMute, toggleMuted } from '@/lib/sound';
import { useSettingsStore } from '@/hooks/useSettingsStore';

interface TabDef {
  id: 'document' | 'translated' | 'table' | 'ocr' | 'compare' | 'history';
  label: string;
  component: () => React.JSX.Element;
}

const TABS: TabDef[] = [
  { id: 'document', label: 'Parse Document', component: () => <DocumentParserTab /> },
  { id: 'translated', label: 'Parse + Translate', component: () => <TranslatedTab /> },
  { id: 'table', label: 'Parse Table', component: () => <TableParserTab /> },
  { id: 'ocr', label: 'OCR Image', component: () => <OcrImageTab /> },
  { id: 'compare', label: 'Compare', component: () => <CompareTab /> },
  { id: 'history', label: 'History', component: () => <HistoryTab /> },
];

export default function App() {
  const activeTab = useSettingsStore((s) => s.activeTab);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const activeTabForUi = TABS.some((t) => t.id === activeTab) ? activeTab : 'document';

  const { theme, toggle: toggleTheme } = useTheme();
  const muted = useSyncExternalStore(subscribeMute, getMutedSnapshot, () => false);

  const iconBtn =
    'grid h-9 w-9 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition-all duration-150 hover:bg-slate-50 hover:text-slate-950 hover:border-slate-300 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

  return (
    <div className="flex min-h-full flex-col bg-slate-50 text-slate-950">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur-md supports-[backdrop-filter]:bg-white/70">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-900/5 ring-1 ring-slate-900/10 dark:bg-amber-400/5 dark:ring-amber-400/30">
              <AngkorWatLogo className="h-6 w-6 text-slate-900 dark:text-amber-300 dark:drop-shadow-[0_0_7px_rgba(251,191,36,0.65)]" />
            </div>
            <h1 className="truncate text-sm font-semibold tracking-tight text-slate-950">
              Khmer Document Parser
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <BackendToggle />
            <RenderQualityToggle />
            <button
              type="button"
              onClick={() => toggleMuted()}
              className={iconBtn}
              title={muted ? 'Sound off — click to enable' : 'Sound on — click to mute'}
              aria-label={muted ? 'Unmute sound' : 'Mute sound'}
              aria-pressed={muted}
            >
              {muted ? <SoundOffIcon className="h-4 w-4" /> : <SoundOnIcon className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className={iconBtn}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
            </button>
            <HealthStatus />
          </div>
        </div>
        <nav className="mx-auto max-w-[1600px] px-2 sm:px-6">
          <div className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => {
              const active = activeTabForUi === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex shrink-0 items-center whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? 'nav-tab-active border-accent text-slate-950'
                      : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-950'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-7 sm:px-6">
        {/* Keep the work tabs MOUNTED and just hide the inactive ones, so an
            in-progress extraction / result doesn't get thrown away when you
            switch tabs. Only a full page refresh resets them (in-memory state).
            History is the exception: it has no live state to lose and must
            re-read localStorage each visit, so it mounts only when active. */}
        {TABS.filter((t) => t.id !== 'history').map((t) => (
          <div key={t.id} hidden={activeTabForUi !== t.id}>
            {t.component()}
          </div>
        ))}
        {activeTabForUi === 'history' && <HistoryTab />}
      </main>

      <Toaster />
      <ShortcutsHelp />
    </div>
  );
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SoundOnIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

function SoundOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="m23 9-6 6M17 9l6 6" />
    </svg>
  );
}
