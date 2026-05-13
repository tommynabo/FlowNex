-- Autopilot V2 migration
-- Run this once against your Supabase project to align column defaults with the
-- new autopilot engine (active window 09:00–21:00 by default instead of 22:00–06:00).

-- Update default time window on campaigns table
ALTER TABLE public.campaigns
  ALTER COLUMN autopilot_start_hour   SET DEFAULT 9,
  ALTER COLUMN autopilot_end_hour     SET DEFAULT 21,
  ADD COLUMN IF NOT EXISTS autopilot_start_minute SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS autopilot_end_minute   SMALLINT NOT NULL DEFAULT 0;

-- Add target_leads column to autopilot_runs for run-level diagnostics
ALTER TABLE public.autopilot_runs
  ADD COLUMN IF NOT EXISTS target_leads SMALLINT;

-- Back-fill existing rows that still have the old 22/6 defaults so the UI
-- shows the correct 09:00–21:00 window for campaigns that were never manually configured.
UPDATE public.campaigns
SET
  autopilot_start_hour = 9,
  autopilot_end_hour   = 21
WHERE
  autopilot_start_hour = 22
  AND autopilot_end_hour = 6;
