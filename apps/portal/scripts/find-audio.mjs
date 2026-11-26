// Finds commercially usable music, sound effects and ambience, files them into the asset library, and reports coverage.
//
// The library grows by use. This script is the *bulk* side — take everything usable for the moods and cues the styles ask
// for, and report which tags are still empty. The other side is per-run: when a video asks for something the library does
// not have, that need is recorded (lib/studio/asset-needs.ts) and becomes the next thing to find. Bulk alone drifts away
// from what the videos need; per-run alone starts from nothing.
//
// Why Openverse: the one audio index that needs no key and returns the licence *and* the licence URL for every result.
// Accepted: cc0, pdm, by, by-sa (commercial use; by/by-sa need credit, stored as creator + licence URL per asset).
// Refused: nc, nd, and anything with no licence — an asset whose terms are unknown is not one this studio may use.
//
// Usage
//   node scripts/find-audio.mjs                          # dry run: search, filter, report gaps
//   node scripts/find-audio.mjs --target 80              # aim for 80 assets across all classes
//   node scripts/find-audio.mjs --class sfx --target 40  # one class
//   DATABASE_URL=... node scripts/find-audio.mjs --write --target 80
//
//   DATABASE_URL=... node scripts/find-audio.mjs --needs            # only what real runs were blocked on
//   DATABASE_URL=... node scripts/find-audio.mjs --needs --write    # and resolve those needs
//
// `--needs` is the growing half: it reads asset_needs — the table every run writes to when it wanted a mystery bed or a
// riser and found nothing — and looks for exactly those tags, most-blocking first. So the library fills in the order the
// videos asked, not the order a list of moods was written in.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://api.openverse.org/v1/audio/";
const GOOD_LICENCES = new Set(["cc0", "pdm", "by", "by-sa"]);
const UA = "venstudio-audio-seed/1.0 (self-hosted studio; https://github.com/venturazz/venstudio)";
const PAGE = 20;

/**
 * The catalogue the studio needs, written as the thing a video asks for. The extra tags become the vocabulary the pipeline
 * matches on — `calm`, `mystery`, `whoosh`, `rain` — and are what the coverage report counts. Add a mood here and the whole
 * pipeline can ask for it.
 */
