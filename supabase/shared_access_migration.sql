-- ============================================================
-- FlowNext – Shared Access Migration
-- Makes ALL data visible to ALL authenticated users in the project.
-- Any user added in Supabase Authentication > Users will see every
-- campaign, lead, setter conversation, etc. from the moment they log in.
--
-- Run this ONCE in Supabase > SQL Editor.
-- Safe to re-run (uses DROP IF EXISTS + CREATE pattern).
-- ============================================================

-- ── PROFILES ─────────────────────────────────────────────────────────────────
-- Allow any authenticated user to view all profiles
-- (needed to show "created by" info in the UI)
DROP POLICY IF EXISTS "profiles_select"                  ON public.profiles;
DROP POLICY IF EXISTS "Users can view their own profile"  ON public.profiles;
DROP POLICY IF EXISTS "Users can view own profile"        ON public.profiles;

CREATE POLICY "profiles_select_all"
  ON public.profiles FOR SELECT
  USING (auth.role() = 'authenticated');


-- ── CAMPAIGNS ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "campaigns_select"                          ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_update"                          ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_delete"                          ON public.campaigns;
DROP POLICY IF EXISTS "Users can view their own campaigns"        ON public.campaigns;
DROP POLICY IF EXISTS "Users can update their own campaigns"      ON public.campaigns;
DROP POLICY IF EXISTS "Users can delete their own campaigns"      ON public.campaigns;

CREATE POLICY "campaigns_select_all"
  ON public.campaigns FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "campaigns_update_all"
  ON public.campaigns FOR UPDATE
  USING (auth.role() = 'authenticated');

CREATE POLICY "campaigns_delete_all"
  ON public.campaigns FOR DELETE
  USING (auth.role() = 'authenticated');


-- ── LEADS ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "leads_select"                       ON public.leads;
DROP POLICY IF EXISTS "leads_update"                       ON public.leads;
DROP POLICY IF EXISTS "Users can view their own leads"     ON public.leads;
DROP POLICY IF EXISTS "Users can update their own leads"   ON public.leads;

CREATE POLICY "leads_select_all"
  ON public.leads FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "leads_update_all"
  ON public.leads FOR UPDATE
  USING (auth.role() = 'authenticated');


-- ── SEARCH_HISTORY ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "search_history_select"                          ON public.search_history;
DROP POLICY IF EXISTS "search_history_update"                          ON public.search_history;
DROP POLICY IF EXISTS "Users can view their own search history"        ON public.search_history;
DROP POLICY IF EXISTS "Users can update their own search history"      ON public.search_history;

CREATE POLICY "search_history_select_all"
  ON public.search_history FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "search_history_update_all"
  ON public.search_history FOR UPDATE
  USING (auth.role() = 'authenticated');


-- ── SEARCH_CRITERIA (only if table exists) ──────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'search_criteria') THEN
    DROP POLICY IF EXISTS "Users can view their own search criteria"   ON public.search_criteria;
    DROP POLICY IF EXISTS "Users can update their own search criteria" ON public.search_criteria;
    EXECUTE 'CREATE POLICY "search_criteria_select_all" ON public.search_criteria FOR SELECT USING (auth.role() = ''authenticated'')';
    EXECUTE 'CREATE POLICY "search_criteria_update_all" ON public.search_criteria FOR UPDATE USING (auth.role() = ''authenticated'')';
  END IF;
END $$;


-- ── MESSAGE_TEMPLATES (only if table exists) ─────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'message_templates') THEN
    DROP POLICY IF EXISTS "Users can view their own messages"   ON public.message_templates;
    DROP POLICY IF EXISTS "Users can update their own messages" ON public.message_templates;
    EXECUTE 'CREATE POLICY "message_templates_select_all" ON public.message_templates FOR SELECT USING (auth.role() = ''authenticated'')';
    EXECUTE 'CREATE POLICY "message_templates_update_all" ON public.message_templates FOR UPDATE USING (auth.role() = ''authenticated'')';
  END IF;
END $$;


-- ── DAILY_CONTACT_LOG (only if table exists) ─────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'daily_contact_log') THEN
    DROP POLICY IF EXISTS "Users can view their own contact log" ON public.daily_contact_log;
    EXECUTE 'CREATE POLICY "daily_contact_log_select_all" ON public.daily_contact_log FOR SELECT USING (auth.role() = ''authenticated'')';
  END IF;
END $$;


-- ── DEDUPLICATION_LOG (only if table exists) ─────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'deduplication_log') THEN
    DROP POLICY IF EXISTS "Users can view their own deduplication log" ON public.deduplication_log;
    EXECUTE 'CREATE POLICY "deduplication_log_select_all" ON public.deduplication_log FOR SELECT USING (auth.role() = ''authenticated'')';
  END IF;
END $$;


-- ── LEAD_CONVERSATIONS (AI Setter) ───────────────────────────────────────────
DROP POLICY IF EXISTS "Users read own conversations"   ON public.lead_conversations;
DROP POLICY IF EXISTS "Users update own conversations" ON public.lead_conversations;

CREATE POLICY "lead_conversations_select_all"
  ON public.lead_conversations FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "lead_conversations_update_all"
  ON public.lead_conversations FOR UPDATE
  USING (auth.role() = 'authenticated');


-- ── SETTER_FEEDBACK ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users read own feedback"   ON public.setter_feedback;
DROP POLICY IF EXISTS "Users update own feedback" ON public.setter_feedback;

CREATE POLICY "setter_feedback_select_all"
  ON public.setter_feedback FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "setter_feedback_update_all"
  ON public.setter_feedback FOR UPDATE
  USING (auth.role() = 'authenticated');


-- ── AUTOPILOT_RUNS ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "autopilot_runs_select" ON public.autopilot_runs;

CREATE POLICY "autopilot_runs_select_all"
  ON public.autopilot_runs FOR SELECT
  USING (auth.role() = 'authenticated');


-- ── BACKFILL: Ensure all existing auth users have a profile ──────────────────
-- Creates a profile for any user who signed up before this trigger existed.
INSERT INTO public.profiles (id, email, full_name)
SELECT
  au.id,
  au.email,
  COALESCE(au.raw_user_meta_data->>'full_name', split_part(au.email, '@', 1))
FROM auth.users au
LEFT JOIN public.profiles p ON p.id = au.id
WHERE p.id IS NULL;
