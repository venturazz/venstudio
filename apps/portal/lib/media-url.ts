/**
 * Where Hermes-made files are published, per kind. Pure, so it is unit tested.
 *
 * The media host (deploy/hermes-files.nginx.conf, or the bridge inside Hermes) serves each kind under its own
 * prefix. One origin is enough for the owner to set: HERMES_MEDIA_ORIGINS=http://hermes-files:8000. The portal
 * adds the prefix itself. A per-kind override still wins, and an origin that already carries a path is used as is.
 */
export type MediaKind = "image" | "audio" | "video";

/** The prefixes deploy/hermes-files.nginx.conf serves. Audio is narration, which Hermes writes under cache/tts. */
export const MEDIA_PREFIX: Record<MediaKind, string> = { image: "/img", audio: "/tts", video: "/clip" };

export function mediaUrlBase(kind: MediaKind, opts: { override?: string; origins?: string }): string | null {
  const override = (opts.override ?? "").trim();
  if (override) return cleanUrl(override);
  const first = ((opts.origins ?? "").split(",")[0] ?? "").trim();
  if (!first) return null;
  let u: URL;
  try {
    u = new URL(first);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // An origin with its own path is a deliberate layout: keep it.
  if (u.pathname !== "/" && u.pathname !== "") return cleanUrl(first);
  return `${u.protocol}//${u.host}${MEDIA_PREFIX[kind]}`;
}

function cleanUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}
