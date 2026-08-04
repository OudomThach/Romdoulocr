import { useState } from 'react';
import { metaClient, metaSession, notifyAuthChanged } from '@/lib/metaClient';
import { useToastStore } from '@/hooks/useToastStore';

/**
 * In-app login for the metadata service. Same session keys as the /portal app,
 * so signing in here signs you in there (and vice versa).
 */
export function LoginModal({ onClose }: { onClose: () => void }) {
  const toast = useToastStore((s) => s.push);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await metaClient.login(username.trim(), password);
      metaSession.save(res.token, res.user);
      notifyAuthChanged();
      toast('Signed in as ' + res.user.username, 'success');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="panel-raised w-full max-w-sm p-6">
        <h2 className="display text-lg">Metadata sign in</h2>
        <p className="mt-1 text-sm text-slate-600">View and edit extraction records.</p>
        <div className="mt-4 space-y-3">
          <input
            className="input"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
