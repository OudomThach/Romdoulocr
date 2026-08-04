import { useState } from "react";
import { api, setSession } from "../api/client";

export default function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(username.trim(), password);
      setSession(res.token, res.user);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative z-10 flex min-h-screen items-center justify-center p-4">
      <section className="panel-raised rise-in w-full max-w-md p-6 sm:p-10">
        <div className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-3xl bg-accent/10 text-accent ring-1 ring-accent/30 dark:drop-shadow-[0_0_20px_rgba(0,229,255,0.4)]">
          <svg viewBox="0 0 24 24" className="h-12 w-12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14a9 3 0 0 0 18 0V5" />
            <path d="M3 12a9 3 0 0 0 18 0" />
            <path d="M8 9v6M12 9v6M16 9v6" />
          </svg>
        </div>
        <h1 className="display text-center">
          Metadata <span className="text-accent dark:drop-shadow-[0_0_10px_rgba(0,229,255,0.7)]">Portal</span>
        </h1>
        <p className="mt-2 text-center text-sm text-slate-600">Sign in with your Romdoul account</p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Username</label>
            <input
              className="input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              placeholder="e.g. dara"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </div>
          {error && <div className="text-sm text-red-500">{error}</div>}
          <button className="btn-primary min-h-12 w-full text-base" type="submit" disabled={busy || !username || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </div>
  );
}
