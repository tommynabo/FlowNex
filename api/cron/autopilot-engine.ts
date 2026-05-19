// Vercel Cron Job: /api/cron/autopilot-engine
// Schedule: every 10 min — configured in vercel.json (cron expression: star/10 star star star star)
// Self-contained: ICP filter logic is inlined directly here.
// Cross-directory imports (e.g. ../../services/search/ICPEvaluator) can fail
// in Vercel's ESM bundler for cron serverless functions — inlining avoids that.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, SupabaseClient }       from '@supabase/supabase-js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

// scraptik~tiktok-api — input: { profile_username: "handle" } → { user: { unique_id, nickname, signature, bio_url, follower_count } }
// scraptik~tiktok-api (hashtag mode) — input: { searchPosts_keyword: "hashtag", searchPosts_count: 30 } → [{ search_item_list: [{ aweme_info: { author: { unique_id, follower_count } } }] }]
const SCRAPTIK_ACTOR = 'scraptik~tiktok-api';
// scraperlink~google-search-results-serp-scraper — input: { keyword, limit } → [{ results: [{ url, title, description }] }]
const GOOGLE_SEARCH_SCRAPER  = 'scraperlink~google-search-results-serp-scraper';
const APIFY_BASE             = 'https://api.apify.com/v2';

// TikTok hashtag pool for faceless-clipper autopilot discovery.
// Mirrors FITNESS_HASHTAG_POOL from TikTokFacelessEngine — ordered by ICP yield (highest first).
// Used by scraptik searchPosts_keyword. Rotation is sequential (time-based) not random,
// matching the manual engine's (attempt-1) % pool.length strategy.
const FITNESS_HASHTAG_POOL = [
  'gymmotivation', 'gymotivation', 'gymtok', 'physique', 'gains', 'gymrat',
  'fitspo', 'hardwork', 'discipline', 'motivation', 'lightweightbaby',
  'mindset', 'neversettle', 'nodaysoff', 'hustle', 'grindset',
] as const;

// ─── INLINE ICP HARD FILTER ──────────────────────────────────────────────────
// Full replica of ICPEvaluator.applyHardFilter() — inlined to keep this file
// self-contained and guarantee correct Vercel serverless function bundling.

interface RawApifyProfile {
  username: string; fullName: string; biography: string; followersCount: number;
  [key: string]: unknown;
}

const _ICP_BRAND_KW       = ['official', 'store', 'shop', 'brand', 'supplements', 'apparel', 'agency'];
const _ICP_NON_GYM_KW     = ['cycling', 'cyclist', 'roadcycling', 'mtb', 'marathon', 'runningclub', 'trailrunning', 'ultramarathon', 'triathlon', 'triathlete', 'swimmer', 'openwater', 'footballplayer', 'soccerplayer', 'tennisplayer', 'golfer', 'wrestling', 'wrestler', 'mma', 'ufc', 'boxing', 'fighter', 'martial arts', 'jiujitsu', 'judo', 'karate'];
const _ICP_FITNESS_KW     = ['fitness', 'gym', 'workout', 'training', 'crossfit', 'hiit', 'bodybuilding', 'weightlifting', 'lifting', 'physique', 'muscle', 'strength', 'pilates', 'fitspo', 'fitlife', 'gymlife', 'gymrat', 'fitnesscoach', 'personaltrainer', 'gains', 'shredded', 'bulk', 'macros', 'gymtok', 'fitnessmotivation', 'gymmotivation', 'gymotivation', 'nutrition', 'diet', 'weightloss'];
const _ICP_MENTAL_KW      = ['psychologist', 'therapist', 'therapy', 'mentalhealth', 'psychiatric', 'psychiatrist', 'counselor', 'counselling', 'counseling', 'mindcoach', 'spiritualcoach', 'manifestation', 'lawofattraction'];
const _ICP_ANTI_BIO_KW    = [
  'restaurant', 'cafe', 'coffee shop', 'food truck', 'bakery', 'catering', 'acai', 'smoothie', 'juice bar', 'pizz', 'burger', 'sushi',
  'boutique', 'retail store', 'e-commerce store', 'physical products',
  'hr consulting', 'corporate leadership', 'corporate coach', 'corporate trainer',
  'dental', 'dentist', 'clinic', 'salon', 'spa', 'franchis',
  'restaurante', 'cafetería', 'panadería', 'tienda física', 'local comercial', 'inmobiliaria', 'peluquería', 'clínica', 'franquicia',
  'ugc creator', 'user generated content', 'content for brands', 'brand deals', 'sponsored content creator', 'paid partnerships only',
  'dancer', 'dancing', 'choreograph', 'scenepack', 'scenepacks',
  'sound promo', 'sound promotion', 'music promo', 'music promotion', 'anime edit', 'anime edits',
  'public speaker', 'keynote speaker', 'lawyer', 'attorney',
  'fashion', 'beauty', 'makeup', 'skincare', 'cosmetics', 'outfit', 'ootd', 'nail', 'lash', 'glam', 'moda', 'belleza', 'maquillaje',
  'princess', 'that girl', 'grwm', 'get ready with me', 'vlog', 'daily vlog', 'morning routine', 'night routine', 'girl that', 'clean girl',
  'chef', 'recipe creator', 'food creator', 'cook with me', 'cooking channel', 'food blogger', 'food blog', 'baking channel',
];
const _ICP_ANTI_HANDLE_KW = ['record', 'vinyl', 'djset', 'djpage', 'musicpage', 'dancepage', 'fashion', 'beauty', 'makeup', 'skincare', 'cook', 'recipe', 'kitchen', 'foodblog', 'foodie', 'thatgirl', 'grwm', 'vlogwith', 'diaryof', 'lifeof', 'princess'];
const _ICP_TIER1_KW       = ['clipper', 'editor', 'edits', 'editing', 'dm for promo', 'dm for promos', 'dm for collab', 'dm for rates', 'paid collab', 'paid collaboration', 'paid promotion', 'payhip', 'gumroad', 'skool', 'wop', 'smma', 'clipping', 'daily clips', 'fan page', 'bodybuilding', 'gym motivation', 'physique page', 'gym clips', 'fitness clips', 'bodybuilder', 'goggins', 'hormozi', 'gadzhi', 'skinny-fat', 'skinny fat', 'dm lean', 'dm shred', 'dm bulk', 'dm program'];
const _ICP_TIER2_KW       = ['mindset', 'motivation', 'wealth', 'hustle', 'grind', 'entrepreneur', 'clips', 'clip', 'money', 'discipline', 'hardwork', 'noexcuses', 'bestversion', 'selfimprovement', 'passiveincome', 'financialfreedom', 'makemoney', 'onlinebusiness', 'hormozi', 'gadzhi', 'tate', 'goggins', 'dailymotivation', 'gymmotivation', 'gymtok', 'gymlife', 'fitspo', 'gymrat', 'physique', 'gains', 'fitness', 'gym', 'slideshow', 'lean', 'shred', 'bulk', 'transformation'];

