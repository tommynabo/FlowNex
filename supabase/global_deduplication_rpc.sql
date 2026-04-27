-- Global Deduplication RPC
-- This function bypasses RLS using SECURITY DEFINER so it can read leads
-- from ALL users, enabling cross-user duplicate detection.
-- Only ig_handle and email are exposed — no sensitive data is leaked.

CREATE OR REPLACE FUNCTION get_global_existing_leads()
RETURNS TABLE(ig_handle text, email text)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT ig_handle, email FROM leads;
$$;
