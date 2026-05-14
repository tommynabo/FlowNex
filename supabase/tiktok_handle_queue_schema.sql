-- ── tiktok_handle_queue ──────────────────────────────────────────────────────
-- Stores TikTok handles imported manually from Apify scraper JSON exports.
-- The autopilot cron drains this table (ORDER BY position ASC) BEFORE running
-- new Serper keyword searches, so pre-paid scraper results are never wasted.
--
-- Status lifecycle:
--   pending → processing → passed_icp → added
--                       ↘ failed_icp
--                       ↘ no_email      (passed ICP but email discovery failed)
--   processing → pending  (reset on actor failure, retried next run)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tiktok_handle_queue (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid        REFERENCES auth.users        NOT NULL,
  campaign_id uuid        REFERENCES public.campaigns  NOT NULL,
  handle      text        NOT NULL,
  position    integer     NOT NULL,   -- 0-based index in the original JSON file; drain ORDER BY position ASC
  status      text        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','processing','passed_icp','failed_icp','no_email','added')),
  created_at  timestamptz DEFAULT now()
);

-- Unique constraint: one entry per (campaign, handle) — re-importing same JSON is a no-op
CREATE UNIQUE INDEX IF NOT EXISTS tiktok_handle_queue_campaign_handle_key
  ON public.tiktok_handle_queue (campaign_id, handle);

-- Index for the cron drain query: WHERE campaign_id=X AND status='pending' ORDER BY position ASC
CREATE INDEX IF NOT EXISTS tiktok_handle_queue_drain_idx
  ON public.tiktok_handle_queue (campaign_id, status, position ASC);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.tiktok_handle_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own queue"
  ON public.tiktok_handle_queue FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own queue"
  ON public.tiktok_handle_queue FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own queue"
  ON public.tiktok_handle_queue FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own queue"
  ON public.tiktok_handle_queue FOR DELETE
  USING (auth.uid() = user_id);

-- Service-role policy for the cron (uses service key, bypasses RLS anyway — explicit for clarity)
-- No additional policy needed: service role bypasses RLS by default.
