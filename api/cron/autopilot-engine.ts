/**
 * Vercel Cron Job: /api/cron/autopilot-engine
 * Schedule: every 10 min (see vercel.json → "*/10 * * * *")
 *
 * Imports ICPEvaluator for the unified ICP hard-filter pipeline (pure TypeScript,
 * no browser dependencies — safe to run in Vercel Node.js serverless context).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, SupabaseClient }       from '@supabase/supabase-js';
import { icpEvaluator, RawApifyProfile }       from '../../services/search/ICPEvaluator';

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

// ANTI_ICP_BIO_KEYWORDS removed — ICPEvaluator.applyHardFilter() now owns the
// comprehensive rejection list and is called directly in each batch function.

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

  // Loop up to 4 search iterations until we reach targetLeads
  const baseOffset = Math.floor(Math.random() * FACELESS_CLIPPER_KEYWORD_POOLS.length);
  for (let iteration = 0; iteration < 4 && result.leadsFound < targetLeads; iteration++) {
    const attemptOffset = (baseOffset + iteration) % FACELESS_CLIPPER_KEYWORD_POOLS.length;

    // Steps 2+3: Paginate Serper until we have batchSize*3 candidate handles.
    // A single Serper page (20 results) often returns <5 new handles after dedup;
    // multi-page accumulation ensures enough candidates reach the Apify scraper.
    const TARGET_CANDIDATES_TT = batchSize * 3;
    const candidateHandles: string[] = [];
    let serperFailed = false;
    for (let serperPage = 1; serperPage <= 5 && candidateHandles.length < TARGET_CANDIDATES_TT; serperPage++) {
      let pageResults: Array<{ link: string }> = [];
      try {
        pageResults = await serperGoogleSearch(buildSearchQuery(attemptOffset, regions), serperKey, serperPage);
      } catch (e) {
        result.errors.push(`Google Search failed (iter ${iteration + 1}, page ${serperPage}): ${e instanceof Error ? e.message : String(e)}`);
        serperFailed = true;
        break;
      }
      if (pageResults.length === 0) break;
      for (const item of pageResults) {
        const url = item.link ?? '';
        if (!url.includes('tiktok.com')) continue;
        const handle = extractHandleFromUrl(url);
        if (handle && !seenHandles.has(handle) && !candidateHandles.includes(handle)) candidateHandles.push(handle);
      }
    }
    if (serperFailed) break;
    if (candidateHandles.length === 0) {
      result.errors.push(`No new handles found from Google Search (iter ${iteration + 1}) — trying next pool`);
      continue; // try a different keyword pool next iteration
    }

    // Step 4: TikTok profiles — correct apidojo input: plain string URLs + maxItems per handle
    const remaining = targetLeads - result.leadsFound;
    const toFetch   = candidateHandles.slice(0, Math.min(batchSize * 3, remaining + 10));
    let profileItems: unknown[] = [];
    try {
      profileItems = await runActorSync(
        TIKTOK_PROFILE_SCRAPER,
        {
          startUrls: toFetch.map(h => `https://www.tiktok.com/@${h}`),
          maxItems: toFetch.length * 15,
        },
        apifyToken, 90, 1024,
      );
    } catch (e) {
      result.errors.push(`TikTok profile scraper failed (iter ${iteration + 1}): ${e instanceof Error ? e.message : String(e)}`);
      break;
    }

    // Group raw video items by profile (apidojo returns N video items per creator)
    const profileMap = new Map<string, { ch: NonNullable<TikTokProfileItem['channel']>; am: TikTokProfileItem['authorMeta'] }>();
    for (const item of profileItems) {
      const p = item as TikTokProfileItem;
      const ch = p.channel ?? null;
      const am = p.authorMeta ?? null;
      const h  = (ch?.username ?? ch?.name ?? am?.name ?? '').toLowerCase().replace(/^@/, '');
      if (!h || profileMap.has(h)) continue;
      if (ch) profileMap.set(h, { ch, am });
    }
    const uniqueProfiles = Array.from(profileMap.entries());

    // Step 5: Process one entry per unique profile (deduped by grouping above)
    for (const [handle, { ch, am }] of uniqueProfiles) {
      if (result.leadsFound >= targetLeads) break;
      const bio         = ch?.bio ?? ch?.signature ?? am?.signature ?? '';
      const followers   = ch?.followers ?? ch?.fans ?? am?.fans ?? 0;
      const displayName = ch?.name ?? am?.nickName ?? handle;
      // Email: scraper may return it directly (channel.email) or it lives in bio text
      const email = ((ch as Record<string, unknown>)?.email as string | undefined)?.toLowerCase().trim()
        || extractEmailFromBio(bio);

      if (!handle || seenHandles.has(handle)) { result.skippedDuplicate++; continue; }
      // Comprehensive ICP filter — mirrors the manual TikTokFacelessEngine pipeline
      const rawProfile: RawApifyProfile = { username: handle, fullName: displayName, biography: bio, followersCount: followers };
      if (icpEvaluator.applyHardFilter([rawProfile], (m) => console.log('[ICP-TT]', m), 'faceless_clipper').length === 0) continue;
      // Also enforce campaign-specific follower range
      if (followers >= 0 && (followers < minFollowers || (maxFollowers > 0 && followers > maxFollowers))) continue;
      // Multi-stage email fallback
      let emailFinal = email ?? '';
      // Stage 2: Serper web search — most effective for TikTok creators
      if (!emailFinal) emailFinal = await serperEmailSearch(handle, serperKey);
      // Stage 3: inline TikTok HTML + IG cross-ref (last resort)
      if (!emailFinal) {
        const [ttEmail, igCrossRef] = await Promise.all([
          inlineTikTokEmail(handle),
          inlineIgCrossRef(bio),
        ]);
        emailFinal = ttEmail || igCrossRef;
      }
      if (!emailFinal) continue;

      const { error: insertErr } = await supabase.from('leads').insert({
        user_id: campaign.user_id, campaign_id: campaign.id, name: displayName,
        ig_handle: handle, follower_count: followers, niche: campaign.icp_content_types?.[0] ?? '',
        audience_tier: followers >= 200_000 ? 'mid' : followers >= 50_000 ? 'micro' : 'nano',
        job_title: 'Content Creator', email: emailFinal, bio,
        ai_summary: `Autopilot scraped from TikTok. Bio: ${bio.substring(0, 200)}`,
        vsl_sent_status: 'pending', email_status: 'pending', status: 'scraped', source: 'tiktok',
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

  const baseOffset = Math.floor(Math.random() * INSTAGRAM_KEYWORD_POOLS.length);
  for (let iteration = 0; iteration < 4 && result.leadsFound < targetLeads; iteration++) {
    const attemptOffset = (baseOffset + iteration) % INSTAGRAM_KEYWORD_POOLS.length;

    const query = buildInstagramSearchQuery(attemptOffset);
    const candidateHandles: string[] = [];
    let serperFailed = false;
    // Accumulate at least batchSize*3 candidate handles before handing off to Apify.
    // With a ~20-25% hit-rate inside the follower window we need ~15 candidates
    // to reliably produce 3-5 qualified leads per run.
    const TARGET_CANDIDATES_IG = batchSize * 3;
    for (let serperPage = 1; serperPage <= 5 && candidateHandles.length < TARGET_CANDIDATES_IG; serperPage++) {
      let pageResults: Array<{ link: string }> = [];
      try {
        pageResults = await serperGoogleSearch(query, serperKey, serperPage);
      } catch (e) {
        result.errors.push(`Google Search failed (iter ${iteration + 1}, page ${serperPage}): ${e instanceof Error ? e.message : String(e)}`);
        serperFailed = true;
        break;
      }
      if (pageResults.length === 0) break; // no more results from Serper
      for (const item of pageResults) {
        const url = item.link ?? '';
        if (!url.includes('instagram.com')) continue;
        const h = extractHandleFromInstagramUrl(url);
        if (h && !seenHandles.has(h) && !candidateHandles.includes(h)) candidateHandles.push(h);
      }
    }

    if (serperFailed) break;
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
      if (icpEvaluator.applyHardFilter([rawProfile], (m) => console.log('[ICP-IG]', m), 'personal_brand').length === 0) continue;
      // Also enforce campaign-specific follower range
      if (followers >= 0 && (followers < minFollowers || (maxFollowers > 0 && followers > maxFollowers))) continue;

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
    const startHour   = campaign.autopilot_start_hour   ?? 22;
    const startMinute = campaign.autopilot_start_minute ?? 0;
    const endHour     = campaign.autopilot_end_hour     ?? 6;
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
    let batchResult: BatchResult          = { leadsFound: 0, addedToInstantly: 0, skippedDuplicate: 0, errors: [] };

    try {
      batchResult = await runAutopilotBatch(campaign, supabase, serperKey, apifyToken, instantlyKey, targetPerRun);
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
      targetPerRun, windowHours: windowMins / 60,
      errors: batchResult.errors.length > 0 ? batchResult.errors : undefined,
    });
  }

  return res.status(200).json({ ok: true, processedAt: new Date().toISOString(), currentHourUTC, processed: summary.length, campaigns: summary });
}
