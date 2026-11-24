// Finds commercially usable music, sound effects and ambience, and optionally files them into the asset library.
//
// Why Openverse: it is the one audio index that needs no key, and it returns the licence *and* the licence URL for every
// result, which is what this studio actually needs. Results come from freesound, Jamendo and Wikimedia; each row keeps its
// provider, creator and licence so attribution can be printed later and provenance survives.
//
// What is accepted: cc0, pdm, by, by-sa. Those four allow commercial use (by and by-sa require credit, which is recorded
// and can be rendered). nc and nd are rejected outright, and so is anything with no licence string — an asset whose terms
// are unknown is not an asset this studio may use.
//
// Usage
//   node scripts/find-audio.mjs                        # dry run: search, filter, print what it would take
//   node scripts/find-audio.mjs --class sfx            # one class only
//   node scripts/find-audio.mjs --write                # download into AUDIO_SEED_DIR and insert into assets
//   DATABASE_URL=... node scripts/find-audio.mjs --write
//
// With --write it needs a database and AUDIO_SEED_DIR (a directory the app can also read, e.g. /opt/data/assets/audio).

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://api.openverse.org/v1/audio/";
const GOOD_LICENCES = new Set(["cc0", "pdm", "by", "by-sa"]);
const UA = "venstudio-audio-seed/1.0 (self-hosted studio; https://github.com/venturazz/venstudio)";

/** What the studio needs, described as the thing, not as a query string. */
const PRESETS = {
  music: [
    { q: "piano background music", tags: ["calm"], minSec: 60, maxSec: 420, take: 2 },
    { q: "cinematic soundtrack", tags: ["documentary"], minSec: 60, maxSec: 420, take: 2 },
    { q: "dark ambient music", tags: ["mystery"], minSec: 60, maxSec: 420, take: 2 },
    { q: "upbeat corporate music", tags: ["uplifting"], minSec: 45, maxSec: 420, take: 2 },
  ],
  sfx: [
    { q: "whoosh transition", tags: ["whoosh"], minSec: 0.2, maxSec: 4, take: 2 },
    { q: "impact boom", tags: ["impact"], minSec: 0.2, maxSec: 4, take: 2 },
    { q: "riser tension", tags: ["riser"], minSec: 0.5, maxSec: 8, take: 2 },
    { q: "click ui", tags: ["click"], minSec: 0.05, maxSec: 2, take: 2 },
  ],
  // Ambience is its own class: not an accent, not music. It plays under everything at a low level and is looped.
  ambience: [
    { q: "room tone quiet", tags: ["room-tone"], minSec: 20, take: 1 },
    { q: "rain ambience", tags: ["rain"], minSec: 20, take: 1 },
    { q: "market crowd ambience", tags: ["crowd"], minSec: 20, take: 1 },
    { q: "forest ambience birds", tags: ["nature"], minSec: 20, take: 1 },
  ],
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1] ?? "";
}
const has = (name) => process.argv.includes(`--${name}`);

const wanted = arg("class");
const write = has("write");
const classes = wanted ? [wanted] : Object.keys(PRESETS);
if (classes.some((c) => !PRESETS[c])) {
  console.error(`Unknown class "${wanted}". Use one of: ${Object.keys(PRESETS).join(", ")}`);
  process.exit(1);
}

async function search(q, licence, pageSize = 20) {
  const url = new URL(API);
  url.searchParams.set("q", q);
  url.searchParams.set("license", licence);
  url.searchParams.set("page_size", String(pageSize));
  let lastError = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
      if (res.ok) return (await res.json()).results ?? [];
      lastError = `HTTP ${res.status}`;
      // 4xx will not improve by waiting; 5xx and 429 will.
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 1200 * attempt));
  }
  throw new Error(`search "${q}" failed: ${lastError}`);
}

const NOT_MUSIC = /ambien|room\s*tone|atmos|rain|wind|birds|crowd|forest|noise|sfx|sound effect|foley|whoosh|impact|click/i;

/** Everything the studio would refuse, refused here, with the reason kept on the record. */
function rejection(r, preset, cls) {
  if (cls === "music" && NOT_MUSIC.test(String(r.title ?? ""))) return "an atmosphere or an effect, not a bed";
  if (!r.url || !String(r.url).startsWith("https://")) return "no direct https file";
  if (!GOOD_LICENCES.has(String(r.license))) return `licence ${r.license || "unknown"} is not commercial-usable`;
  const sec = Number(r.duration) / 1000;
  if (!Number.isFinite(sec) || sec <= 0) return "duration unknown";
  if (preset.minSec && sec < preset.minSec) return `too short (${sec.toFixed(1)}s < ${preset.minSec}s)`;
  if (preset.maxSec && sec > preset.maxSec) return `too long (${sec.toFixed(1)}s > ${preset.maxSec}s)`;
  if (r.filetype && !["mp3", "ogg", "wav", "flac"].includes(String(r.filetype))) return `file type ${r.filetype}`;
  return null;
}

