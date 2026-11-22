#!/usr/bin/env node
/**
 * Writes the Remotion project a worker gets from /install/render-remotion.json into a directory, without a portal:
 * the runtime (apps/render-remotion) plus the render project of every vendored remotion-2d style pack
 * (styles/packs/<id>/render/, checked against styles/lock.json) and the pages of every html-capture pack (html/<id>/),
 * built by the same projectBundle the portal uses and
 * unpacked by the worker's own writeProjectBundle. CI renders the golden fixture from this project, so the
 * composition it renders is the one in the vendored pack.
 *
 *   node scripts/remotion-project.mjs <dir>      then: cd <dir> && npm install && npx remotion browser ensure && node scripts/probe.mjs --full
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REMOTION_RUNTIME_FILES, projectBundle } from "../apps/portal/lib/install-bundle.ts";
import { writeProjectBundle } from "../apps/worker/venstudio-worker.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = path.join(ROOT, "apps", "render-remotion");
const STYLES = path.join(ROOT, "styles");

/** The vendored remotion-2d packs' render files, each checked against lock.json (as lib/server/style-packs.ts does). */
export function vendoredRemotionPacks(stylesDir = STYLES) {
  const lock = JSON.parse(readFileSync(path.join(stylesDir, "lock.json"), "utf8"));
  return lock.packs
    .filter((p) => p.engine === "remotion-2d" && p.composition)
    .map((p) => ({
      id: p.id,
      version: p.version,
      composition: p.composition,
      files: Object.entries(p.files)
        .filter(([rel]) => rel.startsWith("render/"))
        .map(([rel, want]) => {
          const body = readFileSync(path.join(stylesDir, "packs", p.id, rel));
          if (createHash("sha256").update(body).digest("hex") !== want) throw new Error(`styles/packs/${p.id}/${rel} differs from styles/lock.json`);
          return { path: rel.slice("render/".length), content: body.toString("utf8") };
        }),
    }));
}

/** The vendored html-capture packs' pages (installed as html/<id>/), each checked against lock.json. */
export function vendoredHtmlPacks(stylesDir = STYLES) {
  const lock = JSON.parse(readFileSync(path.join(stylesDir, "lock.json"), "utf8"));
  return lock.packs
    .filter((p) => p.engine === "html-capture")
    .map((p) => {
      const style = JSON.parse(readFileSync(path.join(stylesDir, "packs", p.id, "style.json"), "utf8"));
      return {
        id: p.id,
        version: p.version,
        drawsCaptions: style.renderer?.drawsCaptions === true,
        // An html-design pack: workers render only a page uploaded with the job for it (worker 0.11.0+).
        ...(style.workflow?.recipe === "html-design" ? { designed: true } : {}),
        files: Object.entries(p.files)
          .filter(([rel]) => rel.startsWith("render/"))
          .map(([rel, want]) => {
            const body = readFileSync(path.join(stylesDir, "packs", p.id, rel));
            if (createHash("sha256").update(body).digest("hex") !== want) throw new Error(`styles/packs/${p.id}/${rel} differs from styles/lock.json`);
            return { path: rel.slice("render/".length), content: body.toString("utf8") };
          }),
      };
    });
}

export function remotionBundle() {
  return projectBundle((rel) => readFileSync(path.join(RUNTIME, rel), "utf8"), vendoredRemotionPacks(), vendoredHtmlPacks());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/remotion-project.mjs <dir>");
    process.exit(2);
  }
  const bundle = remotionBundle();
  const n = await writeProjectBundle(JSON.parse(JSON.stringify(bundle)), dir);
  console.log(`wrote ${n} files (${REMOTION_RUNTIME_FILES.length} runtime, ${n - REMOTION_RUNTIME_FILES.length} from packs) into ${path.resolve(dir)}`);
}
