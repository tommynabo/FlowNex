-- Migration: Add email_account column to lead_conversations
-- Required for Instantly API v2 reply endpoint (eaccount field).
-- Run this in the Supabase SQL editor before deploying the updated webhook.

ALTER TABLE lead_conversations ADD COLUMN IF NOT EXISTS email_account TEXT;
