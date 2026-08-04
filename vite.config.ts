import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// In dev (and preview), requests to /api/* are reverse-proxied to the
// upstream API so the browser sees a same-origin call. In production the
// same /api/* prefix is handled by nginx inside the container.
// This avoids the CORS preflight that the upstream API can't answer.
const apiProxyTarget = (env: Record<string, string>) =>
  env.API_UPSTREAM || env.VITE_API_UPSTREAM || 'https://rinabuoy13--khparser-api.modal.run';

export default defineConfig(({ mode }) => {
  // loadEnv with empty prefix gives us access to all VITE_/API_ vars from .env.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      host: '127.0.0.1',
      proxy: {
        '/api-meta': {
          target: env.METADATA_URL || 'http://localhost:8095',
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api-meta/, ''),
        },
        '/api-vllm': {
          target: env.VLLM_ADAPTER_URL || 'http://localhost:8090',
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api-vllm/, ''),
        },
        '/api': {
          target: apiProxyTarget(env),
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    },
    preview: {
      port: 4173,
      host: '127.0.0.1',
      proxy: {
        '/api-meta': {
          target: env.METADATA_URL || 'http://localhost:8095',
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api-meta/, ''),
        },
        '/api-vllm': {
          target: env.VLLM_ADAPTER_URL || 'http://localhost:8090',
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api-vllm/, ''),
        },
        '/api': {
          target: apiProxyTarget(env),
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    },
    build: {
      // Code-split heavy libraries so they only load when a tab needs them.
      // pdfjs is used by DocumentParser + Translated for client-side rasterization,
      // pdflib is used by the "Export .pdf" button, jszip is used by the
      // "Download all (.zip)" bundle.
      rollupOptions: {
        output: {
          manualChunks: {
            pdfjs: ['pdfjs-dist'],
            pdflib: ['pdf-lib'],
            jszip: ['jszip'],
            xlsx: ['xlsx'],
            docx: ['docx'],
          },
        },
      },
      chunkSizeWarningLimit: 1500,
    },
  };
});
