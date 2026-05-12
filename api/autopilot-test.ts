/**
 * api/autopilot-test.ts
 *
 * On-demand debug endpoint: runs one campaign's autopilot batch with verbose
 * step-by-step logging. Auth via Supabase JWT (normal app session).
 *
 * POST /api/autopilot-test
 * Body: { campaignId: string, dryRun?: boolean }
 *
 * dryRun=true  (default) — scrapes + email discovery but does NOT write to DB or Instantly.
 * dryRun=false           — real run: inserts leads + adds to Instantly.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ── constants ──────────────────────────────────────────────────────────────────

const APIFY_BASE             = 'https://api.apify.com/v2';
const TIKTOK_PROFILE_SCRAPER = 'apidojo~tiktok-scraper';
const INSTAGRAM_SCRAPER      = 'apify~instagram-profile-scraper';

const _FETCH_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Cache-Control':   'no-cache',
};

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

const ANTI_ICP_BIO_KEYWORDS = [
  'restaurant','cafe','bakery','food truck','boutique','retail store',
  'dental','dentist','clinic','salon','spa','franchise',
  'dancer','dancing','choreograph','scenepack','sound promo','music promo',
  'anime edit','fashion','beauty','makeup','skincare','nail','lash',
  'ugc creator','user generated content','public speaker','keynote speaker',
];

const TIKTOK_SKIP    = new Set(['tag','search','discover','music','video','live','trending','foryou','t']);
const INSTAGRAM_SKIP = new Set(['p','reel','reels','explore','stories','accounts','tv','direct','hashtag','tagged','about','directory']);

// ── types ──────────────────────────────────────────────────────────────────────

type Logger = (level: 'info' | 'ok' | 'warn' | 'error', msg: string) => void;

interface CampaignRow {
  id: string;
  user_id: string;
  name: string;
  icp_type: string;
  icp_regions: string[];
  icp_content_types: string[];
  icp_min_followers: number;
  icp_max_followers: number;
  autopilot_batch_size: number;
  instantly_campaign_id: string | null;
}

export interface TestResult {
  leadsFound: number;
  addedToInstantly: number;
  skippedDuplicate: number;
  skippedNoEmail: number;
  skippedIcp: number;
  errors: string[];
  warnings: string[];
}

// ── Serper ─────────────────────────────────────────────────────────────────────

async function serperSearch(query: string, apiKey: string, page = 1): Promise<Array<{ link: string }>> {
  const res = await fetch('https://google.serper.dev/search', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body:    JSON.stringify({ q: query, num: 20, ...(page > 1 ? { page } : {}) }),
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`);
  const data = await res.json() as { organic?: Array<{ link?: string }> };
  return (data.organic ?? []).filter(r => r.link).map(r => ({ link: r.link! }));
}

// ── Apify ──────────────────────────────────────────────────────────────────────

async function runApifyActor(actorId: string, input: unknown, token: string, timeoutSecs = 90): Promise<unknown[]> {
  const startRes = await fetch(
    `${APIFY_BASE}/acts/${actorId}/runs?timeout=${timeoutSecs}&memory=1024&token=${token}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
  );
  if (!startRes.ok) throw new Error(`Apify start HTTP ${startRes.status}: ${(await startRes.text()).substring(0, 200)}`);
  const start     = await startRes.json() as { data?: { id?: string; defaultDatasetId?: string } };
  const runId     = start.data?.id;
  const datasetId = start.data?.defaultDatasetId;
  if (!runId || !datasetId) throw new Error('Apify: missing runId/datasetId');

  const deadline = Date.now() + (timeoutSecs + 35) * 1000;
  let finalStatus = '';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const s  = await fetch(`${APIFY_BASE}/acts/${actorId}/runs/${runId}?token=${token}`);
    const sd = await s.json() as { data?: { status?: string } };
    finalStatus = sd.data?.status ?? '';
    if (['SUCCEEDED','TIMED-OUT','TIMING-OUT','FAILED','ABORTED'].includes(finalStatus)) break;
  }
  if (finalStatus === 'TIMING-OUT') await new Promise(r => setTimeout(r, 4000));
  if (finalStatus === 'FAILED' || finalStatus === 'ABORTED') throw new Error(`Apify actor ${finalStatus}`);

  const items = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?limit=500&token=${token}`);
  const data  = await items.json() as unknown[];
  return Array.isArray(data) ? data : [];
}

// ── Inline email discovery ─────────────────────────────────────────────────────

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
      if (m?.[1] && m[1].includes('@') && !m[1].includes('tiktok.com') && !m[1].includes('example.com'))
        return m[1].toLowerCase().trim();
    }
  } catch { /* ignore */ }
  return '';
}

