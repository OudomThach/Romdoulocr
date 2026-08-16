# Contributing

Thanks for contributing to Romdoul OCR.

## Structure (see AGENTS.md)

- All SPA source lives in `src/` — never add `.tsx`/`.ts` at the repo root
- Adapters live flat: `<name>-adapter/app.py + Dockerfile + requirements.txt`
- `docs/ARCHITECTURE.md` has the system diagram + ADRs — keep it in sync

## Workflow

1. Branch from `main`: `feat/<name>` or `fix/<name>`
2. Conventional commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
3. Gates before pushing:

```bash
# SPA
npm run typecheck && npm run build

# Python adapters (each of vllm/lens/tidy/jobs/status)
python -m py_compile <adapter>/app.py
ruff check --config 'line-length=120' --ignore B008,E501 <adapter>
```

4. Open a PR against `main` (use the PR template)

## Conventions

- Components `PascalCase.tsx` in `src/components/`; hooks `useXxx.ts`; libs `camelCase.ts`
- Adapters speak the khparser contract — changing the contract means updating
  the SPA api layer + every adapter + nginx.conf
- `ADAPTER_TOKEN` / API keys come from env, never source
- New backend routes: add nginx location + `docs/ARCHITECTURE.md` engine matrix
