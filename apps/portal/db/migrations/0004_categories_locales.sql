-- Channel category (set by the owner, never assigned automatically) and locale choices for productions.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';

ALTER TABLE productions ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
ALTER TABLE productions ADD COLUMN IF NOT EXISTS subtitles text[] NOT NULL DEFAULT '{}';
ALTER TABLE productions ADD COLUMN IF NOT EXISTS purposes text[] NOT NULL DEFAULT '{}';
