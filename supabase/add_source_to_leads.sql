-- Migration: Add source column to leads table
-- This persists the platform (instagram, tiktok) per lead so it survives page refreshes.
-- Run this in the Supabase SQL editor.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'instagram';

-- Backfill existing leads from their parent search_history session
UPDATE leads l
SET source = sh.source
FROM search_history sh
WHERE l.search_id = sh.id
  AND l.source IS NULL;
