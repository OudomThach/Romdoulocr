// Metadata service client — talks to /api-meta/api/v1 (same-origin proxy
// through the romdoul nginx → metadata-service). Sessions are shared with the
// standalone portal via the same localStorage keys (metadata_token/user), so
// signing in here signs you in there too.

const META_BASE = '/api-meta/api/v1';

export interface MetaUser {
  username: string;
  role: string;
}

export interface MetaRecord {
  id: string;
  type: string;
  status: string;
  domain: string | null;
  business_date: string | null;
  tags: string[] | null;
  source: Record<string, unknown> | null;
  audit: Record<string, unknown> | null;
  pipeline: Record<string, unknown> | null;
  record: Record<string, unknown> | null;
  business: Record<string, unknown> | null;
  data: Record<string, unknown>;
  created_at: string;
  created_by: string;
  edited_at: string | null;
  edited_by: string | null;
  edit_count: number;
  source_model: string | null;
  source_system: string | null;
}

export interface MetaPage {
  items: MetaRecord[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface MetaStats {
  total: number;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  by_domain: Record<string, number>;
  edited: number;
  verified: number;
  coverage_avg: number | null;
  per_day: Record<string, number>[];
}

export interface MetaHistoryEvent {
  id: number;
  action: string;
  actor: string;
  at: string;
  snapshot: Record<string, unknown>;
}

export interface MetaQuery {
  page?: number;
  page_size?: number;
  type?: string;
  domain?: string;
  status?: string;
  tag?: string;
  business_from?: string;
  business_to?: string;
  q?: string;
  sort?: string;
}

const TOKEN_KEY = 'metadata_token';
const USER_KEY = 'metadata_user';

// Snapshot caching: useSyncExternalStore REQUIRES getSnapshot to return a
// stable reference until the underlying value changes. JSON.parse creates a
// new object every call — without caching, React sees a "changed" value on
// every render, loops forever and the UI goes blank the moment a user is
// signed in. Cache by raw storage string.
let cachedTokenRaw: string | null = null;
let cachedToken: string | null = null;
let cachedUserRaw: string | null = null;
let cachedUser: MetaUser | null = null;

export const metaSession = {
  token(): string | null {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (raw !== cachedTokenRaw) {
        cachedTokenRaw = raw;
        cachedToken = raw;
      }
      return cachedToken;
    } catch {
      return null;
    }
  },
  user(): MetaUser | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      if (raw !== cachedUserRaw) {
        cachedUserRaw = raw;
        cachedUser = raw ? (JSON.parse(raw) as MetaUser) : null;
      }
      return cachedUser;
    } catch {
      return null;
    }
  },
  save(token: string, user: MetaUser): void {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      cachedTokenRaw = token;
      cachedToken = token;
      cachedUserRaw = JSON.stringify(user);
      cachedUser = user;
    } catch {
      // storage blocked — session just won't persist
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch {
      // ignore
    }
    cachedTokenRaw = null;
    cachedToken = null;
    cachedUserRaw = null;
    cachedUser = null;
  },
};

let authListeners = new Set<() => void>();
export function subscribeAuth(cb: () => void): () => void {
  authListeners.add(cb);
  return () => {
    authListeners.delete(cb);
  };
}

export function notifyAuthChanged(): void {
  authListeners.forEach((cb) => cb());
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  const token = metaSession.token();
  if (token) headers['X-Session-Token'] = token;
  const res = await fetch(`${META_BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    metaSession.clear();
    notifyAuthChanged();
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body?.error?.message ?? body?.detail ?? message;
    } catch {
      // keep default
    }
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export const metaClient = {
  login(username: string, password: string): Promise<{ token: string; user: MetaUser }> {
    return request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  },
  logout(): Promise<{ ok: boolean }> {
    return request('/auth/logout', { method: 'POST' });
  },
  me(): Promise<MetaUser> {
    return request('/auth/me');
  },
  listRecords(p: MetaQuery): Promise<MetaPage> {
    return request(`/records${qs({ ...p })}`);
  },
  getRecord(id: string): Promise<MetaRecord> {
    return request(`/records/${encodeURIComponent(id)}`);
  },
  recordHistory(id: string): Promise<MetaHistoryEvent[]> {
    return request(`/records/${encodeURIComponent(id)}/history`);
  },
  patchRecord(id: string, body: Record<string, unknown>): Promise<MetaRecord> {
    return request(`/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
  deleteRecord(id: string): Promise<void> {
    return request(`/records/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  stats(): Promise<MetaStats> {
    return request('/stats');
  },
  meta(): Promise<{ types: string[]; domains: string[] }> {
    return request('/meta');
  },
  exportUrl(format: 'csv' | 'json', p: MetaQuery = {}): string {
    return `${META_BASE}/export${qs({ format, ...p })}`;
  },
};
