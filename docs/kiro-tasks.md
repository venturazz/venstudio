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
