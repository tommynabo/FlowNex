-- content_verification_migration.sql
-- Run this once against your Supabase project to support the async content
-- verification pipeline introduced by ContentVerificationService.
--
-- Apply via Supabase Dashboard > SQL Editor, or:
--   psql $DATABASE_URL -f supabase/content_verification_migration.sql

-- ── Ensure base table exists ──────────────────────────────────────────────────
-- search_results is defined in schema.sql. If it hasn't been applied yet,
-- this block creates it so the index below can be added safely.

CREATE TABLE IF NOT EXISTS public.search_results (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid REFERENCES auth.users NOT NULL,
  session_id  text,
  platform    text,
  query       text,
  lead_data   jsonb,
  status      text DEFAULT 'new',
  created_at  timestamptz DEFAULT now()
);

-- Base indexes (idempotent — safe to run even if schema.sql was already applied)
CREATE INDEX IF NOT EXISTS idx_search_results_user    ON public.search_results (user_id);
CREATE INDEX IF NOT EXISTS idx_search_results_session ON public.search_results (session_id);

-- RLS (only adds policies if they don't exist yet)
ALTER TABLE public.search_results ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'search_results' AND policyname = 'Users can view own results'
  ) THEN
    CREATE POLICY "Users can view own results"
      ON public.search_results FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'search_results' AND policyname = 'Users can insert own results'
  ) THEN
    CREATE POLICY "Users can insert own results"
      ON public.search_results FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'search_results' AND policyname = 'Users can update own results'
  ) THEN
    -- Needed by the cron job (service role bypasses RLS, but good to have for completeness)
    CREATE POLICY "Users can update own results"
      ON public.search_results FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;

-- ── Index for fast cron queries ───────────────────────────────────────────────
-- The cron job queries: WHERE lead_data->>'status' = 'pending_content_verification'
-- Without this index the query is a full JSONB table scan.

CREATE INDEX IF NOT EXISTS idx_search_results_lead_status
  ON public.search_results ((lead_data->>'status'));

-- ── Verify ────────────────────────────────────────────────────────────────────
-- After running, confirm with:
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'search_results'
--   AND indexname = 'idx_search_results_lead_status';
