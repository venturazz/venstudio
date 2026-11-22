# Vendored style packs

A pinned copy of venturazz/venstudio-styles (commit in `lock.json`), written by `scripts/sync-styles.mjs`. Do not edit
anything here by hand: change the pack in the styles repo, then run

```
node scripts/sync-styles.mjs --from ../venstudio-styles --commit <commit>
```

and open a "bump styles to <commit>" PR. `node scripts/sync-styles.mjs --check` (run in CI) fails when a file here
differs from `lock.json`. This README is venstudio's own and is kept by the sync. See `docs/style-packs.md`.
