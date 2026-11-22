-- Signed automatic worker updates. See docs/worker-updates.md.
--
-- Additive only: two new tables and new nullable columns on workers; no existing column or row changes.
--
-- update_signing_keys: the portal's Ed25519 key pair, generated on first use (lib/server/update-key.ts). The public key
-- is served inside install.sh, so the owner's one sha256 check of install.sh also pins it. The private key is stored
-- encrypted with ENCRYPTION_KEY (AES-256-GCM, lib/crypto/secretbox.ts, AAD "update-signing-key:<key_id>"), the same
-- way TOTP secrets are. One row: a second key would silently orphan every worker that pinned the first.
CREATE TABLE IF NOT EXISTS update_signing_keys (
  id              text PRIMARY KEY DEFAULT 'portal' CHECK (id = 'portal'),
  key_id          text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  algorithm       text NOT NULL DEFAULT 'ed25519' CHECK (algorithm = 'ed25519'),
  public_key      text NOT NULL,
  private_key_enc text NOT NULL CHECK (private_key_enc LIKE 'v1.%'),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The owner's update switch. One row. pinned_version lets workers accept that exact version even when it is older
-- than theirs (a deliberate downgrade); without it workers refuse downgrades.
CREATE TABLE IF NOT EXISTS worker_update_settings (
  id             text PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  mode           text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'approve', 'off')),
  pinned_version text CHECK (pinned_version IS NULL OR pinned_version ~ '^[0-9]{1,6}(\.[0-9]{1,6}){0,3}$'),
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO worker_update_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

-- Per worker: what it was last offered, what the owner approved, the key it pinned, and its last update result.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS update_offered_version  text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS update_offered_release  text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS update_approved_release text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS update_key_id           text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS update_checked_at       timestamptz;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS update_status           text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS update_detail           text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS update_result_version   text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS update_result_at        timestamptz;
ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_update_status_check;
ALTER TABLE workers ADD CONSTRAINT workers_update_status_check
  CHECK (update_status IS NULL OR update_status IN ('ok', 'refused', 'rolled_back', 'failed'));
