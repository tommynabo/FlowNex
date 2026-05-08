/**
 * CronSearchOrchestrator
 *
 * Server-side only (Vercel Serverless / Node.js).
 * Executes one autopilot batch for a single campaign:
 *   1. Builds a Google Search query (site:tiktok.com) from FACELESS_CLIPPER_KEYWORD_POOLS
 *   2. Runs the query through Apify Google Search actor (direct HTTPS call, not /api/apify proxy)
 *   3. Extracts TikTok handles from result URLs
 *   4. Filters out handles already in this campaign (dedup via Supabase lookup)
 *   5. Fetches TikTok profile data via Apify TikTok scraper
 *   6. Applies rule-based ICP filter (followers + bio keywords) — no GPT to stay under 60s
 *   7. Extracts email from bio text (regex — no website scraping to control latency)
 *   8. Saves qualified leads to Supabase `leads` table
 *   9. Adds leads to Instantly campaign
 *  10. Returns { leadsFound, addedToInstantly }
 *
 * Key difference from TikTokFacelessEngine: uses absolute Apify URLs instead of the
 * /api/apify browser proxy. Safe to call from Node.js serverless context.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Keyword pools (copied here to avoid importing browser-side TikTokFacelessEngine) ──
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

// ── Apify actor IDs (same as TikTokFacelessEngine) ───────────────────────────
const GOOGLE_SEARCH_SCRAPER  = 'nFJndFXA5zjCTuudP';
const TIKTOK_PROFILE_SCRAPER = 'apidojo~tiktok-scraper';

// ── Anti-ICP bio keywords (subset of ICPEvaluator — most impactful rejections) ──
const ANTI_ICP_BIO_KEYWORDS = [
  'restaurant', 'cafe', 'bakery', 'food truck', 'boutique', 'retail store',
  'dental', 'dentist', 'clinic', 'salon', 'spa', 'franchise',
  'dancer', 'dancing', 'choreograph', 'scenepack', 'sound promo', 'music promo',
  'anime edit', 'fashion', 'beauty', 'makeup', 'skincare', 'nail', 'lash',
  'ugc creator', 'user generated content', 'public speaker', 'keynote speaker',
  'restaurante', 'cafetería', 'panadería', 'inmobiliaria', 'peluquería',
];

const ANTI_ICP_NEGATIVES = '-restaurant -store -boutique -cooking -dance';
const TIKTOK_SKIP_HANDLES = new Set(['tag', 'search', 'discover', 'music', 'video', 'live', 'trending', 'foryou', 't']);

// Email regex — extracts first email found in a bio string
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CampaignRow {
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
}

export interface BatchResult {
  leadsFound: number;
  addedToInstantly: number;
  skippedDuplicate: number;
  errors: string[];
}

interface ApifyRunResponse {
  data?: { id?: string; defaultDatasetId?: string };
}

interface TikTokProfileItem {
  authorMeta?: {
    id?: string;
    name?: string;
    nickName?: string;
    fans?: number;
    following?: number;
    heart?: number;
    video?: number;
    signature?: string; // bio text
    region?: string;
  };
  channel?: {
    id?: string;
    name?: string;
    nickName?: string;
    fans?: number;
    signature?: string;
    region?: string;
  };
}

// ── Apify direct helpers ──────────────────────────────────────────────────────

const APIFY_BASE = 'https://api.apify.com/v2';

async function apifyPost(path: string, body: unknown, token: string): Promise<unknown> {
  const res = await fetch(`${APIFY_BASE}/${path}?token=${token}`, {
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
  const res = await fetch(`${APIFY_BASE}/${path}?token=${token}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify GET ${path} → HTTP ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

/** Starts an Apify actor run and waits for it to finish. Returns dataset items. */
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

  // Poll until done (max timeoutSecs × 1000ms + 10s grace)
  const deadline = Date.now() + (timeoutSecs + 10) * 1000;
  let finalStatus = '';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await apifyGet(`acts/${actorId}/runs/${runId}`, token) as { data?: { status?: string } };
    finalStatus = status.data?.status ?? '';
    if (finalStatus === 'SUCCEEDED') break;
    if (finalStatus === 'FAILED' || finalStatus === 'ABORTED') throw new Error(`Apify actor ${actorId} ${finalStatus}`);
  }

  // Guard: if polling expired before actor finished, don't read incomplete data
  if (finalStatus !== 'SUCCEEDED') {
    throw new Error(`Apify actor ${actorId} timed out (still ${finalStatus || 'RUNNING'} after ${timeoutSecs + 10}s)`);
  }

  const dataset = await apifyGet(`datasets/${datasetId}/items?limit=100`, token) as unknown[];
  return Array.isArray(dataset) ? dataset : [];
}

