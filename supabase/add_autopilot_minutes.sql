-- ============================================================
-- FlowNext – Add minute-precision to autopilot schedule
-- Adds autopilot_start_minute and autopilot_end_minute columns
-- to the campaigns table. Defaults to 0 — fully backward-compatible
-- with existing campaigns that only used hour-level granularity.
--
-- Run once in Supabase > SQL Editor.
-- ============================================================

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS autopilot_start_minute INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS autopilot_end_minute   INTEGER NOT NULL DEFAULT 0;
