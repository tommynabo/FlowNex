-- ============================================================
-- FlowNext – Complete Database Setup (blank project)
-- Run this ONCE in Supabase SQL Editor
-- Order: profiles → campaigns → leads → search_history → views/triggers
-- ============================================================


-- ── 1. PROFILES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id           UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL PRIMARY KEY,
  full_name    TEXT,
  email        TEXT,
  company_name TEXT,
  target_icp   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='profiles_select') THEN
    CREATE POLICY "profiles_select" ON public.profiles FOR SELECT USING (auth.uid() = id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='profiles_insert') THEN
    CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='profiles_update') THEN
    CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE USING (auth.uid() = id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)), NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ── 2. CAMPAIGNS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.campaigns (
  id                 UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id            UUID        REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  name               TEXT        NOT NULL,
  description        TEXT,
  status             TEXT        DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
  hashtags           TEXT[]      DEFAULT '{}',
  icp_min_followers  INTEGER     DEFAULT 0,
  icp_max_followers  INTEGER     DEFAULT 99000000,
  icp_regions        TEXT[]      DEFAULT '{}',
  icp_content_types  TEXT[]      DEFAULT '{}',
  total_leads        INTEGER     DEFAULT 0,
  leads_with_email   INTEGER     DEFAULT 0,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaigns_user_id_idx    ON public.campaigns(user_id);
CREATE INDEX IF NOT EXISTS campaigns_status_idx     ON public.campaigns(status);
CREATE INDEX IF NOT EXISTS campaigns_created_at_idx ON public.campaigns(created_at DESC);

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='campaigns' AND policyname='campaigns_select') THEN
    CREATE POLICY "campaigns_select" ON public.campaigns FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='campaigns' AND policyname='campaigns_insert') THEN
    CREATE POLICY "campaigns_insert" ON public.campaigns FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='campaigns' AND policyname='campaigns_update') THEN
    CREATE POLICY "campaigns_update" ON public.campaigns FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='campaigns' AND policyname='campaigns_delete') THEN
    CREATE POLICY "campaigns_delete" ON public.campaigns FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.update_campaign_timestamp()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaigns_updated_at ON public.campaigns;
CREATE TRIGGER campaigns_updated_at
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_campaign_timestamp();


-- ── 3. LEADS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leads (
  id                 UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id            UUID        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  search_id          UUID,
  campaign_id        UUID        REFERENCES public.campaigns(id) ON DELETE SET NULL,
  -- Identity
  name               TEXT        NOT NULL DEFAULT '',
  job_title          TEXT,
  email              TEXT        DEFAULT '',
  phone              TEXT,
  location           TEXT,
  region             TEXT,
  -- Instagram-specific
  ig_handle          TEXT,
  ig_url             TEXT,
  follower_count     INTEGER     DEFAULT 0,
  niche              TEXT,
  audience_tier      TEXT        DEFAULT 'nano',
  content_type       TEXT,
  bio                TEXT,
  profile_pic_url    TEXT,
  posts_count        INTEGER     DEFAULT 0,
  engagement_rate    FLOAT       DEFAULT 0,
  is_verified        BOOLEAN     DEFAULT FALSE,
  -- AI outputs
  ai_summary         TEXT,
  ai_pain_points     TEXT[]      DEFAULT '{}',
  cold_email_subject TEXT,
  cold_email_body    TEXT,
  vsl_pitch          TEXT,
  -- Status
  vsl_sent_status    TEXT        DEFAULT 'pending',
  email_status       TEXT        DEFAULT 'pending',
  status             TEXT        DEFAULT 'scraped',
  contacted_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leads_user_id_idx       ON public.leads(user_id);
CREATE INDEX IF NOT EXISTS leads_campaign_id_idx   ON public.leads(campaign_id);
CREATE INDEX IF NOT EXISTS leads_status_idx        ON public.leads(status);
CREATE INDEX IF NOT EXISTS leads_audience_tier_idx ON public.leads(audience_tier);
CREATE INDEX IF NOT EXISTS leads_follower_idx      ON public.leads(follower_count DESC);
CREATE INDEX IF NOT EXISTS leads_niche_idx         ON public.leads(niche);
CREATE INDEX IF NOT EXISTS leads_email_status_idx  ON public.leads(email_status);
CREATE INDEX IF NOT EXISTS leads_created_at_idx    ON public.leads(created_at DESC);

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='leads' AND policyname='leads_select') THEN
    CREATE POLICY "leads_select" ON public.leads FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='leads' AND policyname='leads_insert') THEN
    CREATE POLICY "leads_insert" ON public.leads FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='leads' AND policyname='leads_update') THEN
    CREATE POLICY "leads_update" ON public.leads FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;