// ── URL → handle extraction ───────────────────────────────────────────────────

function extractHandleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const handle = parts[0].replace(/^@/, '').toLowerCase();
    if (TIKTOK_SKIP_HANDLES.has(handle) || handle.length < 2) return null;
    return handle;
  } catch {
    return null;
  }
}

// ── Bio-based ICP filter ──────────────────────────────────────────────────────

function passesIcpFilter(
  bio: string,
  followers: number,
  minFollowers: number,
  maxFollowers: number,
): boolean {
  if (followers < minFollowers || (maxFollowers > 0 && followers > maxFollowers)) return false;
  const bioLower = bio.toLowerCase();
  for (const kw of ANTI_ICP_BIO_KEYWORDS) {
    if (bioLower.includes(kw)) return false;
  }
  return true;
}

// ── Email extraction from bio ─────────────────────────────────────────────────

function extractEmailFromBio(bio: string): string | null {
  const match = bio.match(EMAIL_REGEX);
  return match ? match[0].toLowerCase() : null;
}

// ── Instantly direct API call ─────────────────────────────────────────────────

async function addLeadToInstantly(
  instantlyKey: string,
  campaignId: string,
  lead: {
    email: string;
    name: string;
    igHandle: string;
    niche: string;
    followerCount: number;
    aiSummary: string;
  },
): Promise<boolean> {
  const nameParts = lead.name.trim().split(' ');
  const firstName = nameParts[0] || lead.igHandle;
  const lastName  = nameParts.slice(1).join(' ') || '';

  try {
    const res = await fetch('https://api.instantly.ai/api/v2/leads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${instantlyKey}`,
      },
      body: JSON.stringify({
        campaign: campaignId,
        email: lead.email.toLowerCase().trim(),
        first_name: firstName,
        last_name: lastName,
        skip_if_in_workspace: true,
        variables: {
          ig_handle: lead.igHandle,
          niche: lead.niche,
          ai_summary: lead.aiSummary,
          follower_count: String(lead.followerCount),
        },
      }),
    });
    return res.ok || res.status === 409; // 409 = already exists (skip_if_in_workspace)
  } catch {
    return false;
  }
}

// ── Query builder (simplified version of TikTokFacelessEngine.buildSearchQuery) ──

function buildSearchQuery(attempt: number, regions: string[] = []): string {
  // Cycle through keyword pools: attempt 0→pool0, 1→pool1, etc.
  const poolIdx = attempt % FACELESS_CLIPPER_KEYWORD_POOLS.length;
  const terms   = FACELESS_CLIPPER_KEYWORD_POOLS[poolIdx];
  const orGroup = '(' + terms.join(' OR ') + ')';

  // Location suffix for ≤3 configured regions
  const REGION_QUERY_TERMS: Record<string, string[]> = {
    US: ['"United States"', 'USA'],
    CA: ['Canada'],
    UK: ['"United Kingdom"', 'England'],
    AU: ['Australia'],
  };
  let locationSuffix = '';
  if (regions.length > 0 && regions.length <= 3) {
    const allTerms = regions.flatMap(r => REGION_QUERY_TERMS[r] ?? []);
    if (allTerms.length) locationSuffix = '(' + allTerms.join(' OR ') + ')';
  }

  const base = `site:tiktok.com ${orGroup} ${ANTI_ICP_NEGATIVES} -site:tiktok.com/tag/`;
  return locationSuffix ? `${base} ${locationSuffix}` : base;
}

// ── Main orchestration function ───────────────────────────────────────────────