function applyIcpHardFilter(profiles: RawApifyProfile[], icpType: 'personal_brand' | 'faceless_clipper'): RawApifyProfile[] {
  const maxFollowers = icpType === 'faceless_clipper' ? 500_000 : 150_000;
  return profiles.filter(p => {
    const handle  = (p.username  || '').toLowerCase().trim();
    const nameLow = (p.fullName  || '').toLowerCase();
    const bioLow  = (p.biography || '').toLowerCase();
    const full    = `${bioLow} ${nameLow} ${handle}`;
    const followers = p.followersCount ?? 0;
    // followers=0 means the scraper could not retrieve the count — treat as unknown, not a failure
    if (followers > 0 && followers < 1_000)        return false;
    if (followers > 0 && followers > maxFollowers) return false;
    if (_ICP_BRAND_KW.find(kw => nameLow.includes(kw) || handle.includes(kw))) return false;
    if (_ICP_ANTI_BIO_KW.find(kw => full.includes(kw)))    return false;
    if (_ICP_ANTI_HANDLE_KW.find(kw => handle.includes(kw))) return false;
    if (icpType === 'personal_brand') {
      if (_ICP_MENTAL_KW.find(kw => full.includes(kw))) return false;
      const nonGym = _ICP_NON_GYM_KW.find(kw => full.includes(kw));
      if (nonGym && !_ICP_FITNESS_KW.some(kw => full.includes(kw))) return false;
      if (!_ICP_FITNESS_KW.some(kw => full.includes(kw))) return false;
    }
    if (icpType === 'faceless_clipper') {
      const tier1 = _ICP_TIER1_KW.find(kw => full.includes(kw));
      if (!tier1 && _ICP_TIER2_KW.filter(kw => full.includes(kw)).length < 3) return false;
    }
    return true;
  });
}

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
  autopilot_start_minute: number;
  autopilot_end_hour: number;
  autopilot_end_minute: number;
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
  errors: string[];    // real failures — drives status: 'error'
  warnings: string[]; // config/info notices — never drives status: 'error'
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

function getCurrentTimeInTz(timezone: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    return {
      hour:   parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10) % 24,
      minute: parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10),
    };
  } catch {
    const now = new Date();
    return { hour: now.getUTCHours(), minute: now.getUTCMinutes() };
  }
}

