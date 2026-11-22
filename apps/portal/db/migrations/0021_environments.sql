-- Environments (worker 0.12.0, engine command; docs/style-packs.md "Environments"). Additive only.
--
-- workers.environments: what the worker said in its last claim about the environments its installed packs need, one
-- object per environment: { id, version, status: installing | ready | failed, detail, packs: ["<id>@<version>"], at }.
-- The Workers page lists them and the Styles and New Video pages say "A worker has env:<id>@<version>", "installing…"
-- or "failed: <reason>". A ready environment is also in workers.capabilities as env:<id>@<version> (after its probe
-- passed on that worker); routing only ever reads capabilities. No existing column or row changes.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS environments jsonb NOT NULL DEFAULT '[]'::jsonb;
