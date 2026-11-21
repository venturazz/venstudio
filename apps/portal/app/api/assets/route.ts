import path from "node:path";
import { z } from "zod";
import { audit } from "@/lib/server/audit.ts";
import { getSession, hasRole } from "@/lib/server/auth.ts";
import { deleteAssetRow, finishAssetUpload, insertAssetRow } from "@/lib/server/assets.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { contentTypeFor, saveAsset, TooLargeError } from "@/lib/server/storage.ts";
import { jsonError } from "@/lib/server/worker-api.ts";
import { ASSET_KINDS, ASSET_SOURCES } from "@/lib/studio/catalog.ts";
import { MUSIC_TAG } from "@/lib/studio/music-bed.ts";

export const dynamic = "force-dynamic";

const query = z.object({
  title: z.string().trim().min(1, "Give the file a title").max(120),
  kind: z.enum(ASSET_KINDS),
  source: z.enum(ASSET_SOURCES),
  license: z
    .string()
    .trim()
    .min(2, "Add a licence or permission note, e.g. 'owned', 'CC0' or 'licensed from …'")
    .max(300),
  originUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^https?:\/\//.test(v), "The origin must be a web address (https://…)")
    .default(""),
  tags: z.string().max(200).default(""),
  /** "1" when the owner ticked "This is a music track for video beds": the asset gets the music tag. */
  music: z.enum(["", "1"]).default(""),
  channelId: z.union([z.uuid(), z.literal("")]).default(""),
  filename: z.string().max(200).default("file"),
});

/** Names that look like credential files. Keys belong in Coolify's environment, never in the library. */
const CREDENTIAL_NAME = /(client[_ -]?secret|service[_ -]?account|credentials?|private[_ -]?key|key)\.json$/i;

/** Stored file name: safe characters only, and never starting with a dot. */
function storedName(filename: string): string {
  const base = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return /^[A-Za-z0-9]/.test(base) ? base : `file-${base}`.slice(0, 100);
}

/** Upload one file to the asset library. The body is the raw file; details go in the query string. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session || session.mfaPending) return jsonError(401, "Sign in required");
  if (!hasRole(session.role, "editor")) return jsonError(403, "Only editors can add assets");
  if (!req.body) return jsonError(400, "Empty upload");

  const parsed = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const q = parsed.data;
  if (CREDENTIAL_NAME.test(q.filename)) {
    return jsonError(400, "This looks like a credentials file. Put API keys and OAuth secrets in Coolify environment variables, not in Assets.");
  }
  if (q.music === "1" && q.kind !== "audio") return jsonError(400, "Only an audio file can be a music track. Choose the audio kind, or untick the music box.");
  const meta = await requestMeta();

  const id = await insertAssetRow({
    title: q.title,
    kind: q.kind,
    source: q.source,
    license: q.license,
    originUrl: q.originUrl,
    // The render stage takes a bed only from audio tagged music (lib/studio/music-bed.ts).
    tags: q.music === "1" ? [q.tags, MUSIC_TAG].filter(Boolean).join(",") : q.tags,
    channelId: q.channelId,
    createdBy: session.id,
  });
  const name = storedName(q.filename);
  let saved;
  try {
    saved = await saveAsset(id, name, req.body);
  } catch (err) {
    await deleteAssetRow(id);
    if (err instanceof TooLargeError) return jsonError(413, err.message);
    console.error("asset upload failed", err);
    return jsonError(500, "Upload failed");
  }
  await finishAssetUpload(id, {
    contentType: contentTypeFor(name, req.headers.get("content-type")),
    bytes: saved.bytes,
    sha256: saved.sha256,
    storagePath: saved.storagePath,
  });
  await audit({ userId: session.id, action: "asset.upload", target: id, detail: { kind: q.kind, source: q.source, music: q.music === "1" }, ip: meta.ip });
  return Response.json({ id, title: q.title, bytes: saved.bytes, sha256: saved.sha256 }, { status: 201 });
}
