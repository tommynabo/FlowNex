-- ============================================================
-- FlowNext – Campaigns & Enhanced Leads Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- ── 0. ENSURE PROFILES TABLE EXISTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID REFERENCES auth.users NOT NULL PRIMARY KEY,
  full_name   TEXT,
  email       TEXT,
  company_name TEXT,
  target_icp  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Users can view own profile'
  ) THEN
    CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Users can update own profile'
  ) THEN
    CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Users can insert own profile'
  ) THEN
    CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
  END IF;
END $$;

-- Trigger: auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ── 1. CAMPAIGNS TABLE ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID        REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  name            TEXT        NOT NULL,
  description     TEXT,
  status          TEXT        DEFAULT 'active'
                              CHECK (status IN ('active', 'paused', 'completed')),
  -- ICP configuration snapshot
  hashtags        TEXT[]      DEFAULT '{}',
  icp_min_followers  INTEGER  DEFAULT 0,
  icp_max_followers  INTEGER  DEFAULT 99000000,
  icp_regions        TEXT[]   DEFAULT '{}',
  icp_content_types  TEXT[]   DEFAULT '{}',
  -- Stats (denormalised for quick reads)
  total_leads        INTEGER  DEFAULT 0,
  leads_with_email   INTEGER  DEFAULT 0,
  -- Timestamps
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS campaigns_user_id_idx   ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS campaigns_status_idx    ON campaigns(status);
CREATE INDEX IF NOT EXISTS campaigns_created_at_idx ON campaigns(created_at DESC);

-- RLS
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "campaigns_user_select" ON campaigns;
DROP POLICY IF EXISTS "campaigns_user_insert" ON campaigns;
DROP POLICY IF EXISTS "campaigns_user_update" ON campaigns;
DROP POLICY IF EXISTS "campaigns_user_delete" ON campaigns;

CREATE POLICY "campaigns_user_select" ON campaigns FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "campaigns_user_insert" ON campaigns FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "campaigns_user_update" ON campaigns FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "campaigns_user_delete" ON campaigns FOR DELETE USING (auth.uid() = user_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_campaign_timestamp()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaigns_updated_at ON campaigns;
CREATE TRIGGER campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION update_campaign_timestamp();


-- ── 2. ENHANCE EXISTING LEADS TABLE ─────────────────────────────────────────
-- Create leads table if it doesn't exist yet
CREATE TABLE IF NOT EXISTS leads (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  search_id       UUID,
  name            TEXT        NOT NULL DEFAULT '',
  job_title       TEXT,
  email           TEXT        DEFAULT '',
  phone           TEXT,
  location        TEXT,
  ig_handle       TEXT,
  follower_count  INTEGER     DEFAULT 0,
  niche           TEXT,
  audience_tier   TEXT        DEFAULT 'nano',
  ai_summary      TEXT,
  ai_pain_points  TEXT[]      DEFAULT '{}',
  cold_email_subject TEXT,
  cold_email_body TEXT,
  vsl_pitch       TEXT,
  vsl_sent_status TEXT        DEFAULT 'pending',
  email_status    TEXT        DEFAULT 'pending',
  status          TEXT        DEFAULT 'scraped',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'leads' AND policyname = 'leads_select') THEN
    CREATE POLICY "leads_select" ON leads FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'leads' AND policyname = 'leads_insert') THEN
    CREATE POLICY "leads_insert" ON leads FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'leads' AND policyname = 'leads_update') THEN
    CREATE POLICY "leads_update" ON leads FOR UPDATE USING (auth.uid() = user_id);
  END IF;
END $$;

-- Link leads to a campaign
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;

-- Extra profile data fields
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bio             TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS profile_pic_url TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS posts_count     INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS engagement_rate FLOAT   DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_verified     BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS content_type    TEXT;   -- detected niche tag
ALTER TABLE leads ADD COLUMN IF NOT EXISTS region          TEXT;   -- country/city from profile
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ig_url          TEXT;   -- full profile URL

-- Better indexes for lead querying
CREATE INDEX IF NOT EXISTS leads_campaign_id_idx     ON leads(campaign_id);
CREATE INDEX IF NOT EXISTS leads_audience_tier_idx   ON leads(audience_tier);
CREATE INDEX IF NOT EXISTS leads_follower_count_idx  ON leads(follower_count DESC);
CREATE INDEX IF NOT EXISTS leads_niche_idx           ON leads(niche);
CREATE INDEX IF NOT EXISTS leads_status_idx          ON leads(status);
CREATE INDEX IF NOT EXISTS leads_email_status_idx    ON leads(email_status);
CREATE INDEX IF NOT EXISTS leads_created_at_idx      ON leads(created_at DESC);


-- ── 3. LINK SEARCH HISTORY TO CAMPAIGNS ──────────────────────────────────────
-- Create search_history table if it doesn't exist yet
CREATE TABLE IF NOT EXISTS search_history (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  search_query    TEXT        NOT NULL DEFAULT '',
  source          TEXT        DEFAULT 'instagram',
  mode            TEXT        DEFAULT 'fast',
  total_results   INTEGER     DEFAULT 0,
  results_extracted INTEGER   DEFAULT 0,
  status          TEXT        DEFAULT 'completed',
  executed_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

ALTER TABLE search_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'search_history' AND policyname = 'search_history_select') THEN
    CREATE POLICY "search_history_select" ON search_history FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'search_history' AND policyname = 'search_history_insert') THEN
    CREATE POLICY "search_history_insert" ON search_history FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

ALTER TABLE search_history ADD COLUMN IF NOT EXISTS campaign_id   UUID REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE search_history ADD COLUMN IF NOT EXISTS campaign_name TEXT;
ALTER TABLE search_history ADD COLUMN IF NOT EXISTS icp_snapshot  JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS search_history_campaign_idx ON search_history(campaign_id);


-- ── 4. CAMPAIGN STATS VIEW (for dashboard) ───────────────────────────────────
CREATE OR REPLACE VIEW campaign_stats AS
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
  COUNT(l.id)                                    AS total_leads,
  COUNT(l.id) FILTER (WHERE l.email <> '')       AS leads_with_email,
  COUNT(l.id) FILTER (WHERE l.status = 'contacted') AS leads_contacted,
  COUNT(l.id) FILTER (WHERE l.vsl_sent_status = 'clicked') AS vsl_clicks,
  COUNT(l.id) FILTER (WHERE l.email_status = 'replied')    AS email_replies,
  ROUND(AVG(l.follower_count))                   AS avg_followers,
  MAX(l.created_at)                              AS last_lead_added
FROM campaigns c
LEFT JOIN leads l ON l.campaign_id = c.id
GROUP BY c.id, c.user_id, c.name, c.status, c.hashtags,
         c.icp_min_followers, c.icp_max_followers,
         c.icp_regions, c.icp_content_types, c.created_at;


-- ── 5. FUNCTION: auto-update campaign totals after lead insert ────────────────
CREATE OR REPLACE FUNCTION refresh_campaign_totals()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.campaign_id IS NOT NULL THEN
    UPDATE campaigns
    SET
      total_leads      = (SELECT COUNT(*) FROM leads WHERE campaign_id = NEW.campaign_id),
      leads_with_email = (SELECT COUNT(*) FROM leads WHERE campaign_id = NEW.campaign_id AND email <> ''),
      updated_at       = NOW()
    WHERE id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leads_refresh_campaign ON leads;
CREATE TRIGGER leads_refresh_campaign
  AFTER INSERT OR UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION refresh_campaign_totals();
