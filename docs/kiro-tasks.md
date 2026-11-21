# Instruksi untuk Kiro

Branch: **`feat/portal-foundation`**. Baca ini sebagai tugas, bukan sebagai latar belakang.

## Konteks

Sesi Hermes (Genevieve) baru saja menambahkan jalur eksekusi video ke studio: `VideoRequest` +
`videoPrompt`, `planClipRequests`, parser video (`parseVideoReply`/`sniffVideo`/`videoIssues`/
`clipSecondsIssues`), executor `lib/server/executors/hermes-video.ts`, migrasi
`0012_video_assets.sql`, plugin `hermes/plugins/video_gen/agnes/`, dan `docs/handover-kiro.md`.
294 tes unit hijau.

Yang **belum pernah terjadi**: typecheck, eksekusi migrasi, restart gateway, deploy media host,
dan satu job end-to-end.

## Aturan

1. **Jangan format ulang atau rapikan `apps/portal/lib/studio/**` secara massal.** 294 tes
   bergantung padanya, dan diff besar menyembunyikan perubahan perilaku di antara spasi.
2. **Empat berkas tumpang tindih** dengan pekerjaan pacing yang belum di-push:
   `lib/server/endpoint-health.ts`, `lib/server/executors/hermes-image.ts`,
   `lib/server/production.ts`, `lib/studio/endpoint-health.ts`. Perubahan Hermes di sana hanya
   empat baris, jadi resolusi konfliknya sepele — jangan tulis ulang berkasnya.
3. **Jangan percaya peringatan LSP** soal `clipSecondsIssues`, `sniffVideo`, `videoIssues`,
   `parseVideoReply`, `AGNES_CLIP_SECONDS`. LSP sesi Hermes basi dan melaporkannya tidak ada;
   tes yang mengimpornya hijau.

## P0 — amankan pohon kerja

```bash
git add -A && git commit -m "wip sebelum pull"
git pull
```

## P1 — typecheck (belum pernah dijalankan sama sekali)

```bash
pnpm install
pnpm -C apps/portal exec tsc -p tsconfig.json --noEmit
```

Berkas yang paling mungkin mengeluh: `lib/server/executors/hermes-video.ts` (belum pernah
di-compile). Pelaporan apa adanya lebih berguna daripada perbaikan diam-diam: **jangan ubah tanda
tangan di `lib/studio/**` untuk membuat error hilang tanpa melaporkannya.**

Petunjuk: pemakaian `hermesText` di executor itu identik baris-per-baris dengan `hermes-image.ts`
yang sudah ter-compile, jadi error (kalau ada) akan berada di tanda tangan fungsi baru, bukan di
pemakaian API.

## P2 — migrasi

```bash
psql "$DATABASE_URL" -f apps/portal/db/migrations/0012_video_assets.sql
psql "$DATABASE_URL" -c "\d+ endpoint_health"
psql "$DATABASE_URL" -c "\d+ asset_providers"
```

Bukti yang diminta: CHECK memuat `video`, **dan tidak ada CHECK `kind` kedua yang tersisa**.
Kalau dua CHECK muncul, blok `DO` gagal drop — laporkan, jangan hapus manual. Migrasi yang sukses
tapi tidak mengubah apa pun adalah mode gagal yang justru dicegah file ini.

## P3 — nyalakan pintu Hermes

```bash
s6-svc -r /run/service/gateway-default      # di container Hermes
curl -sS localhost:8642/v1/toolsets -H "Authorization: Bearer $API_SERVER_KEY" | grep video_gen
```

Bukti: `video_gen enabled: true`. Provider-nya sudah terdaftar sebelum restart
(`agent.log`: `Plugin 'agnes' registered video_gen provider: agnes`) — yang belum aktif hanya
toolset-nya, karena `platform_toolsets` dibaca saat gateway start.

## P4 — media host

Deploy `deploy/hermes-files.nginx.conf` + `deploy/hermes-files.compose.yml`
(lihat `docs/deploy-hermes-media.md`).

Verifikasi: `/img/`, `/tts/`, `/audio/`, `/clip/` melayani berkasnya, dan `/` menjawab 404.
**Jangan pernah root-kan server ini di `/opt/data/cache`** — di situ ada `cache/canva_tokens/`.

## P5 — job end-to-end

Hanya setelah P0–P4. Belum pernah dijalankan.

## Lapor balik

Untuk setiap P: perintah, keluaran, dan hasilnya (lolos/gagal). Kalau ragu maksud sebuah modul
studio, tanya dulu — jangan tebak.

---

# Fase berikutnya — mesin render

Status: **paruh portal sudah selesai dan ter-push** (`bc4f9c8`, CI hijau). Yang tersisa hanya paruh
worker, dan itu milikmu — `apps/worker/venstudio-worker.ts` satu berkas, jadi aku tidak menyentuhnya.

## Kenapa

Render yang keluar berupa slideshow bernarasi. Sebabnya bukan planner: `catalog.ts` mendeklarasikan
enam mesin, tapi worker tidak menyebut kata `engine` sekali pun, dan satu-satunya jalur render
(`buildRenderArgs`) **mewajibkan satu gambar per shot** dengan empat varian `zoompan` linear dan
`concat` keras. Renderer dengan satu primitif hanya bisa menghasilkan primitif itu.

## Yang sudah ada di pohon — pakai, jangan tulis ulang

`apps/portal/lib/studio/render-engine.ts` (murni, 19 tes):

