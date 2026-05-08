-- ============================================================
-- FlowNext – Autopilot Serverless Migration
-- Run ONCE in Supabase SQL Editor
-- Adds autopilot scheduling fields to campaigns + audit log table
-- ============================================================


-- ── 1. ADD AUTOPILOT COLUMNS TO CAMPAIGNS ────────────────────────────────────

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS autopilot_enabled        BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS autopilot_start_hour     SMALLINT    DEFAULT 22    CHECK (autopilot_start_hour >= 0 AND autopilot_start_hour <= 23),
  ADD COLUMN IF NOT EXISTS autopilot_end_hour       SMALLINT    DEFAULT 6     CHECK (autopilot_end_hour >= 0 AND autopilot_end_hour <= 23),
  ADD COLUMN IF NOT EXISTS autopilot_batch_size     SMALLINT    DEFAULT 5     CHECK (autopilot_batch_size >= 1 AND autopilot_batch_size <= 20),
  ADD COLUMN IF NOT EXISTS autopilot_daily_limit    SMALLINT    DEFAULT 50    CHECK (autopilot_daily_limit >= 1 AND autopilot_daily_limit <= 500),
  ADD COLUMN IF NOT EXISTS autopilot_leads_today    SMALLINT    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS autopilot_reset_date     DATE,
  ADD COLUMN IF NOT EXISTS autopilot_last_run_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS autopilot_timezone       TEXT        DEFAULT 'UTC';

-- ── 2. CREATE AUTOPILOT_RUNS AUDIT TABLE ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.autopilot_runs (
  id                       UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id              UUID        REFERENCES public.campaigns(id) ON DELETE CASCADE NOT NULL,
  user_id                  UUID        REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  started_at               TIMESTAMPTZ DEFAULT NOW(),
  finished_at              TIMESTAMPTZ,
  leads_found              INTEGER     DEFAULT 0,
  leads_added_to_instantly INTEGER     DEFAULT 0,
  status                   TEXT        DEFAULT 'running' CHECK (status IN ('running', 'success', 'error', 'skipped')),
  error_message            TEXT,
  batch_size               SMALLINT,
  daily_total_after        SMALLINT
);

CREATE INDEX IF NOT EXISTS autopilot_runs_campaign_id_idx ON public.autopilot_runs(campaign_id);
CREATE INDEX IF NOT EXISTS autopilot_runs_user_id_idx     ON public.autopilot_runs(user_id);
CREATE INDEX IF NOT EXISTS autopilot_runs_started_at_idx  ON public.autopilot_runs(started_at DESC);

ALTER TABLE public.autopilot_runs ENABLE ROW LEVEL SECURITY;

-- Users read only their own runs
DROP POLICY IF EXISTS "autopilot_runs_select" ON public.autopilot_runs;
CREATE POLICY "autopilot_runs_select" ON public.autopilot_runs
  FOR SELECT USING (auth.uid() = user_id);

-- Service role writes (cron uses service role key which bypasses RLS)
DROP POLICY IF EXISTS "autopilot_runs_insert" ON public.autopilot_runs;
CREATE POLICY "autopilot_runs_insert" ON public.autopilot_runs
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "autopilot_runs_update" ON public.autopilot_runs;
CREATE POLICY "autopilot_runs_update" ON public.autopilot_runs
  FOR UPDATE USING (true);
