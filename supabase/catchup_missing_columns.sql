-- ============================================================
-- FlowNext – Catch-up Migration (run in Supabase SQL Editor)
-- Project: biltmzurmhvgdprpekoa
-- Safe to run multiple times (all IF NOT EXISTS)
-- ============================================================

-- ── 1. instantly_campaign_id (add_instantly_campaign_id.sql) ─────────────────
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS instantly_campaign_id TEXT DEFAULT NULL;

-- ── 2. icp_type (add_icp_type_to_campaigns.sql) ──────────────────────────────
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS icp_type TEXT NOT NULL DEFAULT 'personal_brand';

-- ── 3. Autopilot columns (autopilot_migration.sql) ───────────────────────────
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS autopilot_enabled        BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS autopilot_start_hour     SMALLINT    DEFAULT 22,
  ADD COLUMN IF NOT EXISTS autopilot_end_hour       SMALLINT    DEFAULT 6,
  ADD COLUMN IF NOT EXISTS autopilot_batch_size     SMALLINT    DEFAULT 5,
  ADD COLUMN IF NOT EXISTS autopilot_daily_limit    SMALLINT    DEFAULT 50,
  ADD COLUMN IF NOT EXISTS autopilot_leads_today    SMALLINT    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS autopilot_reset_date     DATE,
  ADD COLUMN IF NOT EXISTS autopilot_last_run_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS autopilot_timezone       TEXT        DEFAULT 'UTC';

-- ── 4. Trigger: auto-increment lead counts on INSERT ─────────────────────────
CREATE OR REPLACE FUNCTION public.increment_campaign_lead_counts()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.campaign_id IS NOT NULL THEN
    UPDATE public.campaigns
    SET
      total_leads      = COALESCE(total_leads, 0) + 1,
      leads_with_email = COALESCE(leads_with_email, 0) + (CASE WHEN NEW.email IS NOT NULL AND NEW.email <> '' THEN 1 ELSE 0 END),
      updated_at       = NOW()
    WHERE id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_increment_campaign_lead_counts ON public.leads;
CREATE TRIGGER trg_increment_campaign_lead_counts
  AFTER INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.increment_campaign_lead_counts();

-- ── 5. autopilot_runs audit table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.autopilot_runs (
  id                       UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id              UUID        REFERENCES public.campaigns(id) ON DELETE CASCADE NOT NULL,
  user_id                  UUID        REFERENCES public.profiles(id)  ON DELETE CASCADE NOT NULL,
  started_at               TIMESTAMPTZ DEFAULT NOW(),
  finished_at              TIMESTAMPTZ,
  leads_found              INTEGER     DEFAULT 0,
  leads_added_to_instantly INTEGER     DEFAULT 0,
  status                   TEXT        DEFAULT 'running' CHECK (status IN ('running','success','error','skipped')),
  error_message            TEXT,
  batch_size               SMALLINT,
  daily_total_after        SMALLINT
);

CREATE INDEX IF NOT EXISTS autopilot_runs_campaign_id_idx ON public.autopilot_runs(campaign_id);
CREATE INDEX IF NOT EXISTS autopilot_runs_user_id_idx     ON public.autopilot_runs(user_id);
CREATE INDEX IF NOT EXISTS autopilot_runs_started_at_idx  ON public.autopilot_runs(started_at DESC);

ALTER TABLE public.autopilot_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "autopilot_runs_select" ON public.autopilot_runs;
CREATE POLICY "autopilot_runs_select" ON public.autopilot_runs
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "autopilot_runs_insert" ON public.autopilot_runs;
CREATE POLICY "autopilot_runs_insert" ON public.autopilot_runs
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "autopilot_runs_update" ON public.autopilot_runs;
CREATE POLICY "autopilot_runs_update" ON public.autopilot_runs
  FOR UPDATE USING (true);
