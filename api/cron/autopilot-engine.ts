/**
 * Vercel Cron Job: /api/cron/autopilot-engine
 * Schedule: every hour at :00 (see vercel.json → "0 * * * *")
 *
 * SELF-CONTAINED: no local imports — everything inlined to ensure Vercel
 * ESM bundler includes all code in the single function bundle.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, SupabaseClient }       from '@supabase/supabase-js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const TIKTOK_PROFILE_SCRAPER = 'apidojo~tiktok-scraper';
const APIFY_BASE             = 'https://api.apify.com/v2';

const FACELESS_CLIPPER_KEYWORD_POOLS: string[][] = [
  ['"gmail.com"', '"clipper"', '"editor"', '"edits"', '"daily clips"', '"dm for promo"'],
  ['"gmail.com"', '"no excuses"', '"best version"', '"discipline"', '"slideshow"', '"no face"'],
  ['"gmail.com"', '"hormozi"', '"iman gadzhi"', '"david goggins"', '"tate"', '"goggins"'],
  ['"gmail.com"', '"smma"', '"skool"', '"wop"', '"online business"', '"make money online"'],
  ['"business inquiries"', '"for business"', '"for collabs"', '"clips"', '"motivation"', '"mindset"'],
  ['"dm for promo"', '"dm for promos"', '"dm for rates"', '"hustle"', '"grind"', '"discipline"'],
  ['"payhip.com"', '"gumroad.com"', '"forms.gle"', '"clips"', '"motivation"', '"slideshow"'],
  ['"gmail.com"', '"hormozi clips"', '"goggins edits"', '"tate clips"', '"gadzhi clips"', '"alex hormozi"'],
  ['"skool"', '"wop"', '"clipping"', '"dm for collab"', '"gmail.com"', '"daily clips"'],
  ['"#gymmotivation"', '"#motivation"', '"#discipline"', '"#hardwork"', '"slideshow"'],
  ['"#gymtok"', '"#fitness"', '"#hustle"', '"slideshow"', '"#bestversion"'],
  ['"#physique"', '"#gains"', '"#gym"', '"slideshow"', '"#motivation"'],
  ['"@clipper"', '"@editor"', '"@motivation"', '"gmail.com"', '"dm for promo"'],
  ['"@hormozi"', '"@gadzhi"', '"@goggins"', '"@tate"', '"gmail.com"', '"edits"'],
  ['"bodybuilding fan page"', '"gym motivation"', '"gmail.com"', '"dm for collab"', '"physique page"', '"fan page"'],
  ['"fitness clips"', '"gym clips"', '"bodybuilder"', '"gmail.com"', '"dm for paid"', '"paid collab"'],
  ['"DM LEAN"', '"DM SHRED"', '"DM BULK"', '"DM PROGRAM"', '"skinny-fat"', '"skinny fat"'],
];

const ANTI_ICP_BIO_KEYWORDS = [
  'restaurant', 'cafe', 'bakery', 'food truck', 'boutique', 'retail store',
  'dental', 'dentist', 'clinic', 'salon', 'spa', 'franchise',
  'dancer', 'dancing', 'choreograph', 'scenepack', 'sound promo', 'music promo',
  'anime edit', 'fashion', 'beauty', 'makeup', 'skincare', 'nail', 'lash',
  'ugc creator', 'user generated content', 'public speaker', 'keynote speaker',
  'restaurante', 'cafetería', 'panadería', 'inmobiliaria', 'peluquería',
];

const ANTI_ICP_NEGATIVES  = '-restaurant -store -boutique -cooking -dance';
const TIKTOK_SKIP_HANDLES = new Set(['tag', 'search', 'discover', 'music', 'video', 'live', 'trending', 'foryou', 't']);
const EMAIL_REGEX          = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

const REGION_QUERY_TERMS: Record<string, string[]> = {
  US: ['"United States"', 'USA'],
  CA: ['Canada'],
  UK: ['"United Kingdom"', 'England'],
  AU: ['Australia'],
};

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface CampaignRow {
  id: string;
  user_id: string;
  name: string;
  hashtags: string[];
  icp_min_followers: number;
  icp_max_followers: number;
  icp_regions: string[];
  icp_content_types: string[];
  icp_type: string;
  instantly_campaign_id: string | null;
  autopilot_batch_size: number;
  autopilot_daily_limit: number;
  autopilot_leads_today: number;
  autopilot_start_hour: number;
  autopilot_end_hour: number;
  autopilot_reset_date: string | null;
  autopilot_last_run_at: string | null;
  autopilot_timezone?: string;
  total_leads?: number;
  status?: string;
}

interface BatchResult {
  leadsFound: number;
  addedToInstantly: number;
  skippedDuplicate: number;
  errors: string[];
}

interface ApifyRunResponse {
  data?: { id?: string; defaultDatasetId?: string };
}

interface TikTokProfileItem {
  // MODE C: apidojo~tiktok-scraper (current) — one item per video, profile in channel
  channel?:    { username?: string; name?: string; followers?: number; fans?: number; bio?: string; signature?: string };
  // MODE A/B: clockworks (legacy) — profile in authorMeta
  authorMeta?: { name?: string; nickName?: string; fans?: number; signature?: string };
}

// ─── SUPABASE ─────────────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '';
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  return createClient(url, key);
}

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────

function getCurrentHourInTz(timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false })
      .formatToParts(new Date());
    return parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10) % 24;
  } catch {
    return new Date().getUTCHours();
  }
}

function isInsideWindow(currentHour: number, startHour: number, endHour: number): boolean {
  if (startHour <= endHour) return currentHour >= startHour && currentHour < endHour;
  return currentHour >= startHour || currentHour < endHour;
}

function calcWindowHours(startHour: number, endHour: number): number {
  if (startHour === endHour) return 0;
  return startHour < endHour ? endHour - startHour : (24 - startHour) + endHour;
}

function getTodayInTz(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year')?.value  ?? '';
    const m = parts.find(p => p.type === 'month')?.value ?? '';
    const d = parts.find(p => p.type === 'day')?.value   ?? '';
    return `${y}-${m}-${d}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ─── SERPER (Google Search) ───────────────────────────────────────────────────

async function serperGoogleSearch(query: string, apiKey: string): Promise<Array<{ link: string }>> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: 20 }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Serper POST /search → HTTP ${res.status}: ${text.substring(0, 200)}`);
  }
  const data = await res.json() as { organic?: Array<{ link?: string }> };
  return (data.organic ?? []).filter(r => r.link).map(r => ({ link: r.link! }));
}

// ─── APIFY HELPERS ────────────────────────────────────────────────────────────

async function apifyPost(path: string, body: unknown, token: string): Promise<unknown> {
  const res = await fetch(`${APIFY_BASE}/${path}${path.includes('?') ? '&' : '?'}token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify POST ${path} → HTTP ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

async function apifyGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${APIFY_BASE}/${path}${path.includes('?') ? '&' : '?'}token=${token}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify GET ${path} → HTTP ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

async function runActorSync(
  actorId: string,
  input: unknown,
  token: string,
  timeoutSecs = 45,
  memoryMbytes = 1024,
): Promise<unknown[]> {
  const start = await apifyPost(
    `acts/${actorId}/runs?timeout=${timeoutSecs}&memory=${memoryMbytes}`,
    input,
    token,
  ) as ApifyRunResponse;

  const runId     = start.data?.id;
  const datasetId = start.data?.defaultDatasetId;
  if (!runId || !datasetId) throw new Error(`Apify: missing runId/datasetId for ${actorId}`);

  const deadline = Date.now() + (timeoutSecs + 10) * 1000;
  let finalStatus = '';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await apifyGet(`acts/${actorId}/runs/${runId}`, token) as { data?: { status?: string } };
    finalStatus = status.data?.status ?? '';
    if (finalStatus === 'SUCCEEDED') break;
    if (finalStatus === 'FAILED' || finalStatus === 'ABORTED') throw new Error(`Apify actor ${actorId} ${finalStatus}`);
  }

  if (finalStatus !== 'SUCCEEDED') {
    throw new Error(`Apify actor ${actorId} timed out (still ${finalStatus || 'RUNNING'} after ${timeoutSecs + 10}s)`);
  }

  const dataset = await apifyGet(`datasets/${datasetId}/items?limit=100`, token) as unknown[];
  return Array.isArray(dataset) ? dataset : [];
}

// ─── ICP / EMAIL HELPERS ──────────────────────────────────────────────────────

function extractHandleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
    const parts  = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const handle = parts[0].replace(/^@/, '').toLowerCase();
    if (TIKTOK_SKIP_HANDLES.has(handle) || handle.length < 2) return null;
    return handle;
  } catch {
    return null;
  }
}

function passesIcpFilter(bio: string, followers: number, minFollowers: number, maxFollowers: number): boolean {
  if (followers < minFollowers || (maxFollowers > 0 && followers > maxFollowers)) return false;
  const bioLower = bio.toLowerCase();
  for (const kw of ANTI_ICP_BIO_KEYWORDS) {
    if (bioLower.includes(kw)) return false;
  }
  return true;
}

function extractEmailFromBio(bio: string): string | null {
  const match = bio.match(EMAIL_REGEX);
  return match ? match[0].toLowerCase() : null;
}

// ─── INSTANTLY ────────────────────────────────────────────────────────────────

async function addLeadToInstantly(
  instantlyKey: string,
  campaignId: string,
  lead: { email: string; name: string; igHandle: string; niche: string; followerCount: number; aiSummary: string },
): Promise<boolean> {
  const nameParts = lead.name.trim().split(' ');
  const firstName = nameParts[0] || lead.igHandle;
  const lastName  = nameParts.slice(1).join(' ') || '';
  try {
    const res = await fetch('https://api.instantly.ai/api/v2/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${instantlyKey}` },
      body: JSON.stringify({
        campaign: campaignId,
        email: lead.email.toLowerCase().trim(),
        first_name: firstName,
        last_name: lastName,
        skip_if_in_workspace: true,
        variables: {
          ig_handle:      lead.igHandle,
          niche:          lead.niche,
          ai_summary:     lead.aiSummary,
          follower_count: String(lead.followerCount),
        },
      }),
    });
    return res.ok || res.status === 409;
  } catch {
    return false;
  }
}

// ─── QUERY BUILDER ────────────────────────────────────────────────────────────

function buildSearchQuery(attempt: number, regions: string[] = []): string {
  const poolIdx = attempt % FACELESS_CLIPPER_KEYWORD_POOLS.length;
  const terms   = FACELESS_CLIPPER_KEYWORD_POOLS[poolIdx];
  const orGroup = '(' + terms.join(' OR ') + ')';

  let locationSuffix = '';
  if (regions.length > 0 && regions.length <= 3) {
    const allTerms = regions.flatMap(r => REGION_QUERY_TERMS[r] ?? []);
    if (allTerms.length) locationSuffix = '(' + allTerms.join(' OR ') + ')';
  }

  const base = `site:tiktok.com ${orGroup} ${ANTI_ICP_NEGATIVES} -site:tiktok.com/tag/`;
  return locationSuffix ? `${base} ${locationSuffix}` : base;
}

// ─── TIKTOK BATCH ORCHESTRATION ──────────────────────────────────────────────

async function runTikTokBatch(
  campaign: CampaignRow,
  supabase: SupabaseClient,
  serperKey: string,
  apifyToken: string,
  instantlyKey: string,
  targetLeads: number,
): Promise<BatchResult> {
  const result: BatchResult = { leadsFound: 0, addedToInstantly: 0, skippedDuplicate: 0, errors: [] };

  const batchSize    = campaign.autopilot_batch_size ?? 5;
  const minFollowers = campaign.icp_min_followers ?? 0;
  const maxFollowers = campaign.icp_max_followers ?? 99_000_000;
  const instantlyId  = campaign.instantly_campaign_id;
  const regions      = campaign.icp_regions ?? [];

  // Step 1: Dedup — load known handles once, update in-memory during the run
  const { data: existingLeads } = await supabase
    .from('leads').select('ig_handle').eq('campaign_id', campaign.id).not('ig_handle', 'is', null);
  const seenHandles = new Set<string>(
    (existingLeads ?? []).map((r: { ig_handle: string }) => r.ig_handle?.toLowerCase()).filter(Boolean),
  );

  // Loop up to 4 search iterations until we reach targetLeads
  const baseOffset = Math.floor(Math.random() * FACELESS_CLIPPER_KEYWORD_POOLS.length);
  for (let iteration = 0; iteration < 4 && result.leadsFound < targetLeads; iteration++) {
    const attemptOffset = (baseOffset + iteration) % FACELESS_CLIPPER_KEYWORD_POOLS.length;

    // Step 2: Google Search via Serper
    let googleResults: Array<{ link: string }> = [];
    try {
      googleResults = await serperGoogleSearch(buildSearchQuery(attemptOffset, regions), serperKey);
    } catch (e) {
      result.errors.push(`Google Search failed (iter ${iteration + 1}): ${e instanceof Error ? e.message : String(e)}`);
      break; // likely an API key / quota issue — no point retrying
    }

    // Step 3: Extract handles (only new ones not yet seen)
    const candidateHandles: string[] = [];
    for (const item of googleResults) {
      const url = item.link ?? '';
      if (!url.includes('tiktok.com')) continue;
      const handle = extractHandleFromUrl(url);
      if (handle && !seenHandles.has(handle) && !candidateHandles.includes(handle)) candidateHandles.push(handle);
    }
    if (candidateHandles.length === 0) {
      result.errors.push(`No new handles found from Google Search (iter ${iteration + 1})`);
      break; // no new data, further iterations won't help
    }

    // Step 4: TikTok profiles — fetch a little extra to account for ICP filtering
    const remaining = targetLeads - result.leadsFound;
    const toFetch   = candidateHandles.slice(0, Math.min(batchSize, remaining + 5));
    let profileItems: unknown[] = [];
    try {
      profileItems = await runActorSync(
        TIKTOK_PROFILE_SCRAPER,
        { startUrls: toFetch.map(h => ({ url: `https://www.tiktok.com/@${h}` })), resultsType: 'details', resultsLimit: toFetch.length },
        apifyToken, 50, 1024,
      );
    } catch (e) {
      result.errors.push(`TikTok profile scraper failed (iter ${iteration + 1}): ${e instanceof Error ? e.message : String(e)}`);
      break;
    }

    // Step 5: Process profiles — apidojo MODE C (channel.*) + clockworks MODE A/B (authorMeta.*)
    for (const item of profileItems) {
      if (result.leadsFound >= targetLeads) break;
      const profile = item as TikTokProfileItem;
      const ch = profile.channel ?? null;
      const am = profile.authorMeta ?? null;
      // MODE C: channel.username → handle, channel.bio → bio, channel.followers → count
      // MODE A/B: authorMeta.name → handle, authorMeta.signature → bio, authorMeta.fans → count
      const handle      = (ch?.username ?? ch?.name ?? am?.name ?? '').toLowerCase().replace(/^@/, '');
      const bio         = ch?.bio ?? ch?.signature ?? am?.signature ?? '';
      const followers   = ch?.followers ?? ch?.fans ?? am?.fans ?? 0;
      const displayName = ch?.name ?? am?.nickName ?? handle;

      if (!handle || seenHandles.has(handle)) { result.skippedDuplicate++; continue; }
      if (!passesIcpFilter(bio, followers, minFollowers, maxFollowers)) continue;
      const email = extractEmailFromBio(bio);
      if (!email) continue;

      const { error: insertErr } = await supabase.from('leads').insert({
        user_id: campaign.user_id, campaign_id: campaign.id, name: displayName,
        ig_handle: handle, follower_count: followers, niche: campaign.icp_content_types?.[0] ?? '',
        audience_tier: followers >= 200_000 ? 'mid' : followers >= 50_000 ? 'micro' : 'nano',
        job_title: 'Content Creator', email, bio,
        ai_summary: `Autopilot scraped from TikTok. Bio: ${bio.substring(0, 200)}`,
        vsl_sent_status: 'pending', email_status: 'pending', status: 'scraped', source: 'tiktok',
      });
      if (insertErr) { result.errors.push(`DB insert failed for @${handle}: ${insertErr.message}`); continue; }

      seenHandles.add(handle);
      result.leadsFound++;

      if (instantlyId && instantlyKey) {
        const ok = await addLeadToInstantly(instantlyKey, instantlyId, {
          email, name: displayName, igHandle: handle,
          niche: campaign.icp_content_types?.[0] ?? '', followerCount: followers, aiSummary: bio.substring(0, 300),
        });
        if (ok) result.addedToInstantly++;
      }
    }
  }

  return result;
}

// ─── INSTAGRAM BATCH ─────────────────────────────────────────────────────────

const INSTAGRAM_PROFILE_SCRAPER = 'apify~instagram-profile-scraper';

const INSTAGRAM_KEYWORD_POOLS: string[][] = [
  ['"gmail.com"', '"personal trainer"', '"fitness"'],
  ['"gmail.com"', '"fitness coach"', '"workout"'],
  ['"gmail.com"', '"gym"', '"lifting"'],
  ['"gmail.com"', '"body transformation"', '"fat loss"'],
  ['"gmail.com"', '"online fitness coach"'],
  ['"gmail.com"', '"physique"', '"bodybuilding"'],
  ['"gmail.com"', '"strength coach"', '"crossfit"'],
  ['"dm for collab"', '"personal trainer"', '"fitness"'],
  ['"business inquiries"', '"fitness coach"', '"gym"'],
  ['"dm for promo"', '"fitness"', '"workout"'],
  ['"linktr.ee"', '"personal trainer"', '"fitness coach"'],
  ['"paid collab"', '"gym"', '"physique"'],
  ['"gmail.com"', '"gym vlog"', '"workout video"'],
  ['"fitness content creator"', '"gym influencer"'],
  ['"gymrat"', '"gains"'],
  ['"gym motivation"', '"lifting"'],
];

const INSTAGRAM_ANTI_ICP_NEGATIVES = '-restaurant -cafe -clinic -store -food -apparel';

const INSTAGRAM_SKIP_HANDLES = new Set([
  'p', 'reel', 'reels', 'explore', 'stories', 'accounts',
  'tv', 'direct', 'hashtag', 'tagged', 'about', 'directory',
]);

function buildInstagramSearchQuery(attempt: number): string {
  const poolIdx = attempt % INSTAGRAM_KEYWORD_POOLS.length;
  const terms   = INSTAGRAM_KEYWORD_POOLS[poolIdx];
  const orGroup = '(' + terms.join(' OR ') + ')';
  return `site:instagram.com ${orGroup} ${INSTAGRAM_ANTI_ICP_NEGATIVES}`;
}

function extractHandleFromInstagramUrl(url: string): string | null {
  try {
    const parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
    if (!parsed.hostname.includes('instagram.com')) return null;
    const parts  = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const handle = parts[0].replace(/^@/, '').toLowerCase();
    if (INSTAGRAM_SKIP_HANDLES.has(handle) || handle.length < 2) return null;
    return handle;
  } catch {
    return null;
  }
}

async function runInstagramBatch(
  campaign: CampaignRow,
  supabase: SupabaseClient,
  serperKey: string,
  apifyToken: string,
  instantlyKey: string,
  targetLeads: number,
): Promise<BatchResult> {
  const result: BatchResult = { leadsFound: 0, addedToInstantly: 0, skippedDuplicate: 0, errors: [] };

  const batchSize    = campaign.autopilot_batch_size ?? 5;
  const minFollowers = campaign.icp_min_followers ?? 0;
  const maxFollowers = campaign.icp_max_followers ?? 99_000_000;
  const instantlyId  = campaign.instantly_campaign_id;

  const { data: existingLeads } = await supabase
    .from('leads').select('ig_handle').eq('campaign_id', campaign.id).not('ig_handle', 'is', null);
  const seenHandles = new Set<string>(
    (existingLeads ?? []).map((r: { ig_handle: string }) => r.ig_handle?.toLowerCase()).filter(Boolean),
  );

  const baseOffset = Math.floor(Math.random() * INSTAGRAM_KEYWORD_POOLS.length);
  for (let iteration = 0; iteration < 4 && result.leadsFound < targetLeads; iteration++) {
    const attemptOffset = (baseOffset + iteration) % INSTAGRAM_KEYWORD_POOLS.length;

    let googleResults: Array<{ link: string }> = [];
    try {
      googleResults = await serperGoogleSearch(buildInstagramSearchQuery(attemptOffset), serperKey);
    } catch (e) {
      result.errors.push(`Google Search failed (iter ${iteration + 1}): ${e instanceof Error ? e.message : String(e)}`);
      break;
    }

    const candidateHandles: string[] = [];
    for (const item of googleResults) {
      const url = item.link ?? '';
      if (!url.includes('instagram.com')) continue;
      const handle = extractHandleFromInstagramUrl(url);
      if (handle && !seenHandles.has(handle) && !candidateHandles.includes(handle)) {
        candidateHandles.push(handle);
      }
    }
    if (candidateHandles.length === 0) {
      result.errors.push(`No new Instagram handles found (iter ${iteration + 1})`);
      break;
    }

    const remaining = targetLeads - result.leadsFound;
    const toFetch   = candidateHandles.slice(0, Math.min(batchSize, remaining + 5));
    let profileItems: unknown[] = [];
    try {
      profileItems = await runActorSync(
        INSTAGRAM_PROFILE_SCRAPER,
        { usernames: toFetch },
        apifyToken, 60, 1024,
      );
    } catch (e) {
      result.errors.push(`Instagram profile scraper failed (iter ${iteration + 1}): ${e instanceof Error ? e.message : String(e)}`);
      break;
    }

    for (const item of profileItems) {
      if (result.leadsFound >= targetLeads) break;
      const p = item as Record<string, unknown>;
      const handle = ((p.username as string) || '').toLowerCase().replace(/^@/, '');
      if (!handle || seenHandles.has(handle)) { result.skippedDuplicate++; continue; }

      const bio         = ((p.biography as string) || (p.bio as string) || '');
      const followers   = (p.followersCount as number) ?? 0;
      const displayName = ((p.fullName as string) || (p.name as string) || handle);

      if (followers < minFollowers || (maxFollowers > 0 && followers > maxFollowers)) continue;

      const bioLower = bio.toLowerCase();
      let antiMatch = false;
      for (const kw of ANTI_ICP_BIO_KEYWORDS) { if (bioLower.includes(kw)) { antiMatch = true; break; } }
      if (antiMatch) continue;

      const email = (
        ((p.publicEmail as string) || '').toLowerCase().trim() ||
        ((p.businessEmail as string) || '').toLowerCase().trim() ||
        ((p.contactEmail as string) || '').toLowerCase().trim() ||
        extractEmailFromBio(bio)
      );
      if (!email) continue;

      const { error: insertErr } = await supabase.from('leads').insert({
        user_id: campaign.user_id, campaign_id: campaign.id, name: displayName,
        ig_handle: handle, follower_count: followers, niche: campaign.icp_content_types?.[0] ?? '',
        audience_tier: followers >= 200_000 ? 'mid' : followers >= 50_000 ? 'micro' : 'nano',
        job_title: 'Content Creator', email, bio,
        ai_summary: `Autopilot scraped from Instagram. Bio: ${bio.substring(0, 200)}`,
        vsl_sent_status: 'pending', email_status: 'pending', status: 'scraped', source: 'instagram',
      });
      if (insertErr) { result.errors.push(`DB insert failed for @${handle}: ${insertErr.message}`); continue; }

      seenHandles.add(handle);
      result.leadsFound++;

      if (instantlyId && instantlyKey) {
        const ok = await addLeadToInstantly(instantlyKey, instantlyId, {
          email, name: displayName, igHandle: handle,
          niche: campaign.icp_content_types?.[0] ?? '', followerCount: followers, aiSummary: bio.substring(0, 300),
        });
        if (ok) result.addedToInstantly++;
      }
    }
  }

  return result;
}

// ─── AUTOPILOT BATCH ROUTER ──────────────────────────────────────────────────
// Routes to the correct engine based on campaign.icp_type:
//   'personal_brand'   → Instagram fitness coach engine
//   'faceless_clipper' → TikTok faceless clipper engine (default)

async function runAutopilotBatch(
  campaign: CampaignRow,
  supabase: SupabaseClient,
  serperKey: string,
  apifyToken: string,
  instantlyKey: string,
  targetLeads: number,
): Promise<BatchResult> {
  if (campaign.icp_type === 'personal_brand') {
    return runInstagramBatch(campaign, supabase, serperKey, apifyToken, instantlyKey, targetLeads);
  }
  return runTikTokBatch(campaign, supabase, serperKey, apifyToken, instantlyKey, targetLeads);
}

// ─── VERCEL HANDLER ───────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    return await _handler(req, res);
  } catch (fatal) {
    const msg = fatal instanceof Error ? fatal.message : String(fatal);
    console.error('[autopilot-engine] FATAL:', msg);
    return res.status(500).json({ error: 'Fatal crash', detail: msg });
  }
}

async function _handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // Auth
  const cronSecret   = process.env.CRON_SECRET ?? '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader   = (req.headers['authorization'] as string) ?? '';
  const bearerToken  = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!isVercelCron && !(cronSecret && bearerToken === cronSecret)) return res.status(401).json({ error: 'Unauthorized' });

  // Env vars
  const serperKey    = process.env.SERPER_API_KEY ?? '';
  const apifyToken   = process.env.APIFY_TOKEN ?? process.env.VITE_APIFY_API_TOKEN ?? '';
  const instantlyKey = process.env.INSTANTLY_API_KEY ?? '';
  if (!serperKey)    return res.status(500).json({ error: 'Missing SERPER_API_KEY env var' });
  if (!apifyToken)   return res.status(500).json({ error: 'Missing APIFY_TOKEN / VITE_APIFY_API_TOKEN env var' });
  if (!instantlyKey) return res.status(500).json({ error: 'Missing INSTANTLY_API_KEY env var' });

  // Supabase
  let supabase: ReturnType<typeof createClient>;
  try { supabase = getSupabase(); } catch (e) { return res.status(500).json({ error: (e as Error).message }); }

  // Load campaigns
  const { data: campaigns, error: dbErr } = await supabase
    .from('campaigns').select('*').eq('autopilot_enabled', true).eq('status', 'active');
  if (dbErr) return res.status(500).json({ error: `DB query failed: ${dbErr.message}` });

  const currentHourUTC = new Date().getUTCHours();

  const summary: Array<{
    campaignId: string; campaignName: string; status: string;
    leadsFound?: number; addedToInstantly?: number; targetPerRun?: number;
    windowHours?: number; reason?: string; errors?: string[];
  }> = [];

  for (const campaign of (campaigns ?? []) as CampaignRow[]) {
    const startHour  = campaign.autopilot_start_hour ?? 22;
    const endHour    = campaign.autopilot_end_hour   ?? 6;
    const campaignTz = campaign.autopilot_timezone   ?? 'UTC';
    const localHour  = getCurrentHourInTz(campaignTz);
    const todayDate  = getTodayInTz(campaignTz);

    if (!isInsideWindow(localHour, startHour, endHour)) {
      summary.push({ campaignId: campaign.id, campaignName: campaign.name, status: 'skipped', reason: `Outside window (${startHour}h–${endHour}h in ${campaignTz}, now ${localHour}h)` });
      continue;
    }

    let leadsToday = campaign.autopilot_leads_today ?? 0;
    if (!campaign.autopilot_reset_date || campaign.autopilot_reset_date < todayDate) {
      leadsToday = 0;
      await supabase.from('campaigns').update({ autopilot_leads_today: 0, autopilot_reset_date: todayDate }).eq('id', campaign.id);
    }

    const dailyLimit  = campaign.autopilot_daily_limit ?? 50;
    if (leadsToday >= dailyLimit) {
      summary.push({ campaignId: campaign.id, campaignName: campaign.name, status: 'skipped', reason: `Daily limit reached (${leadsToday}/${dailyLimit})` });
      continue;
    }

    const windowHours  = calcWindowHours(startHour, endHour);
    const targetPerRun = Math.min(
      windowHours > 0 ? Math.ceil(dailyLimit / windowHours) : dailyLimit,
      dailyLimit - leadsToday,
    );

    const { data: runRow } = await supabase.from('autopilot_runs').insert({
      campaign_id: campaign.id, user_id: campaign.user_id, status: 'running',
      batch_size: campaign.autopilot_batch_size ?? 5, target_leads: targetPerRun,
    }).select().single();
    const runId = (runRow as { id?: string } | null)?.id ?? null;

    let batchStatus: 'success' | 'error' = 'success';
    let errorMessage: string | null       = null;
    let batchResult: BatchResult          = { leadsFound: 0, addedToInstantly: 0, skippedDuplicate: 0, errors: [] };

    try {
      batchResult = await runAutopilotBatch(campaign, supabase, serperKey, apifyToken, instantlyKey, targetPerRun);
      if (batchResult.errors.length > 0 && batchResult.leadsFound === 0) {
        batchStatus = 'error'; errorMessage = batchResult.errors.join('; ');
      }
    } catch (e) {
      batchStatus = 'error'; errorMessage = e instanceof Error ? e.message : String(e);
    }

    const newLeadsToday = leadsToday + batchResult.leadsFound;

    await supabase.from('campaigns').update({
      autopilot_leads_today: newLeadsToday,
      autopilot_reset_date:  todayDate,
      autopilot_last_run_at: new Date().toISOString(),
    }).eq('id', campaign.id);

    if (runId) {
      await supabase.from('autopilot_runs').update({
        finished_at: new Date().toISOString(), leads_found: batchResult.leadsFound,
        leads_added_to_instantly: batchResult.addedToInstantly, status: batchStatus,
        error_message: errorMessage, daily_total_after: newLeadsToday,
      }).eq('id', runId);
    }

    summary.push({
      campaignId: campaign.id, campaignName: campaign.name, status: batchStatus,
      leadsFound: batchResult.leadsFound, addedToInstantly: batchResult.addedToInstantly,
      targetPerRun, windowHours,
      errors: batchResult.errors.length > 0 ? batchResult.errors : undefined,
    });
  }

  return res.status(200).json({ ok: true, processedAt: new Date().toISOString(), currentHourUTC, processed: summary.length, campaigns: summary });
}