function isInsideWindow(
  currentHour: number, currentMinute: number,
  startHour: number, startMinute: number,
  endHour: number, endMinute: number,
): boolean {
  const cur   = currentHour * 60 + currentMinute;
  const start = startHour  * 60 + startMinute;
  const end   = endHour    * 60 + endMinute;
  if (start === end) return true; // no window restriction configured — always active
  if (start <= end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

function calcWindowHours(startHour: number, startMinute: number, endHour: number, endMinute: number): number {
  const start = startHour * 60 + startMinute;
  const end   = endHour   * 60 + endMinute;
  if (start === end) return 0;
  const diffMins = start < end ? end - start : (24 * 60 - start) + end;
  return diffMins / 60;
}

/**
 * Returns the number of minutes that should elapse between autopilot runs to
 * distribute dailyLimit leads evenly across the active time window.
 * Example: 30 leads ÷ 5/batch = 6 runs needed; 120-min window ÷ 6 = 20 min/run.
 */
function calcIntervalMinutes(windowTotalMins: number, dailyLimit: number, batchSize: number): number {
  if (windowTotalMins <= 0 || batchSize <= 0) return 0;
  const runsNeeded = Math.ceil(dailyLimit / batchSize);
  return Math.floor(windowTotalMins / runsNeeded);
}

/** Returns true if enough time has elapsed since the last run (or if it has never run). */
function isIntervalElapsed(lastRunAt: string | null, intervalMins: number): boolean {
  if (!lastRunAt || intervalMins <= 0) return true;
  const msSinceLastRun = Date.now() - new Date(lastRunAt).getTime();
  return msSinceLastRun >= intervalMins * 60_000;
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

async function serperGoogleSearch(query: string, apiKey: string, page = 1): Promise<Array<{ link: string }>> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: 20, ...(page > 1 ? { page } : {}) }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Serper POST /search → HTTP ${res.status}: ${text.substring(0, 200)}`);
  }
  const data = await res.json() as { organic?: Array<{ link?: string }> };
  return (data.organic ?? []).filter(r => r.link).map(r => ({ link: r.link! }));
}

// ─── APIFY GOOGLE SEARCH ────────────────────────────────────────────────────
// Uses scraperlink~google-search-results-serp-scraper instead of Serper.
// Supports site: operator queries — no free-tier restrictions.
// Returns link + snippet/title so callers can extract emails from Google's
// indexed content (fast path — avoids a scraptik roundtrip when email is visible).
async function apifyGoogleSearch(query: string, apifyToken: string, limit = 20): Promise<Array<{ link: string; snippet: string; title: string }>> {
  const items = await runActorSync(GOOGLE_SEARCH_SCRAPER, { keyword: query, limit: String(limit) }, apifyToken, 45, 1024);
  const links: Array<{ link: string; snippet: string; title: string }> = [];
  for (const item of items) {
    const p = item as Record<string, unknown>;
    const subResults = p.results as Array<Record<string, unknown>> | undefined;
    const resultsList = subResults ?? [p];
    for (const r of resultsList) {
      const url = (r.url as string) || (r.link as string) || '';
      if (url) links.push({
        link: url,
        snippet: (r.description as string) || (r.snippet as string) || '',
        title:   (r.title as string) || '',
      });
    }
  }
  return links;
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

  const deadline = Date.now() + (timeoutSecs + 30) * 1000;
  let finalStatus = '';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await apifyGet(`acts/${actorId}/runs/${runId}`, token) as { data?: { status?: string } };
    finalStatus = status.data?.status ?? '';
    if (finalStatus === 'SUCCEEDED' || finalStatus === 'TIMED-OUT' || finalStatus === 'TIMING-OUT') break;
    if (finalStatus === 'FAILED' || finalStatus === 'ABORTED') throw new Error(`Apify actor ${actorId} ${finalStatus}`);
  }

  // On TIMING-OUT, give Apify 4 extra seconds to flush partial results to the dataset
  if (finalStatus === 'TIMING-OUT') await new Promise(r => setTimeout(r, 4000));

  if (finalStatus !== 'SUCCEEDED' && finalStatus !== 'TIMED-OUT' && finalStatus !== 'TIMING-OUT') {
    throw new Error(`Apify actor ${actorId} timed out (still ${finalStatus || 'RUNNING'} after ${timeoutSecs + 30}s)`);
  }

  const dataset = await apifyGet(`datasets/${datasetId}/items?limit=500`, token) as unknown[];
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

function extractEmailFromBio(bio: string): string | null {
  const match = bio.match(EMAIL_REGEX);
  return match ? match[0].toLowerCase() : null;
}

// ─── MILLIONVERIFIER ─────────────────────────────────────────────────────────
// Verifies an email before it is inserted to DB and sent to Instantly.
// ok / catch_all → valid  |  invalid / disposable → discard  |  unknown → pass with warning

type MvResult = 'ok' | 'catch_all' | 'invalid' | 'unknown' | 'disposable' | 'error';

interface MvResponse {
  result: MvResult;
  subresult?: string;
  error?: number;
}

async function verifyEmailWithMillionVerifier(email: string, apiKey: string): Promise<MvResult> {
  try {
    const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=10`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return 'unknown';
    const data = await res.json() as MvResponse;
    console.log('[MV] Verified:', email, '→', data.result, '|', data.subresult ?? '');
    return data.result ?? 'unknown';
  } catch (e) {
    console.warn('[MV] Verification failed for', email, '—', e instanceof Error ? e.message : String(e));
    return 'unknown';
  }
}

// ─── INSTANTLY ────────────────────────────────────────────────────────────────

async function addLeadToInstantly(
  instantlyKey: string,
  campaignId: string,
  lead: { email: string; name: string; igHandle: string; niche: string; followerCount: number; aiSummary: string },
  errorsOut?: string[],
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
    if (!res.ok && res.status !== 409) {
      const text = await res.text();
      errorsOut?.push(`Instantly HTTP ${res.status} for ${lead.email}: ${text.substring(0, 150)}`);
    }
    return res.ok || res.status === 409;
  } catch (e) {
    errorsOut?.push(`Instantly fetch failed for ${lead.email}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ─── SERPER EMAIL SEARCH ─────────────────────────────────────────────────────
// Best TikTok fallback: Google indexes creator emails across the web
// (YouTube About, personal sites, collab directories, etc.).
// Query: "@{handle} gmail.com" → extract email from organic result snippets.

async function serperEmailSearch(handle: string, apiKey: string): Promise<string> {
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body:    JSON.stringify({ q: `"@${handle}" gmail.com`, num: 5 }),
    });
    if (!res.ok) return '';
    const data = await res.json() as { organic?: Array<{ title?: string; snippet?: string }> };
    for (const r of data.organic ?? []) {
      for (const text of [r.snippet ?? '', r.title ?? '']) {
        const m = text.match(EMAIL_REGEX);
        if (m?.[0] && !m[0].includes('example.com') && !m[0].includes('sentry.io'))
          return m[0].toLowerCase();
      }
    }
  } catch { /* ignore */ }
  return '';
}

// ─── INLINE EMAIL DISCOVERY ──────────────────────────────────────────────────
// The cron runs server-side (Node.js) — no CORS restrictions.
// Fetch Instagram / TikTok directly instead of calling the API routes via HTTP.
// This eliminates the VERCEL_URL / selfBase dependency entirely.

const _FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Cache-Control': 'no-cache',
};

async function inlineIgEmail(handle: string): Promise<string> {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(`https://www.instagram.com/${handle}/`, { headers: _FETCH_HEADERS, signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return '';
    const html = await res.text();
    for (const pat of [
      /"public_email"\s*:\s*"([^"]+)"/,
      /"business_email"\s*:\s*"([^"]+)"/,
      /"contact_email"\s*:\s*"([^"]+)"/,
      /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/,
    ]) {
      const m = html.match(pat);
      if (m?.[1] && m[1].includes('@') && !m[1].includes('example.com')) return m[1].toLowerCase().trim();
    }
  } catch { /* ignore */ }
  return '';
}

async function inlineTikTokEmail(handle: string): Promise<string> {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(`https://www.tiktok.com/@${handle}`, { headers: _FETCH_HEADERS, signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return '';
    const html = await res.text();
    for (const pat of [
      /"email"\s*:\s*"([^"]+)"/,
      /"contactEmail"\s*:\s*"([^"]+)"/,
      /"publicEmail"\s*:\s*"([^"]+)"/,
      /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/,
    ]) {
      const m = html.match(pat);
      if (m?.[1] && m[1].includes('@') && !m[1].includes('tiktok.com') && !m[1].includes('example.com')) return m[1].toLowerCase().trim();
    }
  } catch { /* ignore */ }
  return '';
}

