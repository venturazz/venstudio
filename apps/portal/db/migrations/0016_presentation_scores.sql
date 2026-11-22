-- Style system Phase 2 (docs/style-packs.md): the presentation score on the curation log. Additive only: new
-- nullable columns on style_trial_outcomes, no existing column or row changes.
--
-- owner_rubric      the owner's 1-5 stars (hook, pacing, legibility, polish, audio) behind presentation_score, which
--                   stays the 0-100 G-presentation score the promotion rule reads (lib/studio/presentation.ts)
-- presentation_by   who gave presentation_score: 'owner' (Review card); null when unscored
-- hermes_advisory   Hermes's vision rating of sampled frames ({ score, rubric, notes, frames, at }); advisory only,
--                   never part of the rule
-- renderer          the renderer that drew the video: ffmpeg-stills, remotion-2d, html-capture or hermes
ALTER TABLE style_trial_outcomes ADD COLUMN IF NOT EXISTS owner_rubric jsonb CHECK (owner_rubric IS NULL OR jsonb_typeof(owner_rubric) = 'object');
ALTER TABLE style_trial_outcomes ADD COLUMN IF NOT EXISTS presentation_by text CHECK (presentation_by IN ('owner'));
ALTER TABLE style_trial_outcomes ADD COLUMN IF NOT EXISTS hermes_advisory jsonb CHECK (hermes_advisory IS NULL OR jsonb_typeof(hermes_advisory) = 'object');
ALTER TABLE style_trial_outcomes ADD COLUMN IF NOT EXISTS renderer text CHECK (renderer IS NULL OR renderer ~ '^[a-z0-9][a-z0-9-]{1,39}$');
