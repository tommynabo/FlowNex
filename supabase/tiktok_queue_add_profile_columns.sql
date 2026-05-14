-- ── Migration: add profile-data columns to tiktok_handle_queue ───────────────
-- Run this in Supabase SQL Editor BEFORE re-importing your JSON exports.
-- Safe to run multiple times (uses IF NOT EXISTS / IF EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tiktok_handle_queue
  ADD COLUMN IF NOT EXISTS follower_count     integer,          -- fans from Apify profile scraper
  ADD COLUMN IF NOT EXISTS bio               text,              -- signature field
  ADD COLUMN IF NOT EXISTS nick_name         text,              -- nickName / displayName
  ADD COLUMN IF NOT EXISTS profile_data_ready boolean NOT NULL DEFAULT false;
  -- When true the cron skips the Apify re-scrape and uses stored data directly.

COMMENT ON COLUMN public.tiktok_handle_queue.follower_count     IS 'Follower count from profile scraper export (fans field). NULL = not yet fetched.';
COMMENT ON COLUMN public.tiktok_handle_queue.bio               IS 'TikTok biography / signature from profile scraper export.';
COMMENT ON COLUMN public.tiktok_handle_queue.nick_name         IS 'Display name (nickName) from profile scraper export.';
COMMENT ON COLUMN public.tiktok_handle_queue.profile_data_ready IS 'True when follower_count/bio were captured at import time; cron skips Apify re-scrape for these rows.';

-- ── Reset SQL ─────────────────────────────────────────────────────────────────
-- Run the block below to wipe pending handles and start fresh with the new
-- profile-data-aware import. Choose the scope that fits your situation:

-- Option A – delete ONLY handles still waiting to be processed (safe; keeps history):
DELETE FROM public.tiktok_handle_queue
WHERE status = 'pending';

-- Option B – delete pending + processing + failed (full retry including failed ICP / no email):
-- DELETE FROM public.tiktok_handle_queue
-- WHERE status IN ('pending', 'processing', 'failed_icp', 'no_email');

-- Option C – full wipe for a campaign (replace the UUID):
-- DELETE FROM public.tiktok_handle_queue
-- WHERE campaign_id = '<YOUR_CAMPAIGN_UUID>';