async function inlineIgCrossRef(bio: string): Promise<string> {
  for (const pat of [/(?:ig|insta(?:gram)?)\s*:?\s*@?([a-z0-9._]{1,30})/i, /instagram\.com\/([a-z0-9._]{1,30})/i]) {
    const m = bio.match(pat);
    if (m?.[1]) return inlineIgEmail(m[1].replace(/[^a-z0-9._]/gi, ''));
  }
  return '';
}

// ── Query builders ─────────────────────────────────────────────────────────────

const FACELESS_POOLS: string[][] = [
  ['"gmail.com"','"clipper"','"editor"','"edits"','"daily clips"','"dm for promo"'],
  ['"gmail.com"','"no excuses"','"best version"','"discipline"','"slideshow"','"no face"'],
  ['"gmail.com"','"hormozi"','"iman gadzhi"','"david goggins"','"tate"','"goggins"'],
  ['"gmail.com"','"smma"','"skool"','"wop"','"online business"','"make money online"'],
];
const IG_POOLS: string[][] = [
  ['"gmail.com"','"personal trainer"','"fitness"'],
  ['"gmail.com"','"fitness coach"','"workout"'],
  ['"gmail.com"','"gym"','"lifting"'],
];
const IG_CITIES  = ['New York','Los Angeles','Miami','Chicago','London','Toronto','Atlanta','Denver','Seattle','Houston'];
const IG_HEIGHTS = ["5'7\"","5'8\"","5'9\"","5'10\"","5'11\"","6'","6'1\"","6'2\""];
const IG_WEIGHTS = ['150lbs','155lbs','160lbs','165lbs','170lbs','175lbs','180lbs','185lbs'];
const IG_NEG     = '-restaurant -cafe -clinic -store -food -apparel';

function buildTikTokQuery(attempt: number, regions: string[]): string {
  const pool = FACELESS_POOLS[attempt % FACELESS_POOLS.length];
  const q    = `site:tiktok.com (${pool.join(' OR ')}) -restaurant -store -boutique -cooking -dance -site:tiktok.com/tag/`;
  const regionTerms: Record<string, string[]> = {
    US: ['"United States"','USA'], CA: ['Canada'], UK: ['"United Kingdom"'], AU: ['Australia'],
  };
  const loc = regions.flatMap(r => regionTerms[r] ?? []);
  return loc.length ? `${q} (${loc.join(' OR ')})` : q;
}

function buildIgQuery(attempt: number): string {
  if (attempt % 2 === 1) {
    const city   = IG_CITIES[Math.floor(Math.random() * IG_CITIES.length)];
    const height = IG_HEIGHTS[Math.floor(Math.random() * IG_HEIGHTS.length)];
    const weight = IG_WEIGHTS[Math.floor(Math.random() * IG_WEIGHTS.length)];
    return `site:instagram.com "${city}" "${height}" "${weight}" "gmail.com" ${IG_NEG}`;
  }
  const pool = IG_POOLS[Math.floor(attempt / 2) % IG_POOLS.length];
  return `site:instagram.com ${pool.join(' ')} ${IG_NEG}`;
}

function extractEmailFromBio(bio: string): string | null {
  const m = bio.match(EMAIL_REGEX);
  return m ? m[0].toLowerCase() : null;
}

function extractTikTokHandle(url: string): string | null {
  try {
    const h = (new URL(url.startsWith('http') ? url : 'https://' + url)
      .pathname.split('/').filter(Boolean)[0] ?? '')
      .replace(/^@/, '').toLowerCase();
    return TIKTOK_SKIP.has(h) || h.length < 2 ? null : h;
  } catch { return null; }
}

function extractIgHandle(url: string): string | null {
  try {
    const h = (new URL(url.startsWith('http') ? url : 'https://' + url)
      .pathname.split('/').filter(Boolean)[0] ?? '')
      .replace(/^@/, '').toLowerCase();
    return INSTAGRAM_SKIP.has(h) || h.length < 2 ? null : h;
  } catch { return null; }
}

// ── TikTok test batch ──────────────────────────────────────────────────────────

