-- Studio: asset library with provenance, and productions (style-driven plans).

CREATE TABLE assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('video', 'reference-video', 'image', 'audio', 'font',
                                              'sprite-sheet', 'model-3d', 'script', 'other')),
  -- Where it came from. Every asset needs a licence note; uploads and licensed files also need an origin link.
  source        text NOT NULL CHECK (source IN ('upload', 'hermes', 'muse', 'worker', 'licensed', 'generated')),
  license       text NOT NULL DEFAULT '',
  origin_url    text NOT NULL DEFAULT '',
  tags          text[] NOT NULL DEFAULT '{}',
  channel_id    uuid REFERENCES channels(id) ON DELETE SET NULL,
  content_type  text,
  bytes         bigint,
  sha256        text,
  storage_path  text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_kind_idx ON assets(kind, created_at DESC);

CREATE TABLE productions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL,
  brief              text NOT NULL DEFAULT '',
  channel_id         uuid REFERENCES channels(id) ON DELETE SET NULL,
  format             text NOT NULL CHECK (format IN ('short', 'long')),
  style_id           text NOT NULL,
  theme_id           text NOT NULL DEFAULT '',
  workflow           text NOT NULL DEFAULT 'original' CHECK (workflow IN ('original', 'copycat-structure')),
  reference_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned', 'in_progress', 'awaiting_review', 'approved', 'published', 'cancelled')),
  plan               jsonb NOT NULL DEFAULT '{}',
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX productions_created_idx ON productions(created_at DESC);