// Extract an IG handle from a TikTok bio (e.g. "ig: @handle" / "instagram.com/handle")
// then resolve its business email directly.
async function inlineIgCrossRef(bio: string): Promise<string> {
  const igPatterns = [
    /(?:ig|insta(?:gram)?)\s*:?\s*@?([a-z0-9._]{1,30})/i,
    /instagram\.com\/([a-z0-9._]{1,30})/i,
  ];
  let igHandle = '';
  for (const pat of igPatterns) {
    const m = bio.match(pat);
    if (m?.[1]) { igHandle = m[1].replace(/[^a-z0-9._]/gi, ''); break; }
  }
  if (!igHandle) return '';
  return inlineIgEmail(igHandle);
}

// ─── TIKTOK BATCH ORCHESTRATION ──────────────────────────────────────────────

async function runTikTokBatch(
  campaign: CampaignRow,
  supabase: SupabaseClient,
  serperKey: string,
  apifyToken: string,
  instantlyKey: string,
  targetLeads: number,
  mvApiKey?: string,
): Promise<BatchResult> {
  const result: BatchResult = { leadsFound: 0, addedToInstantly: 0, skippedDuplicate: 0, errors: [], warnings: [] };

  const batchSize    = campaign.autopilot_batch_size ?? 5;
  const minFollowers = campaign.icp_min_followers ?? 0;
  const maxFollowers = campaign.icp_max_followers ?? 99_000_000;
  const instantlyId  = campaign.instantly_campaign_id;
  const regions      = campaign.icp_regions ?? [];
  if (!instantlyId) result.warnings.push('Instantly skipped: instantly_campaign_id is not set on this campaign');

  // Step 1: Dedup — load known handles once, update in-memory during the run
  const { data: existingLeads } = await supabase
    .from('leads').select('ig_handle').eq('campaign_id', campaign.id).not('ig_handle', 'is', null);
  const seenHandles = new Set<string>(
    (existingLeads ?? []).map((r: { ig_handle: string }) => r.ig_handle?.toLowerCase()).filter(Boolean),
  );

  // ── Shared profile processor ─────────────────────────────────────────────
  // Used by both STEP 0 (queue drain) and STEP 4+ (Serper loop) to avoid
  // duplicating the ICP-filter → email-discovery → DB-insert → Instantly flow.
  async function processProfile(
    handle: string, bio: string, followers: number, displayName: string, rawEmail: string,
    options?: { skipIcp?: boolean },
  ): Promise<'added' | 'failed_icp' | 'no_email' | 'duplicate'> {
    if (!handle || seenHandles.has(handle)) return 'duplicate';
    if (!options?.skipIcp) {
      const rawProfile: RawApifyProfile = { username: handle, fullName: displayName, biography: bio, followersCount: followers };
      if (applyIcpHardFilter([rawProfile], 'faceless_clipper').length === 0) return 'failed_icp';
      // followers=0 means the scraper could not retrieve the count — treat as unknown, not a failure
      if (followers > 0 && (followers < minFollowers || (maxFollowers > 0 && followers > maxFollowers))) return 'failed_icp';
    }

    let emailFinal = rawEmail ?? '';
    if (!emailFinal) emailFinal = extractEmailFromBio(bio) ?? '';  // fast path: email in bio
    if (!emailFinal) emailFinal = await serperEmailSearch(handle, serperKey);
    if (!emailFinal) {
      const [ttEmail, igCrossRef] = await Promise.all([inlineTikTokEmail(handle), inlineIgCrossRef(bio)]);
      emailFinal = ttEmail || igCrossRef;
    }
    if (!emailFinal) return 'no_email';

    // ── MillionVerifier check ────────────────────────────────────────────────
    if (mvApiKey) {
      const mvResult = await verifyEmailWithMillionVerifier(emailFinal, mvApiKey);
      if (mvResult === 'invalid' || mvResult === 'disposable') {
        result.warnings.push(`[MV] ❌ @${handle} descartado — email inválido (${mvResult}): ${emailFinal}`);
        return 'no_email';
      }
      if (mvResult === 'unknown') {
        result.warnings.push(`[MV] ⚠ @${handle} — resultado unknown para ${emailFinal} — se acepta igualmente`);
      }
    }

    const { error: insertErr } = await supabase.from('leads').insert({
      user_id: campaign.user_id, campaign_id: campaign.id, name: displayName,
      ig_handle: handle, follower_count: followers, niche: campaign.icp_content_types?.[0] ?? '',
      audience_tier: followers >= 200_000 ? 'mid' : followers >= 50_000 ? 'micro' : 'nano',
      job_title: 'Content Creator', email: emailFinal, bio,
      ai_summary: `Autopilot scraped from TikTok. Bio: ${bio.substring(0, 200)}`,
      vsl_sent_status: 'pending', email_status: 'pending', status: 'scraped', source: 'tiktok',
    });
    if (insertErr) { result.errors.push(`DB insert failed for @${handle}: ${insertErr.message}`); return 'no_email'; }

    seenHandles.add(handle);
    result.leadsFound++;

    if (instantlyId && instantlyKey) {
      const ok = await addLeadToInstantly(instantlyKey, instantlyId, {
        email: emailFinal, name: displayName, igHandle: handle,
        niche: campaign.icp_content_types?.[0] ?? '', followerCount: followers, aiSummary: bio.substring(0, 300),
      }, result.errors);
      if (ok) result.addedToInstantly++;
    }
    return 'added';
  }

  // ── STEP 1-3: Google site:tiktok.com discovery (mirrors TikTokFacelessEngine) ──
  // The manual engine works because Google pre-filters: only creators whose bio
  // already contains Gmail + ICP keywords appear in results. Hashtag search returns
  // random creators — most fail ICP (sparse bios) and email discovery.
  // apifyGoogleSearch uses scraperlink~google-search-results-serp-scraper (no
  // free-tier Serper restrictions). Three queries per run, rotating every 10 min.

  // 8 targeted queries for faceless-clipper/gym-motivation ICP, ordered by yield:
  const TT_DISCOVERY_QUERIES = [
    // 0. Clipper/editor identity + Gmail — highest precision
    `site:tiktok.com ("gmail.com" OR "dm for promo") ("clipper" OR "editor" OR "edits" OR "daily clips") -site:tiktok.com/tag/ -restaurant -fashion -dance`,
    // 1. Gym motivation + Gmail
    `site:tiktok.com "gym motivation" ("gmail.com" OR "dm for promo" OR "dm for collab") ("physique" OR "discipline" OR "clips") -site:tiktok.com/tag/`,
    // 2. #gymtok + Gmail + ICP signals
    `site:tiktok.com "#gymtok" ("gmail.com" OR "dm for promo") ("physique" OR "discipline" OR "no excuses" OR "best version") -site:tiktok.com/tag/ -restaurant -dance`,
    // 3. #gymmotivation + faceless format + contact signal
    `site:tiktok.com "#gymmotivation" ("slideshow" OR "no face" OR "clips") ("gmail.com" OR "dm for promo" OR "for business") -site:tiktok.com/tag/`,
    // 4. Figure-clip editors (Hormozi/Goggins/Tate) + Gmail
    `site:tiktok.com ("hormozi" OR "goggins" OR "gadzhi" OR "tate") ("gmail.com" OR "dm for promo") ("clips" OR "edits" OR "editor") -site:tiktok.com/tag/`,
    // 5. DM for promo/rates + hustle/discipline
    `site:tiktok.com ("dm for promo" OR "dm for rates" OR "paid collab") ("hustle" OR "grind" OR "discipline" OR "gains") -site:tiktok.com/tag/ -restaurant`,
    // 6. Physique/gym clips page + Gmail
    `site:tiktok.com ("physique page" OR "gym clips" OR "fitness clips" OR "bodybuilding fan page") ("gmail.com" OR "dm for collab") -site:tiktok.com/tag/`,
    // 7. Community (WOP/Skool/SMMA) + Gmail
    `site:tiktok.com ("skool" OR "wop" OR "smma") ("gmail.com" OR "dm for promo") ("clips" OR "motivation" OR "mindset") -site:tiktok.com/tag/`,
  ] as const;

  const queryOffset = Math.floor(Date.now() / 600_000) % TT_DISCOVERY_QUERIES.length;

  // Store handle + the Google snippet so we can extract email from indexed content
  // (fast path — avoids scraptik when email is already visible in the snippet).
  interface Candidate { handle: string; snippet: string; }
  const candidateHandles: Candidate[] = [];

  for (let iter = 0; iter < 3 && candidateHandles.length < 30 && result.leadsFound < targetLeads; iter++) {
    const query = TT_DISCOVERY_QUERIES[(queryOffset + iter) % TT_DISCOVERY_QUERIES.length];
    try {
      const links = await apifyGoogleSearch(query, apifyToken, 20);
      for (const { link, snippet, title } of links) {
        if (!link.includes('tiktok.com') || link.includes('/tag/') || link.includes('/video/')) continue;
        const handle = extractHandleFromUrl(link);
        if (handle && !seenHandles.has(handle) && !candidateHandles.find(c => c.handle === handle)) {
          candidateHandles.push({ handle, snippet: `${snippet} ${title}`.trim() });
        }
      }
    } catch (e) {
      result.errors.push(`TikTok Google discovery failed (iter ${iter + 1}): ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
  }

  if (candidateHandles.length === 0 && result.errors.length === 0) {
    result.warnings.push(`TikTok Google discovery returned no handles (queries ${queryOffset}–${(queryOffset + 2) % TT_DISCOVERY_QUERIES.length})`);
  }

  // ── STEP 4+5: Parallel profile lookups → ICP filter → email → DB insert ──
  // For each candidate, try to get the email from the Google snippet first (fast path).
  // Only call scraptik for full profile data (bio + followers) regardless — we need
  // those for the ICP check. But if snippet already has the email we skip the
  // multi-stage email discovery that adds ~5-10s per profile.
  if (candidateHandles.length > 0) {
    // Build two maps from the Google snippets:
    // 1. snippetEmails  — email extracted from snippet (fast path, avoids scraptik email lookup)
    // 2. snippetTexts   — full snippet text, used to augment bio for ICP check.
    //    KEY INSIGHT: Google found these profiles because their bio/snippet matched ICP
    //    keywords at index time. Users frequently update/clear their TikTok bio, so the
    //    current bio from scraptik often no longer contains those keywords. By combining
    //    current bio + Google snippet we get ICP signals from BOTH present and past.
    const snippetEmails = new Map<string, string>();
    const snippetTexts  = new Map<string, string>();
    for (const { handle, snippet } of candidateHandles) {
      const e = extractEmailFromBio(snippet);
      if (e) snippetEmails.set(handle, e);
      if (snippet) snippetTexts.set(handle, snippet);
    }

    // Cap at 20 to stay within Vercel 300s maxDuration
    const profileResults = await Promise.allSettled(
      candidateHandles.slice(0, 20).map(({ handle: h }) =>
        runActorSync(SCRAPTIK_ACTOR, { profile_username: h }, apifyToken, 30, 256)
      )
    );
    const profileItems = profileResults
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => (r as PromiseFulfilledResult<unknown[]>).value);

    // Track outcomes for diagnostic warnings
    let diagFailedIcp = 0;
    let diagNoEmail   = 0;
    let diagDuplicate = 0;

    for (const item of profileItems) {
      if (result.leadsFound >= targetLeads) break;
      const p = item as Record<string, unknown>;

      // ── Robust field extraction ───────────────────────────────────────────
      // scraptik profile_username mode may return:
      //   A) { user: { unique_id | uniqueId, signature | bio, follower_count | followerCount } }
      //   B) root-level object: { unique_id | uniqueId, signature | bio, follower_count | followerCount }
      //   C) authorMeta nesting (clockworks legacy): { authorMeta: { name, fans, signature } }
      const user = (p.user as Record<string, unknown>) || (p as Record<string, unknown>);
      const meta = (p.authorMeta as Record<string, unknown>) || {};

      const handle = (
        (user.unique_id    as string) ||
        (user.uniqueId     as string) ||
        (meta.name         as string) || ''
      ).toLowerCase().replace(/^@/, '');

      const scrapBio = (
        (user.signature    as string) ||
        (user.bio          as string) ||
        (meta.signature    as string) || ''
      );
      // Augment current bio with Google snippet — covers the common case where the
      // user has since changed/cleared their bio but Google's index still has the
      // ICP keywords we queried for (clipper, dm for promo, gym motivation, etc.)
      const googleSnippet = snippetTexts.get(handle) || '';
      const bio = googleSnippet ? `${scrapBio} ${googleSnippet}`.trim() : scrapBio;

      // follower_count (snake) — native scraptik; followerCount (camelCase) — TikTok API native
      const followers = (
        (user.follower_count  as number) ||
        (user.followerCount   as number) ||
        (user.fans            as number) ||
        (meta.fans            as number) || 0
      );

      const displayName = (
        (user.nickname  as string) ||
        (user.nickName  as string) ||
        (meta.nickName  as string) || handle
      );

      // Email: prefer value embedded in scraptik response, else use snippet fast path
      const rawEmail = (
        ((user.email as string) || '').toLowerCase().trim() ||
        snippetEmails.get(handle) || ''
      );

      const outcome = await processProfile(handle, bio, followers, displayName, rawEmail);
      if (outcome === 'duplicate')   diagDuplicate++;
      if (outcome === 'failed_icp')  diagFailedIcp++;
      if (outcome === 'no_email')    diagNoEmail++;
    }

    // Diagnostic warning — visible in autopilot_runs.error_message so we can
    // see exactly why a run found 0 leads without digging into logs.
    if (result.leadsFound === 0 && profileItems.length > 0) {
      result.warnings.push(
        `${profileItems.length} profiles fetched, 0 leads: ${diagFailedIcp} failed ICP, ${diagNoEmail} no email, ${diagDuplicate} duplicate`
      );
    } else if (result.leadsFound === 0 && profileItems.length === 0) {
      result.warnings.push(`scraptik returned 0 items for ${candidateHandles.length} candidates`);
    }
  } else if (result.errors.length === 0) {
    result.warnings.push('TikTok discovery found no new handles — all seen or filtered');
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

// ── Stats Block — city × height × weight × gmail ─────────────────────────────
// Personal trainers routinely put their city, height, weight + Gmail in their IG bio.
// With 21 cities × 11 heights × 15 weights = 3,465 unique combinations, these
// queries never exhaust. This is the primary fix for Instagram pool exhaustion.
// Proven in the manual InstagramPersonalBrandEngine — high precision, zero false positives.
const IG_STATS_CITIES = [
  'New York', 'Los Angeles', 'Chicago', 'Houston', 'Miami', 'Dallas', 'Atlanta',
  'Phoenix', 'Denver', 'Seattle', 'San Diego', 'Austin', 'Boston', 'Nashville',
  'Tampa', 'Toronto', 'Vancouver', 'Calgary', 'London', 'Manchester', 'Glasgow',
];
const IG_STATS_HEIGHTS = [
  "5'5\"", "5'6\"", "5'7\"", "5'8\"", "5'9\"", "5'10\"", "5'11\"",
  "6'", "6'1\"", "6'2\"", "6'3\"",
];
const IG_STATS_WEIGHTS = [
  '125lbs', '130lbs', '135lbs', '140lbs', '145lbs', '150lbs', '155lbs',
  '160lbs', '165lbs', '170lbs', '175lbs', '180lbs', '185lbs', '190lbs', '200lbs',
];

function buildInstagramStatsQuery(): string {
  const city   = IG_STATS_CITIES[Math.floor(Math.random() * IG_STATS_CITIES.length)];
  const height = IG_STATS_HEIGHTS[Math.floor(Math.random() * IG_STATS_HEIGHTS.length)];
  const weight = IG_STATS_WEIGHTS[Math.floor(Math.random() * IG_STATS_WEIGHTS.length)];
  return `site:instagram.com "${city}" "${height}" "${weight}" "gmail.com" ${INSTAGRAM_ANTI_ICP_NEGATIVES}`;
}

function buildInstagramSearchQuery(attempt: number): string {
  // Odd attempts → Stats Block query (city × height × weight × gmail).
  // These generate near-infinite unique queries and are the primary fix for pool exhaustion.
  if (attempt % 2 === 1) return buildInstagramStatsQuery();
  // Even attempts → fixed keyword pool (original approach, good for cold starts)
  const poolIdx = Math.floor(attempt / 2) % INSTAGRAM_KEYWORD_POOLS.length;
  const terms   = INSTAGRAM_KEYWORD_POOLS[poolIdx];
  return `site:instagram.com ${terms.join(' ')} ${INSTAGRAM_ANTI_ICP_NEGATIVES}`;
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
  mvApiKey?: string,
): Promise<BatchResult> {
  const result: BatchResult = { leadsFound: 0, addedToInstantly: 0, skippedDuplicate: 0, errors: [], warnings: [] };

  const batchSize    = campaign.autopilot_batch_size ?? 5;
  const minFollowers = campaign.icp_min_followers ?? 0;
  const maxFollowers = campaign.icp_max_followers ?? 99_000_000;
  const instantlyId  = campaign.instantly_campaign_id;
  if (!instantlyId) result.warnings.push('Instantly skipped: instantly_campaign_id is not set on this campaign');

  const { data: existingLeads } = await supabase
    .from('leads').select('ig_handle').eq('campaign_id', campaign.id).not('ig_handle', 'is', null);
  const seenHandles = new Set<string>(
    (existingLeads ?? []).map((r: { ig_handle: string }) => r.ig_handle?.toLowerCase()).filter(Boolean),
  );

  // Two queries run in PARALLEL per iteration — mirrors InstagramPersonalBrandEngine's
  // GOOGLE_QUERY_BATCH approach. Each query fetches 20 results (2×20=40 total).
  // Two iterations max (was 4 serial) → wall-time: 2×(~45s parallel) ≈ 90s instead of
  // 4×(~45s serial) ≈ 180s. This eliminates the Vercel function-timeout that was causing
  // the scraperlink actor to be aborted mid-run.
  const baseOffset = Math.floor(Date.now() / 600_000) % INSTAGRAM_KEYWORD_POOLS.length;
  for (let iteration = 0; iteration < 2 && result.leadsFound < targetLeads; iteration++) {
    const offsetA = (baseOffset + iteration * 2)     % INSTAGRAM_KEYWORD_POOLS.length;
    const offsetB = (baseOffset + iteration * 2 + 1) % INSTAGRAM_KEYWORD_POOLS.length;
    const queryA  = buildInstagramSearchQuery(offsetA);
    const queryB  = buildInstagramSearchQuery(offsetB);

    const candidateHandles: string[] = [];
    // Run both queries in parallel — wall-time ≈ single query instead of two serial queries.
    let searchFailed = false;
    try {
      const [resultsA, resultsB] = await Promise.all([
        apifyGoogleSearch(queryA, apifyToken, 20),
        apifyGoogleSearch(queryB, apifyToken, 20),
      ]);
      for (const item of [...resultsA, ...resultsB]) {
        const url = item.link ?? '';
        if (!url.includes('instagram.com')) continue;
        const h = extractHandleFromInstagramUrl(url);
        if (h && !seenHandles.has(h) && !candidateHandles.includes(h)) candidateHandles.push(h);
      }
    } catch (e) {
      result.errors.push(`Google Search failed (iter ${iteration + 1}): ${e instanceof Error ? e.message : String(e)}`);
      searchFailed = true;
    }

    if (searchFailed) break;
    if (candidateHandles.length === 0) {
      result.errors.push(`No new Instagram handles found (iter ${iteration + 1}) — all pages exhausted`);
      continue; // try a different keyword pool next iteration
    }

    const remaining = targetLeads - result.leadsFound;
    // Send up to batchSize*4 candidates to Apify — with a ~20-25% in-window hit-rate
    // this reliably yields batchSize qualified leads even in narrow follower ranges.
    const toFetch   = candidateHandles.slice(0, Math.min(batchSize * 4, remaining + 10));
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

      // Comprehensive ICP filter — mirrors the manual InstagramPersonalBrandEngine pipeline
      const rawProfile: RawApifyProfile = { username: handle, fullName: displayName, biography: bio, followersCount: followers };
      if (applyIcpHardFilter([rawProfile], 'personal_brand').length === 0) continue;
      // Also enforce campaign-specific follower range
      // followers=0 means the scraper could not retrieve the count — treat as unknown, not a failure
      if (followers > 0 && (followers < minFollowers || (maxFollowers > 0 && followers > maxFollowers))) continue;

      const emailRaw = (
        ((p.publicEmail as string) || '').toLowerCase().trim() ||
        ((p.businessEmail as string) || '').toLowerCase().trim() ||
        ((p.contactEmail as string) || '').toLowerCase().trim() ||
        extractEmailFromBio(bio)
      );
      // Multi-stage email fallback
      let emailFinal = emailRaw;
      // Stage 2: inline Instagram HTML fetch
      if (!emailFinal) emailFinal = await inlineIgEmail(handle);
      // Stage 3: Serper web search
      if (!emailFinal) emailFinal = await serperEmailSearch(handle, serperKey);
      if (!emailFinal) continue;

      // ── MillionVerifier check ──────────────────────────────────────────────
      if (mvApiKey) {
        const mvResult = await verifyEmailWithMillionVerifier(emailFinal, mvApiKey);
        if (mvResult === 'invalid' || mvResult === 'disposable') {
          result.warnings.push(`[MV] ❌ @${handle} descartado — email inválido (${mvResult}): ${emailFinal}`);
          continue;
        }
        if (mvResult === 'unknown') {
          result.warnings.push(`[MV] ⚠ @${handle} — resultado unknown para ${emailFinal} — se acepta igualmente`);
        }
      }

      const { error: insertErr } = await supabase.from('leads').insert({
        user_id: campaign.user_id, campaign_id: campaign.id, name: displayName,
        ig_handle: handle, follower_count: followers, niche: campaign.icp_content_types?.[0] ?? '',
        audience_tier: followers >= 200_000 ? 'mid' : followers >= 50_000 ? 'micro' : 'nano',
        job_title: 'Content Creator', email: emailFinal, bio,
        ai_summary: `Autopilot scraped from Instagram. Bio: ${bio.substring(0, 200)}`,
        vsl_sent_status: 'pending', email_status: 'pending', status: 'scraped', source: 'instagram',
      });
      if (insertErr) { result.errors.push(`DB insert failed for @${handle}: ${insertErr.message}`); continue; }

      seenHandles.add(handle);
      result.leadsFound++;

      if (instantlyId && instantlyKey) {
        const ok = await addLeadToInstantly(instantlyKey, instantlyId, {
          email: emailFinal, name: displayName, igHandle: handle,
          niche: campaign.icp_content_types?.[0] ?? '', followerCount: followers, aiSummary: bio.substring(0, 300),
        }, result.errors);
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
  mvApiKey?: string,
): Promise<BatchResult> {
  if (campaign.icp_type === 'personal_brand') {
    return runInstagramBatch(campaign, supabase, serperKey, apifyToken, instantlyKey, targetLeads, mvApiKey);
  }
  return runTikTokBatch(campaign, supabase, serperKey, apifyToken, instantlyKey, targetLeads, mvApiKey);
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
  const serperKey    = process.env.SERPER_API_KEY ?? process.env.SERPET_API_KEY ?? ''; // SERPET_ is a common typo — support both
  const apifyToken   = process.env.APIFY_TOKEN ?? process.env.VITE_APIFY_API_TOKEN ?? '';
  const instantlyKey = process.env.INSTANTLY_API_KEY ?? '';
  const mvApiKey     = process.env.MILLIONVERIFIER_API_KEY ?? '';
  if (!serperKey)    return res.status(500).json({ error: 'Missing SERPER_API_KEY env var (also checked SERPET_API_KEY)' });
  if (!apifyToken)   return res.status(500).json({ error: 'Missing APIFY_TOKEN / VITE_APIFY_API_TOKEN env var' });
  if (!instantlyKey) return res.status(500).json({ error: 'Missing INSTANTLY_API_KEY env var' });
  if (!mvApiKey)     console.warn('[autopilot-engine] MILLIONVERIFIER_API_KEY not set — email verification disabled');

  // Supabase
  let supabase: SupabaseClient;
  try { supabase = getSupabase(); } catch (e) { return res.status(500).json({ error: (e as Error).message }); }

  // ── Cleanup: mark stale 'running' runs as error ────────────────────────────
  // Orphaned runs (cron crash / Vercel cold-start timeout) stuck in 'running'
  // for >30 min are auto-closed so the UI never shows ghost in-progress entries.
  await supabase.from('autopilot_runs')
    .update({ status: 'error', finished_at: new Date().toISOString(), error_message: 'Run timed out — auto-closed by cleanup' })
    .eq('status', 'running')
    .lt('started_at', new Date(Date.now() - 30 * 60_000).toISOString());

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
    const startHour   = campaign.autopilot_start_hour   ?? 9;
    const startMinute = campaign.autopilot_start_minute ?? 0;
    const endHour     = campaign.autopilot_end_hour     ?? 21;
    const endMinute   = campaign.autopilot_end_minute   ?? 0;
    const campaignTz  = campaign.autopilot_timezone     ?? 'UTC';
    const { hour: localHour, minute: localMinute } = getCurrentTimeInTz(campaignTz);
    const todayDate   = getTodayInTz(campaignTz);
    const fmtT = (h: number, m: number) => `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;

    if (!isInsideWindow(localHour, localMinute, startHour, startMinute, endHour, endMinute)) {
      summary.push({ campaignId: campaign.id, campaignName: campaign.name, status: 'skipped', reason: `Outside window (${fmtT(startHour, startMinute)}–${fmtT(endHour, endMinute)} in ${campaignTz}, now ${fmtT(localHour, localMinute)})` });
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

    const batchSize    = campaign.autopilot_batch_size ?? 5;
    const windowMins   = calcWindowHours(startHour, startMinute, endHour, endMinute) * 60;
    const intervalMins = calcIntervalMinutes(windowMins, dailyLimit, batchSize);
    // ── Interval check: only fire if enough time has elapsed since the last run ──────────────
    if (!isIntervalElapsed(campaign.autopilot_last_run_at, intervalMins)) {
      const minsAgo = campaign.autopilot_last_run_at
        ? Math.floor((Date.now() - new Date(campaign.autopilot_last_run_at).getTime()) / 60_000)
        : 0;
      const minsUntilNext = intervalMins - minsAgo;
      summary.push({ campaignId: campaign.id, campaignName: campaign.name, status: 'skipped', reason: `Interval not elapsed — next run in ~${minsUntilNext} min (interval: ${intervalMins} min, batch: ${batchSize}, window: ${Math.round(windowMins)} min, daily: ${dailyLimit})` });
      continue;
    }
    const targetPerRun = Math.min(batchSize, dailyLimit - leadsToday);

    const { data: runRow } = await supabase.from('autopilot_runs').insert({
      campaign_id: campaign.id, user_id: campaign.user_id, status: 'running',
      batch_size: batchSize, target_leads: targetPerRun,
    }).select().single();
    const runId = (runRow as { id?: string } | null)?.id ?? null;

    let batchStatus: 'success' | 'error' = 'success';
    let errorMessage: string | null       = null;
    let batchResult: BatchResult          = { leadsFound: 0, addedToInstantly: 0, skippedDuplicate: 0, errors: [], warnings: [] };

    try {
      batchResult = await runAutopilotBatch(campaign, supabase, serperKey, apifyToken, instantlyKey, targetPerRun, mvApiKey || undefined);
      // Only real errors (not config warnings) drive status:'error'
      if (batchResult.errors.length > 0 && batchResult.leadsFound === 0) {
        batchStatus  = 'error';
        errorMessage = [...batchResult.errors, ...(batchResult.warnings ?? [])].join('; ');
      } else if (batchResult.leadsFound > 0 && batchResult.addedToInstantly === 0 && !campaign.instantly_campaign_id) {
        // Leads found but Instantly is not configured — surface as error so it's visible in the UI
        batchStatus  = 'error';
        errorMessage = `Found ${batchResult.leadsFound} leads but instantly_campaign_id is not set on this campaign — configure it in the campaign settings`;
      } else if ((batchResult.warnings ?? []).length > 0) {
        // Has warnings but either found leads or no hard error — keep 'success', surface warnings in message
        errorMessage = (batchResult.warnings ?? []).join('; ');
      }
    } catch (e) {
      batchStatus = 'error'; errorMessage = e instanceof Error ? e.message : String(e);
    }

    const newLeadsToday = leadsToday + batchResult.leadsFound;

    // Only advance the interval clock when leads were actually found.
    // If 0 leads: autopilot_last_run_at stays unchanged so the next cron tick
    // (~10 min) retries immediately instead of waiting the full scheduled interval.
    await supabase.from('campaigns').update({
      autopilot_leads_today: newLeadsToday,
      autopilot_reset_date:  todayDate,
      ...(batchResult.leadsFound > 0 ? { autopilot_last_run_at: new Date().toISOString() } : {}),
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
      targetPerRun, windowHours: windowMins / 60,
      errors: batchResult.errors.length > 0 ? batchResult.errors : undefined,
    });
  }

  return res.status(200).json({ ok: true, processedAt: new Date().toISOString(), currentHourUTC, processed: summary.length, campaigns: summary });
}
