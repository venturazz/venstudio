# Hermes-side artifacts for venstudio

Hermes is the studio's front door: it owns the model keys, the image chain, the TTS chain and now
the video chain. Everything in this directory is meant to be copied into the Hermes runtime
(`$HERMES_HOME`, `/opt/data` in the container), not run from here.

## Layout

```
hermes/plugins/video_gen/agnes/    ->  $HERMES_HOME/plugins/video_gen/agnes/
```

## Installing the video backend

```bash
cp -r hermes/plugins/video_gen/agnes "$HERMES_HOME/plugins/video_gen/agnes"
hermes plugins enable video_gen/agnes
hermes config set video_gen.provider agnes
hermes config set video_gen.model agnes-video-2.5-flash
hermes tools enable --platform cli video_gen        # the API-server surface venstudio calls
hermes tools enable --platform telegram video_gen
```

`AGNES_API_KEYS` (comma or space separated) must be present in the secret scope, the environment or
`$HERMES_HOME/.env`. The plugin rotates the pool.

Two things bite when this is set up wrong, and both look like a broken API:

- With the plugin enabled but `video_gen` absent from `plugins.enabled`, nothing registers and the
  registry stays empty.
- With the provider registered but the `video_gen` toolset disabled for the calling platform, the
  `video_generate` tool is never offered. `/v1/toolsets` is the check.

## Patches this project depends on

These live in the Hermes runtime and are **not** in this repo, because they are edits to code that
ships with Hermes. Re-apply them after an upgrade, or port them upstream:

- `plugins/image_gen/9router/__init__.py` — reference-image chain (`_i2i_chain`: Agnes, then
  SenseNova, then ModelScope, ordered by measured latency), MIME sniffed from magic bytes instead of
  the extension, `capabilities().max_reference_images` raised from 0 to 5 (the 0 hid reference
  editing entirely), and `images` accepted on the Agnes generations call.
- `plugins/tts/capcut/__init__.py` — Kokoro added as chain layer 2 (it was missing, so the TTS
  fallback never reached it), and `import yaml` removed from the Gemini layer, which was raising
  `ModuleNotFoundError` and silently disabling both layer 3 and the 9Router base lookup.

See `docs/research/05-hermes-asset-bridge.md` for the measurements behind each.
