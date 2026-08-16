# Romdoul OCR SPA — repo conventions

## Structure (do not regress)

- **All app source lives in `src/`**: `src/components/` (PascalCase.tsx),
  `src/components/tabs/` (tab screens), `src/hooks/` (useXxx.ts),
  `src/lib/` (camelCase.ts modules), `src/types/`.
- `index.html` loads `/src/main.tsx`; tsconfig includes ONLY `src/`.
- **Never create .tsx/.ts files at the repo root** — root holds only
  `vite.config.ts`, `vite-env.d.ts`, `index.html`, config files, and deploy
  files (nginx.conf, netlify.toml, Dockerfile).
- Adapters live flat: `<name>-adapter/app.py + Dockerfile + requirements.txt`
  with a matching `docker-compose.<name>-adapter.yml` (deployment-coupled —
  do not move without updating every compose build context).
- `ops/` = operational scripts (keepalive, swagger build). `dist/` and
  `*.log` are gitignored build artifacts.

## Naming

| Kind | Convention | Example |
|---|---|---|
| React components | PascalCase.tsx | `HealthStatus.tsx` |
| Hooks | useXxx.ts | `useHealth.ts` |
| Lib modules | camelCase.ts | `pdfProcessing.ts` |
| Adapters | kebab-case dir | `vllm-adapter/` |
| Docker compose | docker-compose.<name>.yml | `docker-compose.vllm-adapter.yml` |

## Rules

- No duplicate files: if a component exists in `src/components/`, delete the
  copy elsewhere — one source of truth per file.
- Keep `src/` self-contained (no `../` imports leaving src).
- API layer: `src/lib/api.ts` + `src/lib/metaClient.ts`; backend switching in
  `src/lib/backend.ts`; env via `VITE_*` / `API_*` (see vite.config.ts proxy).
