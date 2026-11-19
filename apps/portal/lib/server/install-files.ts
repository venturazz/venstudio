import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.ts";

/**
 * Public install files for workers. Muse VMs can't read the private GitHub repo,
 * so the portal serves the worker itself. These files contain no secrets.
 */
export const INSTALL_FILES: Record<string, { source: string; type: string; template?: boolean }> = {
  "SETUP.md": { source: "SETUP.md", type: "text/markdown; charset=utf-8", template: true },
  // Old name, kept so existing links keep working.
  "AGENT_DEPLOY.md": { source: "SETUP.md", type: "text/markdown; charset=utf-8", template: true },
  "install.sh": { source: "install.sh", type: "text/x-shellscript; charset=utf-8", template: true },
  "venstudio-worker.ts": { source: "venstudio-worker.ts", type: "text/plain; charset=utf-8" },
};

export function portalUrl() {
  return env().APP_URL.replace(/\/+$/, "");
}

export async function renderInstallFile(name: string): Promise<string | null> {
  const entry = INSTALL_FILES[name];
  if (!entry) return null;
  const dir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), env().WORKER_DIR);
  const body = await readFile(path.join(/*turbopackIgnore: true*/ dir, entry.source), "utf8");
  return entry.template ? body.replaceAll("{{PORTAL_URL}}", portalUrl()) : body;
}

/** SHA-256 of a served install file, so the owner can check the downloaded copy is the same. */
export async function installFileSha256(name: string): Promise<string | null> {
  const body = await renderInstallFile(name);
  return body === null ? null : createHash("sha256").update(body).digest("hex");
}
