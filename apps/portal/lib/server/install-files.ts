import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.ts";
import { REMOTION_BUNDLE_NAME, REMOTION_RUNTIME_FILES, projectBundle } from "../install-bundle.ts";
import { PACKS_FILE_NAME, packsIndexText } from "../style-packs-index.ts";
import { remotionPackSources, servedPacksIndex } from "./style-packs.ts";
import { publicSigningKey } from "./update-key.ts";

/**
 * Public install files for workers. Muse VMs can't read the private GitHub repo,
 * so the portal serves the worker itself. These files contain no secrets.
 */
export const INSTALL_FILES: Record<string, { source: string; type: string; template?: boolean; bundle?: boolean; packs?: boolean }> = {
  "SETUP.md": { source: "SETUP.md", type: "text/markdown; charset=utf-8", template: true },
  // Old name, kept so existing links keep working.
  "AGENT_DEPLOY.md": { source: "SETUP.md", type: "text/markdown; charset=utf-8", template: true },
  "install.sh": { source: "install.sh", type: "text/x-shellscript; charset=utf-8", template: true },
  "venstudio-worker.ts": { source: "venstudio-worker.ts", type: "text/plain; charset=utf-8" },
  // The Remotion renderer for remotion-2d (install.sh --with-remotion): the runtime next to the worker plus the render
  // project of every vendored remotion-2d style pack (lib/server/style-packs.ts).
  [REMOTION_BUNDLE_NAME]: { source: "../render-remotion", type: "application/json; charset=utf-8", bundle: true },
  // The index of the vendored style packs (worker 0.9.0+ installs it and reports pack:<id>@<version>).
  [PACKS_FILE_NAME]: { source: "styles/lock.json", type: "application/json; charset=utf-8", packs: true },
};

export function portalUrl() {
  return env().APP_URL.replace(/\/+$/, "");
}

export async function renderInstallFile(name: string): Promise<string | null> {
  const entry = INSTALL_FILES[name];
  if (!entry) return null;
  const dir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), env().WORKER_DIR);
  if (entry.packs) return packsIndexText(await servedPacksIndex());
  if (entry.bundle) {
    // Read every listed file first; the reader passed to projectBundle is synchronous.
    const root = path.join(/*turbopackIgnore: true*/ dir, entry.source);
    const texts = new Map<string, string>();
    for (const rel of REMOTION_RUNTIME_FILES) texts.set(rel, await readFile(path.join(/*turbopackIgnore: true*/ root, rel), "utf8"));
    return JSON.stringify(projectBundle((rel) => texts.get(rel) as string, await remotionPackSources()));
  }
  const body = await readFile(path.join(/*turbopackIgnore: true*/ dir, entry.source), "utf8");
  if (!entry.template) return body;
  let out = body.replaceAll("{{PORTAL_URL}}", portalUrl());
  // install.sh carries the update signing key, so the owner's one sha256 check of install.sh also pins the key the
  // worker will trust for automatic updates (docs/worker-updates.md). Creates the key pair on first use.
  // Without a usable key the script is still served, with an empty key: install.sh then warns that automatic updates
  // stay off, which is the safe side (the Workers page shows why).
  if (out.includes("{{UPDATE_PUBLIC_KEY}}")) {
    const key = await publicSigningKey().then(
      (k) => k.publicKey,
      (err: unknown) => {
        console.error("update signing key unavailable; install.sh served without it:", err);
        return "";
      },
    );
    out = out.replaceAll("{{UPDATE_PUBLIC_KEY}}", key);
  }
  return out;
}

/** SHA-256 of a served install file, so the owner can check the downloaded copy is the same. */
export async function installFileSha256(name: string): Promise<string | null> {
  const body = await renderInstallFile(name);
  return body === null ? null : createHash("sha256").update(body).digest("hex");
}
