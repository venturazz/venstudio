// Applies db/migrations/*.sql in filename order, once each, inside a transaction per file.
// Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  // Serialize concurrent migrators (e.g. two containers starting at once).
  await sql`SELECT pg_advisory_lock(727001)`;

  const applied = new Set((await sql`SELECT version FROM schema_migrations`).map((r) => r.version));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(path.join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    });
    console.log(`applied ${file}`);
  }
  console.log("migrations up to date");
} finally {
  await sql`SELECT pg_advisory_unlock(727001)`.catch(() => {});
  await sql.end();
}
