-- Migration: Add icp_type column to campaigns
-- Supports the new ICP Type selector: 'personal_brand' | 'faceless_clipper'
-- Run this in the Supabase SQL editor before deploying the updated frontend.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS icp_type TEXT NOT NULL DEFAULT 'personal_brand';