-- ── 4. SEARCH HISTORY ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.search_history (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           UUID        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  campaign_id       UUID        REFERENCES public.campaigns(id) ON DELETE SET NULL,
  campaign_name     TEXT,
  search_query      TEXT        NOT NULL DEFAULT '',
  source            TEXT        DEFAULT 'instagram',
  mode              TEXT        DEFAULT 'fast',
  total_results     INTEGER     DEFAULT 0,
  results_extracted INTEGER     DEFAULT 0,
  icp_snapshot      JSONB       DEFAULT '{}',
  status            TEXT        DEFAULT 'completed',
  executed_at       TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS search_history_user_idx     ON public.search_history(user_id);
CREATE INDEX IF NOT EXISTS search_history_campaign_idx ON public.search_history(campaign_id);
CREATE INDEX IF NOT EXISTS search_history_date_idx     ON public.search_history(executed_at DESC);

ALTER TABLE public.search_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='search_history' AND policyname='search_history_select') THEN
    CREATE POLICY "search_history_select" ON public.search_history FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='search_history' AND policyname='search_history_insert') THEN
    CREATE POLICY "search_history_insert" ON public.search_history FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;


-- ── 5. CAMPAIGN STATS VIEW ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.campaign_stats AS
SELECT
  c.id,
  c.user_id,
  c.name,
  c.status,
  c.hashtags,
  c.icp_min_followers,
  c.icp_max_followers,
  c.icp_regions,
  c.icp_content_types,
  c.created_at,
  COUNT(l.id)                                           AS total_leads,
  COUNT(l.id) FILTER (WHERE l.email <> '')              AS leads_with_email,
  COUNT(l.id) FILTER (WHERE l.status = 'contacted')     AS leads_contacted,
  COUNT(l.id) FILTER (WHERE l.vsl_sent_status = 'clicked') AS vsl_clicks,
  COUNT(l.id) FILTER (WHERE l.email_status = 'replied') AS email_replies,
  ROUND(AVG(l.follower_count))                          AS avg_followers,
  MAX(l.created_at)                                     AS last_lead_added
FROM public.campaigns c
LEFT JOIN public.leads l ON l.campaign_id = c.id
GROUP BY c.id, c.user_id, c.name, c.status, c.hashtags,
         c.icp_min_followers, c.icp_max_followers,
         c.icp_regions, c.icp_content_types, c.created_at;


-- ── 6. TRIGGER: auto-update campaign totals on lead insert ───────────────────
CREATE OR REPLACE FUNCTION public.refresh_campaign_totals()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.campaign_id IS NOT NULL THEN
    UPDATE public.campaigns
    SET
      total_leads      = (SELECT COUNT(*) FROM public.leads WHERE campaign_id = NEW.campaign_id),
      leads_with_email = (SELECT COUNT(*) FROM public.leads WHERE campaign_id = NEW.campaign_id AND email <> ''),
      updated_at       = NOW()
    WHERE id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leads_refresh_campaign ON public.leads;
CREATE TRIGGER leads_refresh_campaign
  AFTER INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.refresh_campaign_totals();
