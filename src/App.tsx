import { useState } from 'react';
import { BackendToggle } from '@/components/BackendToggle';
import { FallbackNotice } from '@/components/BackendNotice';
import { RenderQualityToggle } from '@/components/RenderQualityToggle';
import { RomdoulLogo } from '@/components/RomdoulLogo';
import { Sidebar } from '@/components/Sidebar';
import { HealthStatus } from '@/components/HealthStatus';
import { DocumentParserTab } from '@/components/tabs/DocumentParserTab';
import { TranslatedTab } from '@/components/tabs/TranslatedTab';
import { TableParserTab } from '@/components/tabs/TableParserTab';
import { OcrImageTab } from '@/components/tabs/OcrImageTab';
import { CompareTab } from '@/components/tabs/CompareTab';
import { HistoryTab } from '@/components/tabs/HistoryTab';
import { MetadataTab } from '@/components/tabs/MetadataTab';
import { Toaster } from '@/components/Toaster';
import { ShortcutsHelp } from '@/components/ShortcutsHelp';
import { LanguageToggle } from '@/components/LanguageToggle';
import { LandingGate } from '@/components/LandingGate';
import { SettingsModal } from '@/components/SettingsModal';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import { useLocale } from '@/lib/i18n';

interface TabDef {
  id: 'document' | 'translated' | 'table' | 'ocr' | 'compare' | 'history' | 'metadata';
  component: () => React.JSX.Element;
}

// Labels/hints live in the i18n dictionary (tab.<id> / tab.<id>.hint /
// short.<id>) so the whole shell follows the EN/ខ្មែរ switch.
// OCR first — it's the product's default screen.
const TABS: TabDef[] = [
  { id: 'ocr', component: () => <OcrImageTab /> },
  { id: 'document', component: () => <DocumentParserTab /> },
  { id: 'translated', component: () => <TranslatedTab /> },
  { id: 'table', component: () => <TableParserTab /> },
  { id: 'compare', component: () => <CompareTab /> },
  { id: 'history', component: () => <HistoryTab /> },
  { id: 'metadata', component: () => <MetadataTab /> },
];

const SESSION_KEY = 'romdoul.session';

function readSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return 'guest'; // storage blocked → don't trap the user on the gate
  }
}

