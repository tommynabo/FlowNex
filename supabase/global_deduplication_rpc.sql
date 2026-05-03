-- Global Deduplication RPC
-- This function bypasses RLS using SECURITY DEFINER so it can read leads
-- from ALL users, enabling cross-user duplicate detection.
-- Only ig_handle and email are exposed — no sensitive data is leaked.
--
-- days_back: only considers leads created within the last N days (default 30).
-- This prevents the pre-flight dedup set from growing unbounded and ensures
-- handles from old, irrelevant searches do not block fresh discovery.

CREATE OR REPLACE FUNCTION get_global_existing_leads(days_back int DEFAULT 30)
RETURNS TABLE(ig_handle text, email text)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT ig_handle, email
  FROM leads
  WHERE created_at > NOW() - (days_back || ' days')::INTERVAL;
$$;
