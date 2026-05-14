// api/import-tiktok-handles.ts
// POST /api/import-tiktok-handles
//
// Accepts a raw Apify TikTok-profile-scraper JSON export, extracts unique
// handles (preserving original order), validates ownership, and inserts them
// into tiktok_handle_queue for the autopilot cron to drain.
//
// Body: { campaignId: string, items: unknown[] }
// Auth: standard Supabase anon key via Authorization header (Bearer <jwt>)
//
// Returns: { queued: number, skipped_junk: number, skipped_duplicate: number }

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Handles that come from the scraper as search-artifact / metadata rows rather
// than real creator accounts. All lowercase, exact match.
const JUNK_HANDLES = new Set([
  'business', 'us', 'uk', 'ca', 'au', 'help', 'tag', 'search', 'discover',
  'music', 'video', 'live', 'trending', 'foryou', 'fyp', 't', 'tiktok',
  'explore', 'about', 'store', 'official', 'support', 'info', 'contact',
  'news', 'brand', 'marketing',
]);

function extractHandle(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const obj = item as Record<string, unknown>;

  // Flat Apify export format: { "authorMeta.name": "handle" }
  const flat = (obj['authorMeta.name'] as string | undefined) ?? '';
  if (flat) return flat.toLowerCase().replace(/^@/, '').trim();

  // Nested format: { authorMeta: { name: "handle" } }
  const nested = obj.authorMeta;
  if (nested && typeof nested === 'object') {
    const name = (nested as Record<string, unknown>).name as string | undefined;
    if (name) return name.toLowerCase().replace(/^@/, '').trim();
  }

  return '';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization ?? '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) return res.status(401).json({ error: 'Missing Authorization header' });

  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  const anonKey     = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return res.status(500).json({ error: 'Missing Supabase env vars' });
  }

  // User client (validates JWT, ensures RLS ownership check)
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  // ── Input validation ───────────────────────────────────────────────────────
  const { campaignId, items } = req.body ?? {};
  if (!campaignId || typeof campaignId !== 'string') {
    return res.status(400).json({ error: 'campaignId (string) required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items (non-empty array) required' });
  }

  // ── Ownership check ────────────────────────────────────────────────────────
  // Use service client for the ownership query (RLS on campaigns uses auth.uid())
  const serviceClient = createClient(supabaseUrl, serviceKey);
  const { data: campaign, error: campaignErr } = await serviceClient
    .from('campaigns')
    .select('id, user_id')
    .eq('id', campaignId)
    .single();

  if (campaignErr || !campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }
  if (campaign.user_id !== user.id) {
    return res.status(403).json({ error: 'Forbidden: campaign belongs to a different user' });
  }

  // ── Extract & deduplicate handles in original JSON order ───────────────────
  const seen    = new Set<string>();
  const valid: { handle: string; position: number }[] = [];
  let skippedJunk      = 0;
  let skippedDuplicate = 0;

  for (let i = 0; i < items.length; i++) {
    const handle = extractHandle(items[i]);

    if (!handle || handle.length < 3 || JUNK_HANDLES.has(handle)) {
      skippedJunk++;
      continue;
    }
    // Only allow alphanumeric, dots, underscores (TikTok handle charset)
    if (!/^[a-z0-9._]{3,30}$/.test(handle)) {
      skippedJunk++;
      continue;
    }
    if (seen.has(handle)) {
      skippedDuplicate++;
      continue;
    }
    seen.add(handle);
    valid.push({ handle, position: valid.length }); // position = 0-based, order of first appearance
  }

  if (valid.length === 0) {
    return res.status(200).json({ queued: 0, skipped_junk: skippedJunk, skipped_duplicate: skippedDuplicate });
  }

  // ── Insert into queue (upsert: re-importing same JSON is a no-op) ──────────
  const rows = valid.map(({ handle, position }) => ({
    user_id:     user.id,
    campaign_id: campaignId,
    handle,
    position,
    status:      'pending',
  }));

  // Insert in chunks of 500 to stay within Supabase payload limits
  const CHUNK = 500;
  let totalQueued = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error: insertErr, count } = await serviceClient
      .from('tiktok_handle_queue')
      .upsert(chunk, { onConflict: 'campaign_id,handle', ignoreDuplicates: true })
      .select('id', { count: 'exact', head: true });

    if (insertErr) {
      return res.status(500).json({ error: `DB insert failed: ${insertErr.message}` });
    }
    totalQueued += count ?? chunk.length;
  }

  return res.status(200).json({
    queued:              totalQueued,
    skipped_junk:        skippedJunk,
    skipped_duplicate:   skippedDuplicate,
  });
}
