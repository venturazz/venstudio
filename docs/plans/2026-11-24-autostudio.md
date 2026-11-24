# AutoStudio: a schedule that fills the same form, not a second Studio

Status: **proposal. Nothing built.** Written 2026-11-24 after the length/brief work (#28, #29, #30, #31).

## Ringkasan (Bahasa Indonesia)

AutoStudio adalah fitur yang seharusnya jadi inti sejak awal: **production line**, bukan tombol render. Tapi bentuknya
harus tepat, karena ada dua cara membangunnya dan hanya satu yang tidak menggandakan otak:

- **Salah:** AutoStudio jadi "Studio kedua" — punya sendiri logika ide, brief, gaya, QC. Dua tempat yang bisa salah, dua
  hasil yang tidak bisa dibandingkan, dan tidak ada satu pun yang bisa dipercaya.
- **Benar:** AutoStudio hanya **menjadwalkan** dan **mengisi formulir yang sama** dengan New Video. Semua kecerdasan tetap
  di tahap idea/script/QC yang sudah ada (`lib/server/director.ts`) dan di pack gaya. AutoStudio menambah tiga hal yang
  memang belum ada: *kapan* (jadwal + idempotensi), *seberapa jauh tanpa kamu* (peta gate per tahap), dan *memori series*.

Soal persetujuan, jawabannya satu kata: **sekali**. `Arm` pada sebuah jadwal adalah persetujuan tetap atas setelannya
(channel, gaya, durasi, irama, budget) — bukan persetujuan per video. Sesudah itu ide dipilih otomatis dari tiga usulan
(skor tertinggi), dan yang menjaga mutu adalah **spot check tiap 5 video** plus **auto-pause sesudah dua kegagalan**,
dua-duanya sudah ada. Yang mau lebih ketat bisa menyalakan `idea` di `gate_stages`.

Iramanya tiga bentuk saja, tanpa cron: `daily@07:00`, `weekly@mon,thu@07:00`, `every:2@07:00`. Yang dimaterialisasi
hanya slot berikutnya (`slots_ahead: 1`) — harian, bukan cadangan seminggu.

Kabar baiknya: bahan untuk "seberapa jauh tanpa kamu" sudah ada di `lib/studio/autonomy.ts` — level 0–3, auto-publish
hanya pada skor ≥ 85, spot check tiap 5 video, maksimal 2 revisi otomatis, dan aksi penurun otomatis
(`pause-channel-autonomy`, `demote-template`, `block-publish`). AutoStudio tidak perlu mekanisme persetujuan baru; ia
hanya perlu memberi tahu mekanisme itu **tahap mana yang boleh lewat tanpa kamu**.

Urutan yang saya sarankan: **jadwal + idempotensi dulu** (satu sprint, hasilnya langsung terasa), memori series kedua,
peta gate ketiga, upload terakhir. Upload terakhir bukan karena tidak penting, tapi karena ia satu-satunya bagian yang
butuh integrasi eksternal dan izin platform — dan justru bagian yang paling mahal kalau salah.

## 1. Yang sudah ada, dan cukup

| Bahan | Di mana | Dipakai AutoStudio untuk |
| --- | --- | --- |
| `pipeline_runs` + `pipeline_stages` + `review_items` | `lib/server/director.ts` | satu video = satu run; tahap dan gate sudah ada, tidak diubah |
| Level otonomi 0–3, skor auto-publish ≥ 85, spot check tiap 5, maks 2 revisi | `lib/studio/autonomy.ts` | "seberapa jauh tanpa kamu", per channel, sudah diuji |
| Aksi penurun otomatis | `autonomy.ts` (`afterClaim`) | AutoStudio membaca `paused` dan berhenti, tidak melawan |
| Resep per gaya (tahap apa saja yang dijalankan) | `lib/studio/recipes.ts` | jadwal tidak perlu tahu; gaya yang menentukan |
| Worker + kapabilitas + pembaruan pack | `lib/server/workers.ts`, `lib/server/jobs.ts` | memilih worker yang bisa merender gaya ini, dan menunggu kalau tidak ada |
| Penanda trial/lab yang tidak boleh terbit | `run-config.ts` (`stylePack.trial`) | jadwal otomatis yang tidak boleh publish tetap berhenti di "siap terbit" |
| Brief sebagai objek, dibekukan saat ide disetujui | `lib/studio/brief.ts` (#29) | series = brief yang membawa memori; one-off = brief bebas |

Yang **belum** ada: tidak ada tabel jadwal, tidak ada penjadwal sama sekali di portal (tidak ada `cron`/`setInterval` di
`lib/server`), dan belum ada jalur publish (kode hanya *menolak* menerbitkan untuk trial). Jadi ini fitur baru, bukan
saklar.

## 2. Bentuknya: satu baris jadwal, bukan satu mesin baru

```sql
CREATE TABLE schedules (
  id             uuid PRIMARY KEY,
  channel_id     uuid NOT NULL,
  name           text NOT NULL,
  kind           text NOT NULL,          -- 'series' | 'one-off'
  -- the same fields New Video asks for, frozen as a template
  settings       jsonb NOT NULL,         -- {themeId, styleId, durationSec, language, purposes, subtitles}
  brief          jsonb NOT NULL,         -- {topicSource: 'plan'|'owner'|'series-memory', topic?, mustInclude, mustAvoid}
  -- Three plain forms, no cron parser: 'daily@07:00' | 'weekly@mon,thu@07:00' | 'every:2@07:00'.
  cadence        text NOT NULL,
  timezone       text NOT NULL,          -- 'Asia/Jakarta'
  slots_ahead    int  NOT NULL DEFAULT 1, -- 1 = tomorrow's slot only; the owner asked for daily, not a week ahead
  gate_stages    text[] NOT NULL,        -- stages AutoStudio may pass without the owner, e.g. {script}
  budget         jsonb NOT NULL,         -- {maxRunsPerDay, maxWorkerMinutesPerDay}
  stop_rules     jsonb NOT NULL,         -- {afterFailures: 2, onWorkerMissing: 'wait'}
  state          text NOT NULL,          -- 'draft' | 'armed' | 'paused'
  series_id      uuid NULL,              -- series only
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: one run per slot, ever. The unique index is the whole safety story.
CREATE UNIQUE INDEX ON pipeline_runs (schedule_id, slot_at) WHERE schedule_id IS NOT NULL;
```

Satu *tick* penjadwal (satu menit sekali, advisory lock di Postgres, di proses portal yang sudah ada) melakukan satu
hal: untuk setiap jadwal `armed` yang slot berikutnya masuk dalam `slots_ahead`, **materialisasi** satu `pipeline_runs`
dengan `settings` dan `brief` dari jadwal, lalu serahkan ke `startRun` yang sudah ada. Kalau indeks unik menolak, artinya
slot itu sudah ada — tidak terjadi apa-apa. Itu sebabnya tick boleh jalan tiap menit, boleh dua instance, dan tidak
pernah membuat video ganda.

**Keputusan yang saya sarankan, dan alasannya:**

1. **Materialisasi, bukan "render saat tiba".** Run dibuat lebih dulu (mis. H+1), jadi kamu bisa melihat dan membatalkan
   sebelum worker dipakai. Slot yang sudah dibuat tapi belum jalan mudah dibatalkan; video yang sudah dirender tidak.
2. **AutoStudio tidak punya prompt sendiri.** Ia mengisi `settings` + `brief` yang sama; tahap idea/script tetap milik
   director. Kalau AutoStudio punya prompt sendiri, kualitasnya akan menyimpang dari Studio dan tidak ada yang bisa
   dibandingkan — persis masalah "skill jadi script" yang sudah kita bereskan di pack.
3. **Sekali setuju, lalu jalan — dengan satu pemeriksaan paksa.** `Arm` pada jadwal adalah persetujuan tetap atas
   setelan (channel, gaya, durasi, irama, budget), bukan persetujuan per video. Sesudah itu ide **dipilih otomatis**:
   `pickIdea` sudah memilih skor tertinggi dari tiga usulan, jadi tidak ada yang perlu diklik tiap hari. Yang menjaga mutu
   bukan persetujuan harian, tapi dua hal yang sudah ada di `autonomy.ts`: **spot check tiap 5 video** (video ke-5 tetap
   mampir ke Review walaupun channel di level tertinggi) dan **auto-pause** sesudah dua kegagalan berturut.
   `gate_stages` hanya boleh berisi tahap yang sudah punya jalur auto di `autonomy.ts`; kalau tidak, ditolak dengan alasan.
   Yang mau lebih ketat boleh menyalakan `idea` di `gate_stages` — tapi default-nya tidak.
4. **Budget lebih penting daripada jadwal.** 3 menit video ≈ 8 menit kerja worker (hitungan PR #31), 20 menit long ≈ 50
   menit. Jadi `maxWorkerMinutesPerDay` harus diperiksa **sebelum** materialisasi; kalau habis, slot ditandai
   `skipped: budget` dan muncul di kalender, bukan menghilang diam-diam.
5. **Berhenti itu fitur.** Dua kegagalan berturut → `paused` + satu review item "jadwal berhenti: 2 gagal". Worker tidak
   ada → `wait` (slot tetap ada, tidak jadi run yatim). Trial/lab → jalan sampai "siap terbit", tidak pernah publish.

## 3. Series vs one-off: beda brief, bukan beda fitur

Keduanya baris di tabel yang sama. Bedanya hanya di `kind` dan di apa yang masuk brief:

- **one-off**: `brief.topicSource` = `plan` (dari rencana channel) atau `owner` (topik tetap). Tiap slot boleh beda topik,
  gaya/durasi boleh tetap supaya channel terasa satu keluarga.
- **series**: tambah `series_id`, dan brief membawa **memori**: nomor episode, judul yang sudah dipakai (agar tidak
  mengulang), cast/karakter, dan di mana episode ini dalam arc. Gaya + durasi + frame **terkunci** — itu yang membuat
  sebuah series terasa series, dan mengunci tiga field lebih murah daripada mengunci seluruh brief.
- Series tidak butuh tabel baru kalau memori cukup di `series` (id, channel, judul, bible, next_episode). Memori masuk ke
  brief lewat `mustInclude` + satu paragraf `seriesNote`, bukan lewat jalur prompt baru.

## 4. Kalender, dan tombol yang membuatnya bisa dipercaya

Sebelum `armed`, layar AutoStudio menampilkan **tiga slot berikutnya** sebagai tiga baris, bukan tabel seminggu:
tanggal+jam, brief/topik (atau "dari rencana channel"), gaya, durasi, perkiraan menit worker. Default `slots_ahead = 1`:
yang dimaterialisasi hanya slot besok, karena iramanya harian — bukan cadangan seminggu yang tidak diminta. Plus dua
tombol: `Buat 1 video sekarang` (uji tanpa menunggu besok) dan `Batalkan slot`.

Sesudah jalan: satu daftar run per jadwal dengan status yang sudah ada (menunggu kamu / jalan / selesai / gagal), bukan
dasbor baru.

## 5. Banyak channel: satu jadwal, satu channel

Studio ini akan punya banyak channel, jadi "channel mana" harus jadi baris pertama tiap jadwal — dan tidak boleh ada
jadwal yang mencakup beberapa channel sekaligus. Satu channel gagal tidak boleh mematikan yang lain.

- `channel_id` **wajib**, tanpa opsi "semua channel".
- Halaman Automation dikelompokkan **per channel**: kartu channel (nama, niche, level otonomi) lalu daftar jadwalnya.
  Channel yang belum punya jadwal tetap tampil, dengan tombol "Buat jadwal" — supaya channel baru tidak terlupa.
- **Salin setelan** dari channel lain (satu klik, lalu ubah 2–3 field). Mengetik ulang sepuluh jadwal adalah cara
  tercepat membuat orang berhenti memakai fiturnya.
- **Budget per channel**, plus satu plafon global untuk semua channel, supaya satu jadwal yang salah setel tidak
  menghabiskan kuota worker channel lain.
- **Jam di-stagger**: lima channel yang semuanya 07:00 berarti lima render menabrak worker di menit yang sama. Portal
  menyarankan offset (07:00, 07:30, 08:00 …) dan menandai bentrok saat disimpan.
- Jadwal **ikut berhenti** kalau channel-nya di-`paused` oleh `autonomy.ts` (dua kegagalan berturut), dengan alasannya
  terlihat — bukan menyuruh pemilik mematikan sepuluh jadwal satu per satu.

Irama yang didukung, tanpa cron dan tanpa parser baru:

- `daily@07:00` — setiap hari.
- `weekly@mon,thu@07:00` — hari tertentu.
- `every:2@07:00` — setiap N hari.

## 6. Fase

| Fase | Isi | Bukti yang harus ada |
| --- | --- | --- |
| **1. Jadwal + idempotensi** | `schedules` dengan **channel wajib**, tiga bentuk irama, tick, materialisasi slot berikutnya, tiga baris "slot berikutnya", `armed/paused`, salin setelan | dua tick bersamaan tetap menghasilkan **satu** run untuk satu slot; `paused` tidak membuat run baru; budget habis → `skipped: budget` terlihat |
| **2. Series** | `series` + memori (judul terpakai, episode no, cast) + gaya/durasi terkunci | episode 3 tidak mengulang judul episode 1–2; gaya tidak bisa diganti di tengah series tanpa peringatan |
| **3. Gate + stop rules** | `gate_stages` dipetakan ke `autonomy.ts`, budget menit worker, auto-pause sesudah N gagal, notifikasi | `idea` tidak di gate → jalan otomatis penuh; spot check video ke-5 tetap ke owner; 2 gagal berturut → `paused` + satu review item |
| **4. Upload** | target per channel, hanya Listed + skor ≥ 85 + spot check, jejak tiap terbitan | trial/lab tidak pernah punya tombol terbit; spot check tetap memaksa satu video ke kamu tiap 5 |

Saya sarankan fase 1 dan 2 dipisah tegas: fase 1 adalah penjadwalan (mudah diuji dengan waktu palsu), fase 2 adalah
kesinambungan cerita (mudah diuji dengan membaca brief), dan mencampurnya membuat bug jadwal terlihat seperti bug cerita.

## 7. Yang saya tidak sarankan

- **"Auto" yang berarti tanpa gate sama sekali.** `autonomy.ts` sudah menolak menerbitkan trial dan sudah menurunkan
  channel yang gagal; AutoStudio yang melewati itu akan menghapus satu-satunya jaminan yang kita punya.
- **Penjadwal di worker.** Worker bisa mati, diganti, atau dua-duanya hidup. Jadwal harus milik portal + Postgres, karena
  hanya di sana idempotensi bisa dijamin dengan indeks unik.
- **Satu jadwal untuk semua channel.** Tiap channel punya rencana, gaya, dan level otonomi sendiri; jadwal yang
  mencakup banyak channel berarti satu kegagalan mematikan semuanya.

## 8. Pertanyaan untukmu

1. Satu video per hari per channel sebagai default — cukup, atau mau 2–3?
2. Ide dipilih otomatis (skor tertinggi dari tiga usulan) + spot check tiap 5 video: setuju? Alternatifnya, `idea`
   dinyalakan di `gate_stages` supaya kamu tetap memilih tiap hari.
3. Irama mana yang dipakai lebih dulu: `daily` saja, atau langsung `weekly` (hari tertentu) dan `every:N`?
4. Zona waktu `Asia/Jakarta` untuk semua channel, atau per channel?
5. Budget per channel berapa menit kerja worker per hari (patokan: 45 s ≈ 2 menit, 3 menit ≈ 8 menit, 20 menit ≈ 50 menit)?
