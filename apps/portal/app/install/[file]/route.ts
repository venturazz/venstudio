import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/server/env.ts";

/**
 * Public install files for workers. Muse VMs can't read the private GitHub repo,
 * so the portal serves the worker itself. These files contain no secrets.
 */
const FILES: Record<string, { source: string; type: string; template?: boolean }> = {
  "AGENT_DEPLOY.md": { source: "AGENT_DEPLOY.md", type: "text/markdown; charset=utf-8", template: true },
  "install.sh": { source: "install.sh", type: "text/x-shellscript; charset=utf-8", template: true },
  "venstudio-worker.ts": { source: "venstudio-worker.ts", type: "text/plain; charset=utf-8" },
};

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const entry = FILES[file];
  if (!entry) return new Response("Not found", { status: 404 });
  const dir = path.resolve(process.cwd(), env().WORKER_DIR);
  let body = await readFile(path.join(dir, entry.source), "utf8");
  if (entry.template) body = body.replaceAll("{{PORTAL_URL}}", env().APP_URL.replace(/\/+$/, ""));
  return new Response(body, {
    headers: { "content-type": entry.type, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
