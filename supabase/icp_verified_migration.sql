-- ============================================================
-- FlowNext – Add icp_verified column to leads
-- Run this in Supabase SQL Editor
-- ============================================================

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS icp_verified BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS leads_icp_verified_idx ON public.leads(icp_verified);
