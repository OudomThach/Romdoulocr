export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface RecordOut {
  id: string;
  schema_version: string;
  type: string;
  domain: string | null;
  status: string;
  business_date: string | null;
  tags: string[] | null;
  source: Record<string, unknown> | null;
  audit: Record<string, unknown> | null;
  pipeline: Record<string, unknown> | null;
  record: Record<string, unknown> | null;
  business: Record<string, unknown> | null;
  data: Record<string, unknown>;
  envelope: Record<string, unknown>;
  created_at: string;
  created_by: string;
  edited_at: string | null;
  edited_by: string | null;
  edit_count: number;
  source_model: string | null;
  source_system: string | null;
}

export interface Stats {
  total: number;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  by_domain: Record<string, number>;
  edited: number;
  verified: number;
  coverage_avg: number | null;
  per_day: Record<string, number>[];
}

export interface Meta {
  types: string[];
  domains: string[];
}

export interface QueryParams {
  page?: number;
  page_size?: number;
  type?: string;
  domain?: string;
  status?: string;
  tag?: string;
  business_from?: string;
  business_to?: string;
  created_from?: string;
  created_to?: string;
  q?: string;
  sort?: string;
}

// The portal is served at /portal on the shared Romdoul host, where the API
// lives behind the /api-meta prefix (romdoul nginx → metadata-service). The
// service also accepts /api-meta directly, so this one base works everywhere:
// public netlify, localhost:8181/portal, and direct :8095.
const API = "/api-meta/api/v1";
const TOKEN_KEY = "metadata_token";
const USER_KEY = "metadata_user";

export interface PortalUser {
  username: string;
  role: string;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): PortalUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as PortalUser) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string | null, user?: PortalUser): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (token) headers["X-Session-Token"] = token;
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && token) {
    setSession(null);
    window.dispatchEvent(new Event("auth:required"));
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      message = body?.error?.message ?? body?.detail ?? message;
    } catch {
      /* keep default message */
    }
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export const api = {
  login: (username: string, password: string) =>
    http<{ token: string; user: PortalUser }>(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
  logout: () => http<{ ok: boolean }>(`${API}/auth/logout`, { method: "POST" }),
  me: () => http<PortalUser>(`${API}/auth/me`),
  listRecords: (p: QueryParams) =>
    http<Page<RecordOut>>(`${API}/records${qs({ ...p })}`),
  getRecord: (id: string) => http<RecordOut>(`${API}/records/${encodeURIComponent(id)}`),
  patchRecord: (id: string, body: Record<string, unknown>) =>
    http<RecordOut>(`${API}/records/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  deleteRecord: (id: string) => http<void>(`${API}/records/${encodeURIComponent(id)}`, { method: "DELETE" }),
  stats: () => http<Stats>(`${API}/stats`),
  meta: () => http<Meta>(`${API}/meta`),
  exportUrl: (format: "csv" | "json", p: QueryParams) =>
    `${API}/export${qs({ format, ...p })}`,
};
