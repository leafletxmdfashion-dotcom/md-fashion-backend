# anti-slop (vendored)

- Source: the `install-anti-slop` Claude Code skill bundle (`~/.claude/skills/install-anti-slop/assets/anti-slop`), copied by its `scripts/install.mjs` on 2026-10-14.
- Upstream repository and commit: unknown. The skill bundle was not a git checkout, so no commit could be recorded. Content fingerprint of the copied tree (sha256 of sorted per-file sha256 sums, first 16 hex): `4c3ff5432c582fdb`.
- Installed paths: `tools/oxlint/anti-slop/` (generic plugin, `index.ts`; Effect plugin present but not enabled since this repo has no `effect` dependency).
- Dependencies: `oxlint@1.88.0` and `@oxlint/plugins@1.88.0`, pinned exactly.
- Configuration: `.oxlintrc.json`; run with `npm run lint:slop`.
- Intentional deviations: none. Pre-existing findings in older code were left as-is (no cleanup requested); new code is written to pass.