const PRESETS = {
  music: [
    { q: "calm piano background music", tags: ["calm"], minSec: 45, maxSec: 420, take: 4 },
    { q: "soft ambient background music", tags: ["calm", "ambient"], minSec: 45, maxSec: 420, take: 3 },
    { q: "cinematic soundtrack background", tags: ["documentary"], minSec: 45, maxSec: 420, take: 4 },
    { q: "documentary tension music", tags: ["documentary", "tension"], minSec: 45, maxSec: 420, take: 3 },
    { q: "dark ambient drone music", tags: ["mystery"], minSec: 45, maxSec: 420, take: 3 },
    { q: "horror suspense music", tags: ["mystery", "horror"], minSec: 45, maxSec: 420, take: 3 },
    { q: "upbeat corporate music", tags: ["uplifting"], minSec: 45, maxSec: 420, take: 3 },
    { q: "inspiring piano strings", tags: ["uplifting", "emotional"], minSec: 45, maxSec: 420, take: 3 },
    { q: "comedy music", tags: ["playful"], minSec: 20, maxSec: 420, take: 3 },
    { q: "lofi hip hop background", tags: ["chill"], minSec: 45, maxSec: 420, take: 3 },
    { q: "epic orchestral trailer", tags: ["epic"], minSec: 20, maxSec: 420, take: 3 },
    { q: "electronic background music", tags: ["tech"], minSec: 30, maxSec: 420, take: 3 },
  ],
  sfx: [
    { q: "whoosh transition", tags: ["whoosh"], minSec: 0.2, maxSec: 4, take: 6 },
    { q: "swish swoosh", tags: ["whoosh"], minSec: 0.2, maxSec: 4, take: 4 },
    { q: "impact boom", tags: ["impact"], minSec: 0.2, maxSec: 4, take: 5 },
    { q: "punch hit", tags: ["impact"], minSec: 0.1, maxSec: 3, take: 4 },
    { q: "riser tension builder", tags: ["riser"], minSec: 0.5, maxSec: 8, take: 5 },
    { q: "click ui button", tags: ["click"], minSec: 0.05, maxSec: 2, take: 4 },
    { q: "notification pop", tags: ["click"], minSec: 0.05, maxSec: 2, take: 3 },
    { q: "cinematic sub drop", tags: ["impact", "transition"], minSec: 0.3, maxSec: 5, take: 3 },
    { q: "glitch digital transition", tags: ["transition", "tech"], minSec: 0.1, maxSec: 4, take: 3 },
    { q: "paper page turn", tags: ["transition"], minSec: 0.1, maxSec: 3, take: 3 },
  ],
  // Ambience is its own class: not an accent, not music. It plays under everything at a low level and is looped.
  ambience: [
    { q: "room tone quiet room", tags: ["room-tone"], minSec: 20, take: 3 },
    { q: "soft rain ambience", tags: ["rain"], minSec: 20, take: 3 },
    { q: "city street ambience", tags: ["crowd", "city"], minSec: 20, take: 3 },
    { q: "market crowd ambience", tags: ["crowd"], minSec: 20, take: 3 },
    { q: "forest ambience birds", tags: ["nature"], minSec: 20, take: 3 },
    { q: "cafe coffee shop ambience", tags: ["indoor", "crowd"], minSec: 20, take: 3 },
    { q: "wind breeze ambience", tags: ["nature", "wind"], minSec: 20, take: 3 },
    { q: "ocean waves ambience", tags: ["nature", "water"], minSec: 20, take: 2 },
    { q: "night crickets ambience", tags: ["nature", "night"], minSec: 20, take: 2 },
    { q: "office room tone hum", tags: ["room-tone", "indoor"], minSec: 20, take: 2 },
  ],
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1] ?? "";
}
const has = (name) => process.argv.includes(`--${name}`);

const wanted = arg("class");
const write = has("write");
const needsMode = has("needs");
const target = Number(arg("target")) || 0;
const classes = wanted ? [wanted] : Object.keys(PRESETS);
if (classes.some((c) => !PRESETS[c])) {
  console.error(`Unknown class "${wanted}". Use one of: ${Object.keys(PRESETS).join(", ")}`);
  process.exit(1);
}

async function getPage(q, page) {
  const url = new URL(API);
  url.searchParams.set("q", q);
  url.searchParams.set("license", "cc0,by,by-sa,pdm");
  url.searchParams.set("page_size", String(PAGE));
  url.searchParams.set("page", String(page));
  let lastError = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
      if (res.ok) return (await res.json()).results ?? [];
      lastError = `HTTP ${res.status}`;
      // 4xx will not improve by waiting; 5xx and 429 will.
      if (res.status < 500 && res.status !== 429) return [];
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 1200 * attempt));
  }
  throw new Error(lastError);
}

const NOT_MUSIC = /ambien|room\s*tone|atmos|rain|wind|birds|crowd|forest|ocean|noise|sfx|sound effect|foley|whoosh|impact|click|riser/i;

/** Everything the studio would refuse, refused here, with the reason kept on the record. */
function rejection(r, preset, cls) {
  if (!r.url || !String(r.url).startsWith("https://")) return "no direct https file";
  if (!GOOD_LICENCES.has(String(r.license))) return `licence ${r.license || "unknown"}`;
  const sec = Number(r.duration) / 1000;
  if (!Number.isFinite(sec) || sec <= 0) return "duration unknown";
  if (preset.minSec && sec < preset.minSec) return `too short (${sec.toFixed(1)}s)`;
  if (preset.maxSec && sec > preset.maxSec) return `too long (${sec.toFixed(1)}s)`;
  if (r.filetype && !["mp3", "ogg", "wav", "flac"].includes(String(r.filetype))) return `type ${r.filetype}`;
  // A bed is not an atmosphere: those words mean the wrong layer, and the first dry run offered room tone as music.
  if (cls === "music" && NOT_MUSIC.test(String(r.title ?? ""))) return "an atmosphere or effect, not a bed";
  return null;
}

