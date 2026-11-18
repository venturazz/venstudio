import "server-only";
import postgres, { type Sql } from "postgres";
import { env } from "./env.ts";

declare global {
  // Reuse one pool across hot reloads in development.
  var __venstudioSql: Sql | undefined;
}

export function db(): Sql {
  if (!globalThis.__venstudioSql) {
    globalThis.__venstudioSql = postgres(env().DATABASE_URL, {
      max: 10,
      idle_timeout: 30,
      onnotice: () => {},
    });
  }
  return globalThis.__venstudioSql;
}
