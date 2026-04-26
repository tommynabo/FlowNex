-- Migration: add instantly_campaign_id to campaigns + auto-update lead count trigger
-- Run this in Supabase SQL Editor

-- ── 1. Add instantly_campaign_id column ──────────────────────────────────────
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS instantly_campaign_id TEXT DEFAULT NULL;

-- ── 2. Trigger: auto-increment total_leads + leads_with_email on INSERT ──────
CREATE OR REPLACE FUNCTION public.increment_campaign_lead_counts()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.campaign_id IS NOT NULL THEN
    UPDATE public.campaigns
    SET
      total_leads      = total_leads + 1,
      leads_with_email = leads_with_email + (CASE WHEN NEW.email IS NOT NULL AND NEW.email <> '' THEN 1 ELSE 0 END),
      updated_at       = NOW()
    WHERE id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_increment_campaign_lead_counts ON public.leads;

CREATE TRIGGER trg_increment_campaign_lead_counts
  AFTER INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.increment_campaign_lead_counts();
