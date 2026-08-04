import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Records from "./pages/Records";
import RecordDetail from "./pages/RecordDetail";
import DocsPage from "./pages/DocsPage";
import LoginScreen from "./components/LoginScreen";
import { api, getToken, getUser, setSession } from "./api/client";
import { useTheme } from "./hooks/useTheme";

const nav = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/records", label: "Records", end: false },
  { to: "/docs", label: "API Docs", end: false },
];

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

function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
      <path d="M8 9v6M12 9v6M16 9v6" />
    </svg>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean>(() => getToken() !== null);
  const [user, setUser] = useState(getUser());
  const { theme, toggle: toggleTheme } = useTheme();

  useEffect(() => {
    const onAuthRequired = () => setAuthed(false);
    window.addEventListener("auth:required", onAuthRequired);
    return () => window.removeEventListener("auth:required", onAuthRequired);
  }, []);

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      /* session may already be invalid */
    }
    setSession(null);
    setAuthed(false);
  };

  if (!authed) {
    return (
      <div className="relative min-h-screen">
        <div className="cyber-grid" aria-hidden="true" />
        <div className="cyber-scan" aria-hidden="true" />
        <div className="absolute right-4 top-4 z-10">
          <button type="button" onClick={toggleTheme} className="btn-secondary px-3 py-2" title="Toggle theme" aria-label="Toggle theme">
            {theme === "dark" ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
          </button>
        </div>
        <LoginScreen
          onSuccess={() => {
            setUser(getUser());
            setAuthed(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen">
      <div className="cyber-grid" aria-hidden="true" />
      <div className="cyber-scan" aria-hidden="true" />

      <aside className="sticky top-0 z-10 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-white/70 backdrop-blur-md sm:flex">
        <div className="flex items-center gap-2.5 px-3 py-4">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/40 dark:drop-shadow-[0_0_10px_rgba(0,229,255,0.6)]">
            <BrandMark className="h-7 w-7" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight tracking-tight text-slate-950">
              Metadata <span className="text-accent dark:drop-shadow-[0_0_8px_rgba(0,229,255,0.7)]">Portal</span>
            </h1>
            <p className="truncate text-[11px] uppercase tracking-wider text-slate-500">Romdoul extraction records</p>
          </div>
        </div>
        <div className="temple-ridge mx-3 mb-2 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />

        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-2" aria-label="Primary">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => `nav-item w-full ${isActive ? "nav-item-active" : ""}`}
            >
              <span className="nav-icon shrink-0">
                <DatabaseIcon className="h-5 w-5" />
              </span>
              <span className="truncate">{n.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="space-y-2 border-t border-slate-200 px-3 py-3">
          <div className="flex items-center gap-2">
            <button type="button" onClick={toggleTheme} className="btn-secondary px-3 py-2" title="Toggle theme" aria-label="Toggle theme">
              {theme === "dark" ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
            </button>
            <button type="button" onClick={signOut} className="btn-ghost ml-auto" title="Sign out">
              Sign out
            </button>
          </div>
          <p className="px-1 text-[11px] text-slate-400">
            Signed in as <span className="font-medium text-slate-600 dark:text-slate-300">{user?.username ?? "—"}</span>
            {user?.role && <span className="badge ml-1.5 border-accent/30 bg-accent/10 text-accent">{user.role}</span>}
          </p>
          <p className="px-1 text-[11px] text-slate-400">
            API base: <code className="font-mono">/api-meta/api/v1</code> · docs at <code className="font-mono">/api/docs</code>
          </p>
        </div>
      </aside>

      <main className="relative z-10 min-w-0 flex-1">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/records" element={<Records />} />
          <Route path="/records/:id" element={<RecordDetail />} />
          <Route path="/docs" element={<DocsPage />} />
        </Routes>
      </main>
    </div>
  );
}