const picked = [];
const seen = new Set();
const stats = [];

async function takePreset(cls, preset, budget) {
  let taken = 0;
  let pages = 0;
  let seenResults = 0;
  while (taken < budget && pages < 5) {
    pages++;
    let results = [];
    try {
      results = await getPage(preset.q, pages);
    } catch (err) {
      console.error(`! ${preset.q} page ${pages}: ${err.message}`);
      break;
    }
    seenResults += results.length;
    if (results.length === 0) break;
    for (const r of results) {
      if (taken >= budget) break;
      if (rejection(r, preset, cls)) continue;
      const key = String(r.url);
      const nameKey = `${String(r.title ?? "").toLowerCase().trim()}|${String(r.creator ?? "").toLowerCase().trim()}`;
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
      });
      taken++;
    }
  }
  stats.push({ cls, tags: preset.tags, taken, seen: seenResults });
  console.log(`${cls}/${preset.tags.join("+")}: ${taken} taken from ${seenResults} results (${pages} page${pages === 1 ? "" : "s"})`);
}

/** One need becomes one query. The class decides the shape of the thing being asked for. */
function presetFor(cls, tag) {
  if (cls === "music") return { q: `${tag} background music`, tags: [tag], minSec: 30, maxSec: 420, take: 3 };
  if (cls === "sfx") return { q: tag, tags: [tag], minSec: 0.05, maxSec: 8, take: 4 };
  return { q: `${tag} ambience`, tags: [tag], minSec: 15, take: 3 };
}

async function openNeeds() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("--needs reads asset_needs, so it needs DATABASE_URL.");
    process.exit(1);
  }
  const { default: postgres } = await import("postgres");
  const sqlNeeds = postgres(dbUrl, { max: 1, onnotice: () => {} });
  try {
    return await sqlNeeds`
      SELECT asset_class, tag, videos FROM asset_needs
      WHERE resolved_at IS NULL ORDER BY videos DESC, last_seen DESC LIMIT 40
    `;
  } finally {
    await sqlNeeds.end();
  }
}

const work = [];
if (needsMode) {
  const rows = await openNeeds();
  console.log(`open needs: ${rows.length}`);
  for (const r of rows) work.push({ cls: String(r.asset_class), preset: presetFor(String(r.asset_class), String(r.tag)), videos: Number(r.videos) });
  if (work.length === 0) {
    console.log("Nothing is open: every sound a run asked for is in the library.");
    process.exit(0);
  }
} else {
  for (const cls of classes) for (const preset of PRESETS[cls]) work.push({ cls, preset, videos: 0 });
}

// Three at a time: finishes a seed run in minutes, gentle enough that Openverse does not start answering 500.
for (let i = 0; i < work.length; i += 3) {
  await Promise.all(
    work.slice(i, i + 3).map((w) => {
      if (!target) return takePreset(w.cls, w.preset, w.preset.take);
      const left = target - picked.filter((p) => p.class === w.cls).length;
      return left <= 0 ? Promise.resolve() : takePreset(w.cls, w.preset, Math.min(w.preset.take, left));
    }),
  );
}

const byClass = picked.reduce((m, p) => ({ ...m, [p.class]: (m[p.class] ?? 0) + 1 }), {});
const seconds = picked.reduce((n, p) => n + p.durationSec, 0);
console.log("\ntaken:", byClass, "total", picked.length, `· ${(seconds / 60).toFixed(0)} minutes of audio`);