export default function App() {
  const activeTab = useSettingsStore((s) => s.activeTab);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const { t } = useLocale();
  const activeTabForUi = TABS.some((t) => t.id === activeTab) ? activeTab : 'ocr';

  const [collapsed, setCollapsed] = useState(false);
  const [session, setSession] = useState<string | null>(readSession);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Guest gate — branded welcome screen until a session choice is made.
  if (!session) {
    return (
      <div className="relative flex min-h-full bg-transparent text-slate-950">
        <div className="cyber-grid" aria-hidden="true" />
        <div className="cyber-scan" aria-hidden="true" />
        <LandingGate
          onEnter={() => {
            try {
              localStorage.setItem(SESSION_KEY, 'guest');
            } catch {
              // storage blocked — session just won't persist
            }
            setSession('guest');
          }}
        />
        <Toaster />
      </div>
    );
  }

  return (
    // bg-transparent: let the body's neon canvas show through.
    <div className="relative flex min-h-full bg-transparent text-slate-950">
      {/* Cyber ambience — animated neon grid + scanline sweep behind everything. */}
      <div className="cyber-grid" aria-hidden="true" />
      <div className="cyber-scan" aria-hidden="true" />
      <Sidebar
        tabs={TABS.map((tab) => ({ id: tab.id, label: t(`tab.${tab.id}`), hint: t(`tab.${tab.id}.hint`) }))}
        activeTab={activeTabForUi}
        setActiveTab={(id) => setActiveTab(id as TabDef['id'])}
        renderIcon={(id, className) => <TabIcon id={id as TabDef['id']} className={className} />}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
      />

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        {/* Contextual top bar — current tab title + description + backend toggles. */}
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur-md supports-[backdrop-filter]:bg-white/70">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-2.5">
              {/* Compact brand mark on mobile (sidebar is hidden there). */}
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/40 sm:hidden">
                <RomdoulLogo className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold tracking-tight text-slate-950">{t(`tab.${activeTabForUi}`)}</h1>
                <p className="hidden truncate text-xs text-slate-500 sm:block">{t(`tab.${activeTabForUi}.hint`)}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <LanguageToggle />
              <BackendToggle />
              <RenderQualityToggle />
              <a
                href="/portal/"
                target="_blank"
                rel="noreferrer"
                title="Romdoul Data Sharing portal — Data management, Datasets, Explore"
                className="hidden h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 shadow-sm transition-all duration-150 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 active:scale-95 sm:flex"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M3 5v14a9 3 0 0 0 18 0V5" />
                  <path d="M3 12a9 3 0 0 0 18 0" />
                </svg>
                Portal
              </a>
              {/* Desktop gear — phones use the floating gear FAB bottom-right instead. */}
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                title={t('settings.title')}
                aria-label={t('settings.title')}
                className="hidden h-9 w-9 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition-all duration-150 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-950 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:grid"
              >
                <GearIcon className="h-4 w-4" />
              </button>
              {/* Health badge lives in the sidebar footer on desktop; show here on mobile. */}
              <div className="sm:hidden">
                <HealthStatus />
              </div>
            </div>
          </div>
        </header>

        {/* Wide cap so document/table/compare use the monitor instead of a
            narrow centered column (the OCR tab keeps its own max-w-3xl). */}
        <main className="mx-auto w-full max-w-[2200px] flex-1 px-4 py-7 pb-24 sm:px-6 sm:pb-7">
          <FallbackNotice />
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
      </div>

      {/* Mobile bottom nav — thumb-friendly tab switcher (phones only). */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden"
        aria-label="Primary"
      >
        <div className="grid grid-cols-7">
          {TABS.map((tab) => {
            const active = activeTabForUi === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
                  active ? 'text-accent dark:drop-shadow-[0_0_6px_rgba(0,229,255,0.7)]' : 'text-slate-500'
                }`}
              >
                <TabIcon id={tab.id} className="h-5 w-5" />
                {t(`short.${tab.id}`)}
              </button>
            );
          })}
          {/* Settings — 7th nav slot (was a floating FAB; user wanted it IN the bar). */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className={`flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
              settingsOpen ? 'text-accent dark:drop-shadow-[0_0_6px_rgba(0,229,255,0.7)]' : 'text-slate-500'
            }`}
          >
            <GearIcon className="h-5 w-5" />
            {t('short.settings')}
          </button>
        </div>
      </nav>

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onBackToWelcome={() => {
            try {
              localStorage.removeItem(SESSION_KEY);
            } catch {
              // ignore
            }
            setSettingsOpen(false);
            setSession(null);
          }}
        />
      )}

      <Toaster />
      <ShortcutsHelp />
    </div>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10.1 3.6V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z" />
    </svg>
  );
}

function TabIcon({ id, className }: { id: TabDef['id']; className?: string }) {
  const p = { className, fill: 'none' as const, stroke: 'currentColor', strokeWidth: 2, viewBox: '0 0 24 24' };
  switch (id) {
    case 'document':
      return <svg {...p}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h4" /><path d="M9 13h6M9 17h6" strokeLinecap="round" /></svg>;
    case 'translated':
      return <svg {...p}><path d="M4 5h7M7.5 5v2.5A5.5 5.5 0 0 1 4 12m3.5-4.5A7 7 0 0 0 11 12" strokeLinecap="round" /><path d="m13 19 3.5-8L20 19m-6-2.5h5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case 'table':
      return <svg {...p}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 10h16M10 5v14" /></svg>;
    case 'ocr':
      return <svg {...p}><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" strokeLinecap="round" /><path d="M8 12h8" strokeLinecap="round" /></svg>;
    case 'compare':
      return <svg {...p}><path d="M12 4v16" strokeLinecap="round" /><rect x="3" y="8" width="6" height="8" rx="1.5" /><rect x="15" y="8" width="6" height="8" rx="1.5" /></svg>;
    case 'history':
      return <svg {...p}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" strokeLinecap="round" /></svg>;
    case 'metadata':
      return <svg {...p}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></svg>;
  }
}