const picked = [];
const seen = new Set();
for (const cls of classes) {
  for (const preset of PRESETS[cls]) {
    let results = [];
    try {
      results = await search(preset.q, "cc0,by,by-sa,pdm");
    } catch (err) {
      console.error(`! ${preset.q}: ${err.message}`);
      continue;
    }
    let taken = 0;
    for (const r of results) {
      if (taken >= preset.take) break;
      const why = rejection(r, preset, cls);
      if (why) continue;
      const key = String(r.url);
      const nameKey = `${String(r.title ?? "").toLowerCase()}|${String(r.creator ?? "").toLowerCase()}`;
      if (seen.has(key) || seen.has(nameKey)) continue;
      seen.add(key);
      seen.add(nameKey);
      picked.push({
        class: cls,
        tags: [cls, ...preset.tags],
        title: String(r.title ?? "").replace(/\.[a-z0-9]+$/i, "").slice(0, 120) || "Untitled",
        url: String(r.url),
        license: String(r.license),
        licenseUrl: String(r.license_url ?? ""),
        creator: String(r.creator ?? ""),
        provider: String(r.provider ?? r.source ?? ""),
        originUrl: String(r.foreign_landing_url ?? ""),
        durationSec: Math.round(Number(r.duration) / 100) / 10,
        filetype: String(r.filetype ?? "mp3"),
        bytes: Number(r.filesize) || null,
      });
      taken++;
    }
    console.log(`${cls}/${preset.tags[0]}: ${taken}/${preset.take} from ${results.length} results`);
  }
}

const byClass = picked.reduce((m, p) => ({ ...m, [p.class]: (m[p.class] ?? 0) + 1 }), {});
console.log("\ntaken:", byClass, "total", picked.length);
for (const p of picked) {
  console.log(`  [${p.class}] ${p.title.slice(0, 46).padEnd(46)} ${String(p.durationSec).padStart(6)}s ${p.license.padEnd(5)} ${p.provider}`);
}

if (!write) {
  console.log("\ndry run. Add --write to download and file these into the asset library.");
  process.exit(0);
}

const dir = process.env.AUDIO_SEED_DIR;
const dbUrl = process.env.DATABASE_URL;
if (!dir || !dbUrl) {
  console.error("--write needs AUDIO_SEED_DIR and DATABASE_URL.");
  process.exit(1);
}
await mkdir(dir, { recursive: true });
const { default: postgres } = await import("postgres");
const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });

let filed = 0;
try {
  for (const p of picked) {
    const res = await fetch(p.url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      console.error(`! download failed ${p.title}: HTTP ${res.status}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = createHash("sha256").update(buf).digest("hex");
    const already = await sql`SELECT id FROM assets WHERE sha256 = ${sha} LIMIT 1`;
    if (already.length > 0) {
      console.log(`= already in the library: ${p.title}`);
      continue;
    }
    const ext = p.filetype === "mpeg" ? "mp3" : p.filetype;
    const file = path.join(dir, `${sha.slice(0, 12)}.${ext}`);
    await writeFile(file, buf);
    await sql`
      INSERT INTO assets (title, kind, source, license, origin_url, tags, content_type, bytes, sha256, storage_path, metadata)
      VALUES (
        ${p.title}, 'audio', 'licensed', ${`${p.license} (${p.licenseUrl})`}, ${p.originUrl || p.url},
        ${p.tags}::text[], ${`audio/${ext}`}, ${buf.length}, ${sha}, ${file},
        ${JSON.stringify({ provider: p.provider, creator: p.creator, licenseUrl: p.licenseUrl, durationSec: p.durationSec, sourceUrl: p.url, foundBy: "scripts/find-audio.mjs" })}::jsonb
      )
    `;
    filed++;
    console.log(`+ ${p.title} (${p.class})`);
  }
  console.log(`\nfiled ${filed} of ${picked.length}. Attribution to keep: ${picked.filter((p) => p.license === "by" || p.license === "by-sa").length} track(s) require credit.`);
} finally {
  await sql.end();
}