// Secure server-side proxy: hosted SPA → this function → your Tailscale Funnel
// → vllm-adapter (home GPU). The funnel URL and shared token live ONLY in
// Netlify's server-side env (VLLM_FUNNEL_URL / ADAPTER_TOKEN, no VITE_ prefix),
// so neither is ever shipped in the browser bundle — the public can't discover
// the GPU endpoint or forge a request.
//
// Trade-off: synchronous Netlify Functions cap at ~10-26s and ~6MB bodies.
// Single image OCR fits comfortably; very large PDFs / pathological slow
// inferences may time out (the home nginx deployment has no such limit).

import dns from 'node:dns';

// Tailscale Funnel hosts advertise BOTH A and AAAA records. Netlify's Lambda
// egress can't reliably route IPv6, so an unforced resolver may pick the AAAA
// and fail with a bare "fetch failed". Prefer IPv4 so the connection lands.
dns.setDefaultResultOrder('ipv4first');

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

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('x-forwarded-host');
  if (token) headers.set('x-adapter-token', token);

  const init = { method: req.method, headers, signal: AbortSignal.timeout(9500) };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.arrayBuffer();
  }

  try {
    const resp = await fetch(target, init);
    const body = await resp.arrayBuffer();
    const outHeaders = new Headers(resp.headers);
    outHeaders.delete('content-encoding'); // fetch already decoded
    outHeaders.delete('transfer-encoding');
    return new Response(body, { status: resp.status, headers: outHeaders });
  } catch (e) {
    // Surface the real cause (ENETUNREACH / ETIMEDOUT / connect timeout / etc.)
    // so failures are diagnosable instead of a generic "fetch failed".
    const cause = e?.cause?.code || e?.cause?.message || e?.name || e?.message || 'unknown';
    return new Response(JSON.stringify({ detail: `vLLM proxy error: ${cause}` }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
};

export const config = { path: '/api-vllm/*' };
