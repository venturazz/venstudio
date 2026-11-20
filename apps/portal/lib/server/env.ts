import "server-only";
import { z } from "zod";
import { parseKey } from "../crypto/secretbox.ts";

/** Compose passes unset variables as "". Treat that as not set. */
const optional = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === "" ? undefined : v), t.optional());

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY is required (openssl rand -base64 32)"),
  SETUP_TOKEN: optional(z.string()),
  ARTIFACT_DIR: z.string().default("./data/artifacts"),
  MAX_ARTIFACT_MB: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().default(2048)),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  WORKER_DIR: z.string().default("../worker"),
  NINEROUTER_BASE_URL: optional(z.string().url()),
  NINEROUTER_API_KEY: optional(z.string()),
  HERMES_BASE_URL: optional(z.string().url()),
  HERMES_API_KEY: optional(z.string()),
  KOKORO_BASE_URL: optional(z.string().url()),
  KOKORO_API_KEY: optional(z.string()),
  KOKORO_MODEL: optional(z.string()),
  KOKORO_VOICE: optional(z.string()),
  TTS_BACKUP: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["hermes-capcut", "off"]).default("hermes-capcut")),
  HERMES_IMAGE_PROVIDER_ORDER: optional(z.string()),
  HERMES_MEDIA_ORIGINS: optional(z.string()),
  /** Where the studio reads generated images from. May include a path (http://hermes-files:8000/img). Falls back to the first HERMES_MEDIA_ORIGINS entry. */
  HERMES_IMAGE_MEDIA_ORIGIN: optional(z.string()),
  /** Where the studio reads narration audio from. May include a path (http://hermes-files:8000/tts). Falls back to the first HERMES_MEDIA_ORIGINS entry. */
  HERMES_TTS_MEDIA_ORIGIN: optional(z.string()),
  MUSE_AGENT_TASKS: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["1", "0"]).default("0")),
});

export type Env = z.infer<typeof schema>;

let cached: (Env & { encryptionKey: Buffer }) | undefined;

/** Validated server environment. Read lazily so `next build` works without secrets. */
export function env() {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  cached = { ...parsed.data, encryptionKey: parseKey(parsed.data.ENCRYPTION_KEY) };
  return cached;
}

export const isProduction = process.env.NODE_ENV === "production";