- `engineIssues({ engine, reported })` — menolak mesin yang kapabilitasnya tidak dilaporkan worker,
  dan mesin yang katalognya tandai tidak dijalankan worker (`provider`/`blender`).
- `planCrossFades(seconds, transitionSec)` — `offsets` (argumen `offset=` tiap `xfade`), `starts`
  (mulai tiap shot), `totalSec`, dan penolakan kalau fade memakan shot.
- `transitionFor(index)` — transisi ditentukan posisi, jadi render ulang storyboard sama hasilnya.
- `MOTION_TOKENS` / `parseMotionTokens` / `motionCoverage` / `coverageIssues` / `engineMotionIssues` —
  gerbang variasi dari `flat-vector-explainer-video`.

`render.ts` kini membawa `engine` (default `ffmpeg-stills`), `transitionSec` (default 0), dan
`scenePlan` opsional di payload. **Dengan `transitionSec: 0` dan tanpa `scenePlan`, rencananya identik
dengan sebelumnya** — tidak ada tes lama yang berubah perilaku.

`apps/portal/lib/studio/scene-plan.ts` (murni, 15 tes) — **inilah data yang dirender template**:

- `buildScenePlan({ styleId, format, shots, transitionSec?, cameraEvery? })` → `{ plan, warnings }`.
  Menurunkan scene dari storyboard + style: elemen (`heading`/`plate`/`counter`/`bar`/`gauge`/…),
  token gerak per beat, penanda kamera, dan layer dengan clock masing-masing.
- `scenePlanIssues(plan, { reported? })` → daftar masalah: gerbang mesin, gerbang cakupan gerak,
  elemen kekenyangan, layer tanpa clock, layer berlapis yang clock-nya seragam.
- `renderParamsForStyle(styleId)` → `{ engine, template, transitionSec, elementAnimation }` atau
  `null` untuk style tak dikenal.
- `elementAnimationFor(engineId)` → `true` kalau mesin menganimasikan isi frame, bukan hanya kamera.

Bentuk `Scene` yang akan kamu render:

```
{ shotRef, seconds, beatRole,
  elements: [{ kind, text? }],        // apa yang ada di layar
  tokens: ["draw","counter",…],       // apa yang bergerak, ditafsirkan template
  camera: boolean,                    // kamera ikut bergerak
  layers: [{ id, frames, fps }] }     // clock per-layer; frames 1 = tidak berubah
```

`shotRef` sama persis dengan `payload.shots[].shotRef` (`shot-01`, `shot-02`, …), jadi urutan scene
dan urutan gambar selalu sejajar.

**`production.ts` sudah kusambungkan** (jangan ditulis ulang): stage render kini mengambil
`renderParamsForStyle(template.styleId)`, membangun `scenePlan` bila style-nya beranimasi, dan
**menggagalkan stage dengan pesan jelas** kalau scene plan tidak lolos — bukan diam-diam merender
stills. Perubahan itu ada di `runRenderStage`, sekitar baris 589.

## Yang perlu kamu kerjakan

1. **Dispatch.** Baca `engine` dan pilih jalur render. `ffmpeg-stills` = `buildRenderArgs` yang
   sekarang. `remotion-2d` = baca `payload.scenePlan` dan render dari situ. Mesin lain: tolak dengan
   pesan jelas — **jangan diam-diam jatuh ke stills**, justru fallthrough itu yang menghasilkan
   slideshow.
2. **Laporkan kapabilitas.** `detectCapabilities()` sekarang melaporkan `ffmpeg` (+`tts-kokoro`).
   Tambahkan lewat `VENSTUDIO_EXTRA_CAPS` sesuai kemampuan nyata mesin Muse. Sampai dilaporkan,
   planner tidak akan pernah boleh memilih mesin itu.
3. **Sambungkan kapabilitas ke payload.** `buildRenderPayload` sudah menerima
   `workerCapabilities?: readonly string[]`; isi dari baris worker yang melapor. Kalau diisi, engine
   yang tidak bisa dijalankan **gagal di perencanaan**, bukan di tengah render.
4. **Pakai `transitionSec`.** Kalau > 0, susun `xfade` memakai `planCrossFades` — jangan hitung offset
   sendiri di dalam string shell. Durasi akhir video adalah `totalSec`; `render.ts` sudah memanjangkan
   shot sebesar tumpang tindihnya supaya narasi tidak melewati video.
5. **Jangan pasang `xfade` kalau `transitionSec` 0** — perilaku lama harus tetap byte-identik.
6. **Tipe payload di worker** perlu mendapat `engine`, `transitionSec`, dan `scenePlan`.

## Urutan yang kusarankan untuk paruh worker

1. Dispatch + kapabilitas + tolak-mesin-yang-tak-ada. Ini bisa diuji tanpa Remotion sama sekali:
   job `ffmpeg-stills` harus keluar **byte-identik** dengan hari ini, dan job `remotion-2d` harus
   gagal dengan pesan yang menyebut mesinnya.
2. `xfade`. Uji dengan `transitionSec` 0,5 pada 3 shot: durasi video harus turun tepat sebesar
   2 × 0,5 s dibanding jumlah shot.
3. Baru proyek Remotion + template `flat-vector-explainer` dari `payload.scenePlan`.

Kalau aritmetikanya tidak cocok dengan bentuk filtergraph yang sudah ada, tulis di balasan: aku
menaruh angkanya, kamu yang punya grafnya.
