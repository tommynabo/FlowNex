-- FlowNext Migration: Extend leads table for Instagram creator outreach
-- Run this in the Supabase SQL editor for project: oauixhatmcxpittvlcdi

-- 1. Add Instagram / creator-specific columns to leads table
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS ig_handle TEXT,
  ADD COLUMN IF NOT EXISTS follower_count INTEGER,
  ADD COLUMN IF NOT EXISTS niche TEXT,
  ADD COLUMN IF NOT EXISTS audience_tier TEXT DEFAULT 'nano',
  ADD COLUMN IF NOT EXISTS vsl_sent_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS email_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS cold_email_subject TEXT,
  ADD COLUMN IF NOT EXISTS cold_email_body TEXT,
  ADD COLUMN IF NOT EXISTS vsl_pitch TEXT;

-- 2. Add constraints for enum-like fields
ALTER TABLE leads
  ADD CONSTRAINT leads_vsl_sent_status_check
    CHECK (vsl_sent_status IN ('pending', 'sent', 'opened', 'clicked', 'converted')),
  ADD CONSTRAINT leads_email_status_check
    CHECK (email_status IN ('pending', 'sent', 'bounced', 'replied')),
  ADD CONSTRAINT leads_audience_tier_check
    CHECK (audience_tier IN ('nano', 'micro', 'mid', 'macro'));

-- 3. Index for deduplication by ig_handle (most frequent lookup)
CREATE INDEX IF NOT EXISTS leads_ig_handle_user_idx ON leads(user_id, ig_handle)
  WHERE ig_handle IS NOT NULL;

-- 4. Index for VSL funnel analytics
CREATE INDEX IF NOT EXISTS leads_vsl_status_user_idx ON leads(user_id, vsl_sent_status);

-- 5. Update deduplication_log to track ig_handle-based duplicates
ALTER TABLE deduplication_log
  ADD COLUMN IF NOT EXISTS ig_handle TEXT;

-- 6. Create VSL analytics view for dashboard widgets
CREATE OR REPLACE VIEW vsl_funnel_stats AS
SELECT
  user_id,
  COUNT(*) FILTER (WHERE vsl_sent_status = 'sent')      AS emails_delivered,
  COUNT(*) FILTER (WHERE vsl_sent_status = 'clicked')   AS vsl_clicks,
  COUNT(*) FILTER (WHERE vsl_sent_status = 'converted') AS conversions,
  ROUND(
    CASE
      WHEN COUNT(*) FILTER (WHERE vsl_sent_status = 'sent') > 0
      THEN (COUNT(*) FILTER (WHERE vsl_sent_status = 'clicked')::NUMERIC
           / COUNT(*) FILTER (WHERE vsl_sent_status = 'sent')) * 100
      ELSE 0
    END, 1
  ) AS vsl_click_rate_pct
FROM leads
GROUP BY user_id;

-- 7. RLS policy for new view
ALTER VIEW vsl_funnel_stats OWNER TO authenticated;