// Coverage: a tag the catalogue asked for and nothing was found for is a gap the studio hits the first time a video asks.
const covered = new Map();
for (const p of picked) for (const t of p.tags.slice(1)) covered.set(t, (covered.get(t) ?? 0) + 1);
const askedTags = new Set(stats.flatMap((s) => s.tags));
const gaps = [...askedTags].filter((t) => !covered.has(t));
console.log("covered:", Object.fromEntries([...covered.entries()].sort((a, b) => b[1] - a[1])));
if (gaps.length > 0) console.log("GAPS (asked for, nothing found):", gaps.join(", "));

if (!write) {
  console.log("\ndry run. Add --write (with DATABASE_URL) to download and file these into the asset library.");
  process.exit(0);
}

// Files go where the portal expects them, not into a directory of their own: <ARTIFACT_DIR>/assets/<assetId>/<file>.
// Postgres stores metadata and the path; the bytes live on the volume the portal and its workers already share. Writing
// anywhere else would produce rows the media route refuses to serve (openStored rejects any path outside ARTIFACT_DIR).
const dir = path.resolve(process.env.ARTIFACT_DIR ?? "./data/artifacts", "assets");
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("--write needs DATABASE_URL (and ARTIFACT_DIR if it is not ./data/artifacts).");
  process.exit(1);
}
await mkdir(dir, { recursive: true });
const { default: postgres } = await import("postgres");
const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });

let filed = 0;
let skipped = 0;
try {
  for (const p of picked) {
    let buf;
    try {
      const res = await fetch(p.url, { headers: { "User-Agent": UA } });
      if (!res.ok) {
        console.error(`! download ${p.title}: HTTP ${res.status}`);
        continue;
      }
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.error(`! download ${p.title}: ${err.message}`);
      continue;
    }
    const sha = createHash("sha256").update(buf).digest("hex");
    const already = await sql`SELECT id FROM assets WHERE sha256 = ${sha} LIMIT 1`;
    if (already.length > 0) {
      skipped++;
      continue;
    }
    const ext = p.filetype === "mpeg" ? "mp3" : p.filetype;
    const assetId = randomUUID();
    const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "track";
    const file = path.join(dir, assetId, `${slug}-${sha.slice(0, 8)}.${ext}`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buf);
    await sql`
      INSERT INTO assets (id, title, kind, source, license, origin_url, tags, content_type, bytes, sha256, storage_path, metadata)
      VALUES (
        ${assetId}, ${p.title}, 'audio', 'licensed', ${`${p.license} (${p.licenseUrl})`}, ${p.originUrl || p.url},
        ${p.tags}::text[], ${`audio/${ext}`}, ${buf.length}, ${sha}, ${file},
        ${JSON.stringify({
          provider: p.provider,
          creator: p.creator,
          licenseUrl: p.licenseUrl,
          durationSec: p.durationSec,
          sourceUrl: p.url,
          needsCredit: p.license === "by" || p.license === "by-sa",
          foundBy: "scripts/find-audio.mjs",
        })}::jsonb
      )
    `;
    filed++;
    console.log(`+ ${p.title} (${p.class}/${p.tags.slice(1).join("+")})`);
    // The need that asked for this is satisfied now; the next find run moves on to what still blocks videos.
    if (needsMode) {
      for (const tag of p.tags.slice(1)) {
        await sql`
          UPDATE asset_needs SET resolved_at = now()
          WHERE asset_class = ${p.class} AND tag = ${tag.toLowerCase()} AND resolved_at IS NULL
        `.catch(() => undefined);
      }
    }
  }
  const total = await sql`SELECT count(*)::int AS n FROM assets WHERE kind = 'audio'`.catch(() => [{ n: "?" }]);
  console.log(`\nfiled ${filed}, already had ${skipped}. Audio assets in the library now: ${total[0]?.n ?? "?"}.`);
  console.log(`Credit required for ${picked.filter((p) => p.license === "by" || p.license === "by-sa").length} of this batch (creator + licence URL stored per asset).`);
} finally {
  await sql.end();
}