// Secure server-side proxy: hosted SPA → this function → your Tailscale Funnel
// → vllm-adapter (home GPU). The funnel URL and shared token live ONLY in
// Netlify's server-side env (VLLM_FUNNEL_URL / ADAPTER_TOKEN, no VITE_ prefix),
// so neither is ever shipped in the browser bundle.
//
// DNS workaround: Netlify's Lambda getaddrinfo refuses to resolve Tailscale
// Funnel *.ts.net hostnames (ENOTFOUND) even though public resolvers do. So we
// resolve the host ourselves via DoH to 1.1.1.1 (an IP literal — no getaddrinfo
// needed) and hand undici a custom `lookup` that returns that IPv4. The request
// URL keeps the hostname, so TLS SNI + certificate validation still work.
//
// Trade-off: synchronous Netlify Functions cap at ~10-26s and ~6MB bodies.
// Single-image OCR fits; very large PDFs / slow inference may time out.

import { Agent, fetch as uFetch } from 'undici';

// Cache resolved IPs briefly so we don't DoH-resolve on every request.
const ipCache = new Map(); // host -> { ip, exp }

async function resolveViaDoH(host) {
  const hit = ipCache.get(host);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.ip;
  const r = await uFetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(4000),
  });
  const j = await r.json();
  const ip = (j.Answer || []).find((a) => a.type === 1)?.data;
  if (!ip) throw new Error(`DoH: no A record for ${host}`);
  ipCache.set(host, { ip, exp: now + 60_000 });
  return ip;
}

export default async (req) => {
  const base = (process.env.VLLM_FUNNEL_URL || '').replace(/\/$/, '');
  const token = process.env.ADAPTER_TOKEN || '';
  if (!base) {
    return new Response(JSON.stringify({ detail: 'vLLM backend not configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/vllm|api-vllm)/, '') || '/';
  const target = `${base}${path}${url.search}`;
  const host = new URL(base).hostname;

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('x-forwarded-host');
  if (token) headers.set('x-adapter-token', token);

  const init = { method: req.method, headers, signal: AbortSignal.timeout(9500) };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Buffer.from(await req.arrayBuffer());
  }

  try {
    const ip = await resolveViaDoH(host);
    // Custom lookup → connect to the DoH-resolved IPv4. The URL still carries
    // the hostname, so SNI + cert validation use the real name.
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _opts, cb) => cb(null, [{ address: ip, family: 4 }]),
      },
    });
    const resp = await uFetch(target, { ...init, dispatcher });
    const body = Buffer.from(await resp.arrayBuffer());
    const outHeaders = new Headers(resp.headers);
    outHeaders.delete('content-encoding');
    outHeaders.delete('transfer-encoding');
    return new Response(body, { status: resp.status, headers: outHeaders });
  } catch (e) {
    const cause = e?.cause?.code || e?.cause?.message || e?.name || e?.message || 'unknown';
    return new Response(JSON.stringify({ detail: `vLLM proxy error: ${cause}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
};

export const config = { path: '/api-vllm/*' };
