import "server-only";
import { headers } from "next/headers";
import { env } from "./env.ts";

/** Client IP. Only trusts X-Forwarded-For when TRUST_PROXY=true (portal behind Caddy). */
export function ipFromHeaders(h: Headers): string {
  if (env().TRUST_PROXY === "true") {
    const xff = h.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim().slice(0, 64);
    const real = h.get("x-real-ip");
    if (real) return real.trim().slice(0, 64);
  }
  return "direct";
}

export async function requestMeta() {
  const h = await headers();
  return { ip: ipFromHeaders(h), userAgent: (h.get("user-agent") ?? "").slice(0, 300) };
}
