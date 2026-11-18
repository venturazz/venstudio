import "server-only";
import { z } from "zod";
import { parseKey } from "../crypto/secretbox.ts";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY is required (openssl rand -base64 32)"),
  SETUP_TOKEN: z.string().optional(),
  ARTIFACT_DIR: z.string().default("./data/artifacts"),
  MAX_ARTIFACT_MB: z.coerce.number().int().positive().default(2048),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  WORKER_DIR: z.string().default("../worker"),
  NINEROUTER_BASE_URL: z.string().url().optional(),
  NINEROUTER_API_KEY: z.string().optional(),
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
