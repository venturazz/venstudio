-- The job types a worker reported at its last claim, so the portal can explain why a job is waiting.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS job_types text[] NOT NULL DEFAULT '{}';
