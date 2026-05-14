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

interface ProfileData {
  handle: string;
  followerCount: number | null;  // null = unknown (video-scraper format)
  bio: string;
  nickName: string;
  profileDataReady: boolean;     // true only when followerCount came from the profile scraper
}

/**
 * Extracts profile data from a single Apify JSON item.
 * Supports two formats:
 *   • Profile scraper  – uniqueId / fans / signature / nickName at root level
 *   • Video scraper    – authorMeta.name (flat) or authorMeta.name (nested)
 * Returns null for items that must be discarded entirely (error rows, private profiles).
 */
function extractProfileData(item: unknown): ProfileData | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;

  // Discard items that Apify flagged as errors or private
  if (typeof obj.error === 'string' && obj.error.trim().length > 0) return null;
  if (typeof obj.note  === 'string' && (
    obj.note.toLowerCase().includes('private') ||
    obj.note.toLowerCase().includes('login wall')
  )) return null;

  // ── Profile scraper format (uniqueId at root) ─────────────────────────────
  if (typeof obj.uniqueId === 'string' && obj.uniqueId.trim().length > 0) {
    const handle      = obj.uniqueId.toLowerCase().replace(/^@/, '').trim();
    const followerCount = typeof obj.fans === 'number' ? obj.fans : null;
    const bio         = typeof obj.signature === 'string' ? obj.signature : '';
    const nickName    = typeof obj.nickName  === 'string' ? obj.nickName  : handle;
    return { handle, followerCount, bio, nickName, profileDataReady: followerCount !== null };
  }

  // ── Video scraper format (handle inside authorMeta) ───────────────────────
  // Flat Apify export: { "authorMeta.name": "handle" }
  const flat = (obj['authorMeta.name'] as string | undefined) ?? '';
  if (flat) {
    return { handle: flat.toLowerCase().replace(/^@/, '').trim(), followerCount: null, bio: '', nickName: '', profileDataReady: false };
  }
  // Nested: { authorMeta: { name: "handle" } }
  const nested = obj.authorMeta;
  if (nested && typeof nested === 'object') {
    const name = (nested as Record<string, unknown>).name as string | undefined;
    if (name) {
      return { handle: name.toLowerCase().replace(/^@/, '').trim(), followerCount: null, bio: '', nickName: '', profileDataReady: false };
    }
  }

  return null;
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
  const valid: (ProfileData & { position: number })[] = [];
  let skippedJunk      = 0;
  let skippedDuplicate = 0;

  for (let i = 0; i < items.length; i++) {
    const profile = extractProfileData(items[i]);
    const handle  = profile?.handle ?? '';

    if (!profile || !handle || handle.length < 3 || JUNK_HANDLES.has(handle)) {
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
    valid.push({ ...profile, position: valid.length }); // position = 0-based, order of first appearance
  }

  if (valid.length === 0) {
    return res.status(200).json({ queued: 0, skipped_junk: skippedJunk, skipped_duplicate: skippedDuplicate });
  }

  // ── Insert into queue (upsert: re-importing same JSON is a no-op) ──────────
  const rows = valid.map(({ handle, position, followerCount, bio, nickName, profileDataReady }) => ({
    user_id:             user.id,
    campaign_id:         campaignId,
    handle,
    position,
    status:              'pending',
    follower_count:      followerCount ?? null,
    bio:                 bio || null,
    nick_name:           nickName || null,
    profile_data_ready:  profileDataReady,
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
