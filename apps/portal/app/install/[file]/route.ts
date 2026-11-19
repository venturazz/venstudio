import { INSTALL_FILES, renderInstallFile } from "@/lib/server/install-files.ts";

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const body = await renderInstallFile(file);
  if (body === null) return new Response("Not found", { status: 404 });
  return new Response(body, {
    headers: { "content-type": INSTALL_FILES[file].type, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
