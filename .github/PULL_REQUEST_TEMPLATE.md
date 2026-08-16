## What
<!-- one paragraph: what this change does -->

## Why
<!-- the problem it solves -->

## How tested
<!-- commands run + results; adapters: `python -m py_compile app.py`; SPA: `npm run build` -->

## Checklist
- [ ] SPA: `npm run typecheck` / `npm run build` passes
- [ ] Adapters: ruff clean (`ruff check --config 'line-length=120' --ignore B008,E501 <adapter>`)
- [ ] nginx.conf updated if routes changed
- [ ] No secrets committed (`.env`, `ADAPTER_TOKEN` never in source)
- [ ] README/ARCHITECTURE.md updated if surface changed