export async function runAutopilotBatch(
  campaign: CampaignRow,
  supabase: SupabaseClient,
  apifyToken: string,
  instantlyKey: string,
): Promise<BatchResult> {
  const result: BatchResult = { leadsFound: 0, addedToInstantly: 0, skippedDuplicate: 0, errors: [] };

  const batchSize      = campaign.autopilot_batch_size ?? 5;
  const minFollowers   = campaign.icp_min_followers ?? 0;
  const maxFollowers   = campaign.icp_max_followers ?? 99_000_000;
  const instantlyId    = campaign.instantly_campaign_id;
  const regions        = campaign.icp_regions ?? [];

  // ── Step 1: Load existing handles for this campaign (dedup) ──────────────
  const { data: existingLeads } = await supabase
    .from('leads')
    .select('ig_handle')
    .eq('campaign_id', campaign.id)
    .not('ig_handle', 'is', null);

  const seenHandles = new Set<string>(
    (existingLeads ?? []).map((r: { ig_handle: string }) => r.ig_handle?.toLowerCase()).filter(Boolean),
  );

  // ── Step 2: Run Google Search to discover TikTok profile URLs ────────────
  // Use a random attempt offset so each cron run queries a different pool
  const attemptOffset = Math.floor(Math.random() * FACELESS_CLIPPER_KEYWORD_POOLS.length);
  const searchQuery   = buildSearchQuery(attemptOffset, regions);

  let googleResults: unknown[] = [];
  try {
    googleResults = await runActorSync(
      GOOGLE_SEARCH_SCRAPER,
      {
        queries: searchQuery,
        resultsPerPage: 10,
        maxPagesPerQuery: 1,
        languageCode: 'en',
        countryCode: 'us',
      },
      apifyToken,
      45, // 45s server-side timeout
      1024,
    );
  } catch (e) {
    result.errors.push(`Google Search failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // ── Step 3: Extract handles from Google result URLs ───────────────────────
  const candidateHandles: string[] = [];
  for (const item of googleResults) {
    const row = item as Record<string, unknown>;
    const url = (row.url ?? row.link ?? '') as string;
    if (!url.includes('tiktok.com')) continue;
    const handle = extractHandleFromUrl(url);
    if (handle && !seenHandles.has(handle) && !candidateHandles.includes(handle)) {
      candidateHandles.push(handle);
    }
  }

  if (candidateHandles.length === 0) {
    result.errors.push('No new handles found from Google Search');
    return result;
  }

  // ── Step 4: Fetch TikTok profile data ─────────────────────────────────────
  // Take only as many as batchSize to control latency
  const toFetch = candidateHandles.slice(0, batchSize);
  const startUrls = toFetch.map(h => ({ url: `https://www.tiktok.com/@${h}` }));

  let profileItems: unknown[] = [];
  try {
    profileItems = await runActorSync(
      TIKTOK_PROFILE_SCRAPER,
      { startUrls, resultsType: 'details', resultsLimit: batchSize },
      apifyToken,
      50,
      1024,
    );
  } catch (e) {
    result.errors.push(`TikTok profile scraper failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // ── Step 5: Process each profile ─────────────────────────────────────────
  for (const item of profileItems) {
    if (result.leadsFound >= batchSize) break;

    const profile = item as TikTokProfileItem;

    // Normalise profile fields (apidojo returns data in authorMeta or channel)
    const meta       = profile.authorMeta ?? profile.channel ?? {};
    const handle     = (meta.nickName ?? meta.name ?? '').toLowerCase().replace(/^@/, '');
    const bio        = meta.signature ?? '';
    const followers  = meta.fans ?? 0;
    const displayName = meta.name ?? handle;

    if (!handle || seenHandles.has(handle)) {
      result.skippedDuplicate++;
      continue;
    }

    // ── ICP filter (rule-based) ──
    if (!passesIcpFilter(bio, followers, minFollowers, maxFollowers)) continue;

    // ── Email extraction ──
    const email = extractEmailFromBio(bio);
    if (!email) continue; // email-first strategy: skip if no email in bio

    // ── Save to Supabase leads table ──
    // Note: seenHandles.add() called AFTER successful insert to allow retry on transient errors
    const { error: insertErr } = await supabase.from('leads').insert({
      user_id:       campaign.user_id,
      campaign_id:   campaign.id,
      name:          displayName,
      ig_handle:     handle,
      follower_count: followers,
      niche:         campaign.icp_content_types?.[0] ?? '',
      audience_tier: followers >= 200_000 ? 'mid' : followers >= 50_000 ? 'micro' : 'nano',
      job_title:     'Content Creator',
      email,
      bio,
      ai_summary:    `Autopilot scraped from TikTok. Bio: ${bio.substring(0, 200)}`,
      vsl_sent_status: 'pending',
      email_status:  'pending',
      status:        'scraped',
      source:        'tiktok',
    });

    if (insertErr) {
      result.errors.push(`DB insert failed for @${handle}: ${insertErr.message}`);
      continue;
    }

    // Mark handle as seen only after successful insert
    seenHandles.add(handle);
    result.leadsFound++;

    // ── Add to Instantly ──
    if (instantlyId && instantlyKey) {
      const ok = await addLeadToInstantly(instantlyKey, instantlyId, {
        email,
        name:         displayName,
        igHandle:     handle,
        niche:        campaign.icp_content_types?.[0] ?? '',
        followerCount: followers,
        aiSummary:    bio.substring(0, 300),
      });
      if (ok) result.addedToInstantly++;
    }
  }

  return result;
}
