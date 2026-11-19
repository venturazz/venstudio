-- A production can queue one test render; the job id is kept here so the plan shows its status.
ALTER TABLE productions ADD COLUMN IF NOT EXISTS preview_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL;