async function testTikTokBatch(
  campaign: CampaignRow,
  supabase: ReturnType<typeof createClient>,
  serperKey: string,
  apifyToken: string,
  instantlyKey: string,
  dryRun: boolean,
  log: Logger,
): Promise<TestResult> {
  const result: TestResult = {
    leadsFound: 0, addedToInstantly: 0,
    skippedDuplicate: 0, skippedNoEmail: 0, skippedIcp: 0,
    errors: [], warnings: [],
  };
  const batchSize   = campaign.autopilot_batch_size ?? 5;
  const minF        = campaign.icp_min_followers ?? 0;
  const maxF        = campaign.icp_max_followers ?? 99_000_000;
  const instantlyId = campaign.instantly_campaign_id;
  if (!instantlyId) result.warnings.push('instantly_campaign_id not set — Instantly will be skipped');

  const { data: existing } = await supabase
    .from('leads').select('ig_handle').eq('campaign_id', campaign.id).not('ig_handle', 'is', null);
  const seen = new Set<string>(
    (existing ?? []).map((r: { ig_handle: string }) => r.ig_handle?.toLowerCase()).filter(Boolean),
  );
  log('ok', `${seen.size} handles already in DB (dedup ready)`);

  for (let iter = 0; iter < 3; iter++) {
    log('info', `── Iteration ${iter + 1} ──`);
    const query = buildTikTokQuery(iter, campaign.icp_regions ?? []);
    log('info', `Serper query: ${query}`);

    let googleResults: Array<{ link: string }>;
    try {
      const t0 = Date.now();
      googleResults = await serperSearch(query, serperKey);
      log('ok', `Serper: ${googleResults.length} results (${Date.now() - t0}ms)`);
    } catch (e) {
      log('error', `Serper failed: ${e instanceof Error ? e.message : String(e)}`);
      result.errors.push(String(e)); break;
    }

    const candidates: string[] = [];
    for (const { link } of googleResults) {
      if (!link.includes('tiktok.com')) continue;
      const h = extractTikTokHandle(link);
      if (!h) continue;
      if (seen.has(h)) log('info', `  @${h} → already in DB`);
      else if (!candidates.includes(h)) { candidates.push(h); log('info', `  @${h} → NEW`); }
    }

    if (candidates.length === 0) { log('warn', 'No new handles — all results already in DB'); continue; }
    log('ok', `${candidates.length} new handles: ${candidates.slice(0, 8).join(', ')}${candidates.length > 8 ? '…' : ''}`);

    const toFetch = candidates.slice(0, batchSize * 3);
    log('info', `Apify apidojo~tiktok-scraper → ${toFetch.length} profiles…`);
    let items: unknown[];
    try {
      const t1 = Date.now();
      items = await runApifyActor(TIKTOK_PROFILE_SCRAPER, {
        startUrls: toFetch.map(h => `https://www.tiktok.com/@${h}`),
        maxItems:  toFetch.length * 15,
      }, apifyToken, 90);
      log('ok', `Apify: ${items.length} video items in ${Math.round((Date.now() - t1) / 1000)}s`);
    } catch (e) {
      log('error', `Apify failed: ${e instanceof Error ? e.message : String(e)}`);
      result.errors.push(String(e)); break;
    }

    interface Ch { username?: string; name?: string; followers?: number; fans?: number; bio?: string; signature?: string; email?: string }
    const profileMap = new Map<string, Ch>();
    for (const raw of items) {
      const p  = raw as { channel?: Ch };
      const ch = p.channel;
      if (!ch) continue;
      const h = (ch.username ?? ch.name ?? '').toLowerCase().replace(/^@/, '');
      if (!h || profileMap.has(h)) continue;
      profileMap.set(h, ch);
    }
    log('info', `Grouped into ${profileMap.size} unique profiles from ${items.length} video items`);

    for (const [handle, ch] of profileMap) {
      const bio       = ch.bio ?? ch.signature ?? '';
      const followers = ch.followers ?? ch.fans ?? 0;
      const name      = ch.name ?? handle;
      log('info', `  @${handle} | ${followers.toLocaleString()} followers | "${bio.substring(0, 70).replace(/\n/g, ' ')}"`);

      if (seen.has(handle)) { result.skippedDuplicate++; log('info', '    skip: already in DB'); continue; }
      if (followers < minF || (maxF > 0 && followers > maxF)) {
        result.skippedIcp++; log('warn', `    skip: ${followers} followers outside ${minF}–${maxF}`); continue;
      }
      const badKw = ANTI_ICP_BIO_KEYWORDS.find(kw => bio.toLowerCase().includes(kw));
      if (badKw) { result.skippedIcp++; log('warn', `    skip: ICP keyword "${badKw}"`); continue; }

      const emailFromScraper = (ch.email ?? '').toLowerCase().trim();
      const emailFromBio     = extractEmailFromBio(bio);
      let emailFinal = emailFromScraper || emailFromBio || '';
      let emailSrc   = emailFromScraper ? 'scraper.email' : emailFromBio ? 'bio text' : '';

      if (!emailFinal) {
        log('info', '    no email in scraper/bio → inline TikTok HTML + IG cross-ref…');
        const [tt, ig] = await Promise.all([inlineTikTokEmail(handle), inlineIgCrossRef(bio)]);
        emailFinal = tt || ig;
        emailSrc   = tt ? 'TikTok HTML' : ig ? 'IG cross-ref from bio' : '';
      }

      if (!emailFinal) { result.skippedNoEmail++; log('warn', '    skip: no email found'); continue; }
      log('ok', `    email: ${emailFinal} (${emailSrc})`);

      if (dryRun) {
        result.leadsFound++; seen.add(handle);
        log('ok', '    [DRY RUN] would insert + add to Instantly');
      } else {
        const { error: ie } = await supabase.from('leads').insert({
          user_id: campaign.user_id, campaign_id: campaign.id, name,
          ig_handle: handle, follower_count: followers,
          niche: campaign.icp_content_types?.[0] ?? '',
          audience_tier: followers >= 200_000 ? 'mid' : followers >= 50_000 ? 'micro' : 'nano',
          job_title: 'Content Creator', email: emailFinal, bio,
          ai_summary: `Test run (TikTok). Bio: ${bio.substring(0, 200)}`,
          vsl_sent_status: 'pending', email_status: 'pending', status: 'scraped', source: 'tiktok',
        });
        if (ie) { result.errors.push(`DB @${handle}: ${ie.message}`); log('error', `    DB insert failed: ${ie.message}`); continue; }
        seen.add(handle); result.leadsFound++;
        log('ok', '    inserted into DB');
        if (instantlyId) {
          const ir = await fetch('https://api.instantly.ai/api/v2/leads', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${instantlyKey}` },
            body:    JSON.stringify({ campaign: instantlyId, email: emailFinal, first_name: name.split(' ')[0] || handle, skip_if_in_workspace: true }),
          });
          if (ir.ok || ir.status === 409) { result.addedToInstantly++; log('ok', '    added to Instantly'); }
          else log('error', `    Instantly HTTP ${ir.status}`);
        }
      }
    }
    if (result.leadsFound >= batchSize) break;
  }
  return result;
}

// ── Instagram test batch ───────────────────────────────────────────────────────

async function testInstagramBatch(
  campaign: CampaignRow,
  supabase: ReturnType<typeof createClient>,
  serperKey: string,
  apifyToken: string,
  instantlyKey: string,
  dryRun: boolean,
  log: Logger,
): Promise<TestResult> {
  const result: TestResult = {
    leadsFound: 0, addedToInstantly: 0,
    skippedDuplicate: 0, skippedNoEmail: 0, skippedIcp: 0,
    errors: [], warnings: [],
  };
  const batchSize   = campaign.autopilot_batch_size ?? 5;
  const minF        = campaign.icp_min_followers ?? 0;
  const maxF        = campaign.icp_max_followers ?? 99_000_000;
  const instantlyId = campaign.instantly_campaign_id;
  if (!instantlyId) result.warnings.push('instantly_campaign_id not set — Instantly will be skipped');

  const { data: existing } = await supabase
    .from('leads').select('ig_handle').eq('campaign_id', campaign.id).not('ig_handle', 'is', null);
  const seen = new Set<string>(
    (existing ?? []).map((r: { ig_handle: string }) => r.ig_handle?.toLowerCase()).filter(Boolean),
  );
  log('ok', `${seen.size} handles already in DB (dedup ready)`);

  for (let iter = 0; iter < 3; iter++) {
    log('info', `── Iteration ${iter + 1} ──`);
    const query = buildIgQuery(iter);
    log('info', `Serper query: ${query}`);

    const candidates: string[] = [];
    let failed = false;

    for (let page = 1; page <= 5 && candidates.length === 0; page++) {
      let pageRes: Array<{ link: string }>;
      try {
        const t0 = Date.now();
        pageRes = await serperSearch(query, serperKey, page);
        log(pageRes.length > 0 ? 'ok' : 'warn', `Serper page ${page}: ${pageRes.length} results (${Date.now() - t0}ms)`);
      } catch (e) {
        log('error', `Serper page ${page}: ${e instanceof Error ? e.message : String(e)}`);
        result.errors.push(String(e)); failed = true; break;
      }
      if (pageRes.length === 0) break;
      for (const { link } of pageRes) {
        if (!link.includes('instagram.com')) continue;
        const h = extractIgHandle(link);
        if (!h) continue;
        if (seen.has(h)) log('info', `  @${h} → already in DB`);
        else if (!candidates.includes(h)) { candidates.push(h); log('info', `  @${h} → NEW`); }
      }
    }
    if (failed) break;
    if (candidates.length === 0) { log('warn', 'No new handles — all pages exhausted'); continue; }
    log('ok', `${candidates.length} new handles: ${candidates.slice(0, 8).join(', ')}${candidates.length > 8 ? '…' : ''}`);

    const toFetch = candidates.slice(0, batchSize);
    log('info', `Apify apify~instagram-profile-scraper → ${toFetch.length} profiles…`);
    let items: unknown[];
    try {
      const t1 = Date.now();
      items = await runApifyActor(INSTAGRAM_SCRAPER, { usernames: toFetch }, apifyToken, 60);
      log('ok', `Apify: ${items.length} profiles in ${Math.round((Date.now() - t1) / 1000)}s`);
    } catch (e) {
      log('error', `Apify failed: ${e instanceof Error ? e.message : String(e)}`);
      result.errors.push(String(e)); break;
    }

    for (const raw of items) {
      const p         = raw as Record<string, unknown>;
      const handle    = ((p.username as string) || '').toLowerCase().replace(/^@/, '');
      const bio       = ((p.biography as string) || (p.bio as string) || '');
      const followers = (p.followersCount as number) ?? 0;
      const name      = ((p.fullName as string) || (p.name as string) || handle);
      log('info', `  @${handle} | ${followers.toLocaleString()} followers | "${bio.substring(0, 70).replace(/\n/g, ' ')}"`);

      if (!handle || seen.has(handle)) { result.skippedDuplicate++; log('info', '    skip: already in DB'); continue; }
      if (followers < minF || (maxF > 0 && followers > maxF)) {
        result.skippedIcp++; log('warn', `    skip: ${followers} followers outside ${minF}–${maxF}`); continue;
      }
      const badKw = ANTI_ICP_BIO_KEYWORDS.find(kw => bio.toLowerCase().includes(kw));
      if (badKw) { result.skippedIcp++; log('warn', `    skip: ICP keyword "${badKw}"`); continue; }

      const emailFromScraper = (
        ((p.publicEmail as string) || (p.businessEmail as string) || (p.contactEmail as string)) || ''
      ).toLowerCase().trim();
      const emailFromBio = extractEmailFromBio(bio);
      let emailFinal = emailFromScraper || emailFromBio || '';
      let emailSrc   = emailFromScraper ? 'scraper field' : emailFromBio ? 'bio text' : '';

      if (!emailFinal) {
        log('info', '    no email in scraper/bio → inline IG HTML fetch…');
        emailFinal = await inlineIgEmail(handle);
        emailSrc   = emailFinal ? 'IG HTML fetch' : '';
      }

      if (!emailFinal) { result.skippedNoEmail++; log('warn', '    skip: no email found'); continue; }
      log('ok', `    email: ${emailFinal} (${emailSrc})`);

      if (dryRun) {
        result.leadsFound++; seen.add(handle);
        log('ok', '    [DRY RUN] would insert + add to Instantly');
      } else {
        const { error: ie } = await supabase.from('leads').insert({
          user_id: campaign.user_id, campaign_id: campaign.id, name,
          ig_handle: handle, follower_count: followers,
          niche: campaign.icp_content_types?.[0] ?? '',
          audience_tier: followers >= 200_000 ? 'mid' : followers >= 50_000 ? 'micro' : 'nano',
          job_title: 'Content Creator', email: emailFinal, bio,
          ai_summary: `Test run (Instagram). Bio: ${bio.substring(0, 200)}`,
          vsl_sent_status: 'pending', email_status: 'pending', status: 'scraped', source: 'instagram',
        });
        if (ie) { result.errors.push(`DB @${handle}: ${ie.message}`); log('error', `    DB insert failed: ${ie.message}`); continue; }
        seen.add(handle); result.leadsFound++;
        log('ok', '    inserted into DB');
        if (instantlyId) {
          const ir = await fetch('https://api.instantly.ai/api/v2/leads', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${instantlyKey}` },
            body:    JSON.stringify({ campaign: instantlyId, email: emailFinal, first_name: name.split(' ')[0] || handle, skip_if_in_workspace: true }),
          });
          if (ir.ok || ir.status === 409) { result.addedToInstantly++; log('ok', '    added to Instantly'); }
          else log('error', `    Instantly HTTP ${ir.status}`);
        }
      }
    }
    if (result.leadsFound >= batchSize) break;
  }
  return result;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' });

  const supabaseUrl     = process.env.VITE_SUPABASE_URL      ?? process.env.SUPABASE_URL      ?? '';
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  const serviceKey      = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !supabaseAnonKey || !serviceKey)
    return res.status(500).json({ error: 'Missing Supabase env vars' });

  const authHeader = (req.headers['authorization'] as string) ?? '';
  const jwt        = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: 'Missing Authorization: Bearer <supabase-jwt>' });

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });

  const body       = req.body as Record<string, unknown> | null;
  const campaignId = (req.query.campaignId as string) || (body?.campaignId as string);
  const dryRun     = req.query.dryRun !== 'false' && body?.dryRun !== false;
  if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns').select('*').eq('id', campaignId).single();
  if (campErr || !campaign)
    return res.status(404).json({ error: `Campaign not found: ${campErr?.message ?? 'no row'}` });

  const serperKey    = process.env.SERPER_API_KEY ?? '';
  const apifyToken   = process.env.APIFY_TOKEN ?? process.env.VITE_APIFY_API_TOKEN ?? '';
  const instantlyKey = process.env.INSTANTLY_API_KEY ?? '';
  if (!serperKey)    return res.status(500).json({ error: 'Missing SERPER_API_KEY' });
  if (!apifyToken)   return res.status(500).json({ error: 'Missing APIFY_TOKEN' });
  if (!instantlyKey) return res.status(500).json({ error: 'Missing INSTANTLY_API_KEY' });

  const logs: string[] = [];
  const log: Logger = (level, msg) => {
    const icon  = level === 'ok' ? '✓' : level === 'warn' ? '⚠' : level === 'error' ? '✗' : '·';
    const entry = `${icon} ${msg}`;
    logs.push(entry);
    console.log(`[autopilot-test] ${entry}`);
  };

  const startMs = Date.now();
  log('info', `Campaign: "${campaign.name}"  |  type: ${campaign.icp_type ?? 'faceless_clipper'}`);
  log('info', `Mode: ${dryRun ? 'DRY RUN — no DB/Instantly writes' : 'LIVE — will insert real leads'}`);
  log('info', `Instantly ID: ${campaign.instantly_campaign_id ?? '(not set)'}`);
  log('info', `ICP followers: ${campaign.icp_min_followers ?? 0} – ${campaign.icp_max_followers ?? '∞'}`);
  log('info', `Batch size: ${campaign.autopilot_batch_size ?? 5}`);
  log('info', '───────────────────────────────────────────');

  let result: TestResult;
  try {
    result = campaign.icp_type === 'personal_brand'
      ? await testInstagramBatch(campaign as CampaignRow, supabase, serperKey, apifyToken, instantlyKey, dryRun, log)
      : await testTikTokBatch(campaign as CampaignRow, supabase, serperKey, apifyToken, instantlyKey, dryRun, log);
  } catch (fatal) {
    log('error', `FATAL: ${fatal instanceof Error ? fatal.message : String(fatal)}`);
    result = {
      leadsFound: 0, addedToInstantly: 0, skippedDuplicate: 0,
      skippedNoEmail: 0, skippedIcp: 0,
      errors: [String(fatal)], warnings: [],
    };
  }

  const durationMs = Date.now() - startMs;
  log('info', '───────────────────────────────────────────');
  log(
    result.errors.length > 0 && result.leadsFound === 0 ? 'error' : 'ok',
    `Done ${(durationMs / 1000).toFixed(1)}s | leads: ${result.leadsFound} | instantly: ${result.addedToInstantly} | no-email: ${result.skippedNoEmail} | icp-skip: ${result.skippedIcp} | dup: ${result.skippedDuplicate}`,
  );

  return res.status(200).json({
    ok: result.errors.length === 0 || result.leadsFound > 0,
    campaignName: campaign.name,
    dryRun,
    durationMs,
    logs,
    result,
  });
}
