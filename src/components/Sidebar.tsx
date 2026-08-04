import { useSyncExternalStore } from 'react';
import { RomdoulLogo } from '@/components/RomdoulLogo';
import { HealthStatus } from '@/components/HealthStatus';
import { useTheme } from '@/hooks/useTheme';
import { getMutedSnapshot, subscribeMute, toggleMuted } from '@/lib/sound';
import { useLocale } from '@/lib/i18n';

export interface SidebarTab {
  id: string;
  label: string;
  hint: string;
}

/**
 * Desktop workspace sidebar — replaces the old horizontal text-tab bar.
 * Brand block (larger Angkor mark + wordmark) → nav rows with a gold→jade
 * active indicator → footer with theme / sound toggles and the health badge.
 * Collapses to a 64px icon rail. Mobile keeps the bottom-nav in App.tsx.
 */
export function Sidebar({
  tabs,
  activeTab,
  setActiveTab,
  renderIcon,
  collapsed,
  onToggleCollapsed,
}: {
  tabs: SidebarTab[];
  activeTab: string;
  setActiveTab: (id: string) => void;
  renderIcon: (id: string, className: string) => React.ReactNode;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { theme, toggle: toggleTheme } = useTheme();
  const { t } = useLocale();
  const muted = useSyncExternalStore(subscribeMute, getMutedSnapshot, () => false);

  const iconBtn =
    'grid h-9 w-9 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition-all duration-150 hover:bg-slate-50 hover:text-slate-950 hover:border-slate-300 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

  return (
    <aside
      className={`sticky top-0 z-10 hidden h-screen shrink-0 flex-col border-r border-slate-200 bg-white/70 backdrop-blur-md transition-[width] duration-200 sm:flex ${
        collapsed ? 'w-16' : 'w-64'
      }`}
    >
      {/* Brand block */}
      <div className="flex items-center gap-2.5 px-3 py-4">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/40 dark:drop-shadow-[0_0_10px_rgba(0,229,255,0.6)]">
          <RomdoulLogo className="h-7 w-7" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight tracking-tight text-slate-950">
              Romdoul <span className="text-accent dark:drop-shadow-[0_0_8px_rgba(0,229,255,0.7)]">OCR</span>
            </h1>
            <p className="truncate text-[11px] uppercase tracking-wider text-slate-500">{t('brand.tagline')}</p>
          </div>
        )}
      </div>
      {!collapsed && <div className="temple-ridge mx-3 mb-2" />}

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-2" aria-label="Primary">
        {tabs.map((t) => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              aria-current={active ? 'page' : undefined}
              title={collapsed ? t.label : t.hint}
              className={`nav-item w-full ${active ? 'nav-item-active' : ''} ${collapsed ? 'justify-center' : ''}`}
            >
              <span className="nav-icon shrink-0">{renderIcon(t.id, 'h-5 w-5')}</span>
              {!collapsed && <span className="truncate">{t.label}</span>}
            </button>
          );
        })}
      </nav>

      {/* Footer: toggles + health */}
      <div className="space-y-2 border-t border-slate-200 px-3 py-3">
        <div className={`flex items-center gap-2 ${collapsed ? 'flex-col' : ''}`}>
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
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={`${iconBtn} ${collapsed ? '' : 'ml-auto'}`}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <ChevronIcon className={`h-4 w-4 transition-transform ${collapsed ? 'rotate-180' : ''}`} />
          </button>
        </div>
        {!collapsed && (
          <a
            href="/portal"
            target="_blank"
            rel="noreferrer"
            className="nav-item w-full"
            title="Metadata portal — extraction records, stats and exports (login required)"
          >
            <span className="nav-icon shrink-0">
              <DatabaseIcon className="h-5 w-5" />
            </span>
            <span className="truncate">Metadata</span>
          </a>
        )}
        {!collapsed && (
          <div className="pt-1">
            <HealthStatus />
          </div>
        )}
      </div>
    </aside>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function DatabaseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
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
