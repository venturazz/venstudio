# Vendored style packs

A pinned copy of venturazz/venstudio-styles (commit in `lock.json`), written by `scripts/sync-styles.mjs`. Do not edit
anything here by hand: change the pack in the styles repo, then run

```
node scripts/sync-styles.mjs --from ../venstudio-styles --commit <commit>
```

and open a "bump styles to <commit>" PR. `node scripts/sync-styles.mjs --check` (run in CI) fails when a file here
differs from `lock.json`. This README is venstudio's own and is kept by the sync. See `docs/style-packs.md`.

Skills (`skills/curated/`, `skills/candidate/`, `skills/kits/`) are vendored the same way and listed in `lock.json` (`skills`, `kits`). The portal serves them to workers as `/install/agent-skills.json` (`docs/muse-agent-tasks.md`).
