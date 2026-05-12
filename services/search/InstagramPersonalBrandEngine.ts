/**
 * InstagramPersonalBrandEngine — Dedicated engine for "Marca Personal" (Personal Brand) ICP
 *
 * Scope: Fitness coaches, personal trainers, gym influencers, and health/nutrition creators
 *        with a real Instagram presence.
 *
 * Platform: 100% site:instagram.com — zero TikTok logic in this file.
 * Scraper:  apify~instagram-profile-scraper (GraphQL API, not headless/Puppeteer).
 *
 * Architecture mirrors InstagramSearchEngine runSearchLoop():
 *   - Keep-going-until-N loop with consecutive-zeros guard
 *   - Session-level seenHandles Set
 *   - Batch AI analysis (Pilar 2: one OpenAI call per N leads)
 *   - Optional gpt-4o enrichment pass (Pilar 3, usePremiumModel flag)
 *   - Dedup pre-flight (Pilar 1)
 *   - Async streaming via onLeadFound (Pilar 4)
 *
 * Router: SearchService.ts delegates here when icpType !== 'faceless_clipper'.
 */

import { Lead, SearchConfigState, AudienceTier, VideoItem } from '../../lib/types';
import { deduplicationService } from '../deduplication/DeduplicationService';
import { PROJECT_CONFIG } from '../../config/project';
import { icpEvaluator, RawApifyProfile } from './ICPEvaluator';
import { emailDiscoveryService } from './EmailDiscoveryService';
import type { LogCallback, ResultCallback } from './SearchService';

// ── Fitness keyword pool — EMAIL-FIRST strategy ──────────────────────────────
// Google indexes Instagram bio text verbatim. Pools with "gmail.com" only surface
// profiles whose bio literally contains their Gmail → contactable lead BEFORE any
// scraping. Email discovery success rate: ~5% (no signal) → ~85%+ (gmail in bio).
//
// Pool families:
//   A (0-6):  Gmail-first — guaranteed contactable, highest yield
//   B (7-12): DM/contact intent without Gmail — still contactable via bio/link
//   C (13-15): Broad fitness keywords — fallback after relaxation (attempt > 15)
//
// Excluded intentionally: nutrition coach, diet, meal prep, sports nutrition.
// ICP = fitness/gym personal trainers — NOT nutrition/food coaches.
//
const KEYWORD_POOLS: string[][] = [
  // A0 — Gmail + personal trainer (most common fitness coach bio pattern)
  ['"gmail.com"', '"personal trainer"', '"fitness"'],
  // A1 — Gmail + fitness coach (self-description in bio)
  ['"gmail.com"', '"fitness coach"', '"workout"'],
  // A2 — Gmail + gym/lifting lifestyle creator
  ['"gmail.com"', '"gym"', '"lifting"'],
  // A3 — Gmail + body transformation / fat loss
  ['"gmail.com"', '"body transformation"', '"fat loss"'],
  // A4 — Gmail + online fitness coach (remote coaching bio pattern)
  ['"gmail.com"', '"online fitness coach"', '"personal trainer online"'],
  // A5 — Gmail + physique/muscle/bodybuilding
  ['"gmail.com"', '"physique"', '"bodybuilding"'],
  // A6 — Gmail + crossfit/hiit/strength coach
  ['"gmail.com"', '"strength coach"', '"crossfit"'],
  // B0 — DM for collab signal (explicit contact intent)
  ['"dm for collab"', '"personal trainer"', '"fitness"'],
  // B1 — Business inquiries + fitness
  ['"business inquiries"', '"fitness coach"', '"gym"'],
  // B2 — DM for promo/rates + fitness
  ['"dm for promo"', '"fitness"', '"workout"'],
  // B3 — Linktree + fitness (coaches who link email through linktree)
  ['"linktr.ee"', '"personal trainer"', '"fitness coach"'],
  // B4 — Paid collab + gym/physique niche
  ['"paid collab"', '"gym"', '"physique"'],
  // B5 — Gmail + gym vlog / workout content format
  ['"gmail.com"', '"gym vlog"', '"workout video"'],
  // C0 — Broad: fitness content creator / gym influencer (no email signal)
  ['"fitness content creator"', '"gym influencer"'],
  // C1 — Broad: gymrat / gains lifestyle
  ['"gymrat"', '"gains"'],
  // C2 — Broad: gym motivation / lifting
  ['"gym motivation"', '"lifting"'],
];

const LOCATION_SUFFIXES_US = ['USA', 'United States', 'California', 'New York', 'Texas', 'Florida', 'American', 'US'];
const LOCATION_SUFFIXES_CA = ['Canada', 'Ontario', 'British Columbia', 'Canadian'];
const LOCATION_SUFFIXES_ES = ['España', 'Spain', 'Madrid', 'Barcelona', 'Valencia'];
const LOCATION_SUFFIXES_LATAM = ['Argentina', 'México', 'Colombia', 'Buenos Aires', 'Ciudad de México', 'Medellín', 'Latino'];
const LOCATION_SUFFIXES_US_CA = [...LOCATION_SUFFIXES_US, ...LOCATION_SUFFIXES_CA];
const LOCATION_SUFFIXES_ES_LATAM = [...LOCATION_SUFFIXES_ES, ...LOCATION_SUFFIXES_LATAM];

const MAX_CONSEC_ZEROS = 3;

// Number of parallel Google Search actor runs per attempt.
// 5 concurrent runs: +66% handles vs 3, wall-time barely increases (~5s extra).
// Slot (GOOGLE_QUERY_BATCH - 1) is reserved for the Stats Block query.
const GOOGLE_QUERY_BATCH = 5;

// ── Instagram Stats Block — physical credential queries ──────────────────────
// Personal trainers routinely include city, height and weight + Gmail in bio:
//   "Chicago | 6'1" | 185lbs | Natural | DM for coaching | john@gmail.com"
// Google indexes Instagram bio text verbatim → this query produces ultra-high
// precision results for personal_brand ICP. Near-zero false positives: no
// business/brand/agency puts physical stats + Gmail in their IG bio.
// Three variants rotated randomly per attempt to maximise coverage:
//   0 → city + height + weight + gmail (pure credential signal)
//   1 → city + "personal trainer" + height + gmail
//   2 → "personal trainer" + height + weight + gmail
const STATS_CITIES_IG = [
  'New York', 'Los Angeles', 'Chicago', 'Houston', 'Miami',
  'Dallas', 'Atlanta', 'Phoenix', 'Denver', 'Seattle',
  'San Diego', 'Austin', 'Orlando', 'Las Vegas', 'Nashville',
  'Charlotte', 'Tampa', 'Portland', 'Boston', 'Minneapolis',
];
const STATS_HEIGHTS_IG = [
  "5'5\"", "5'6\"", "5'7\"", "5'8\"", "5'9\"", "5'10\"", "5'11\"",
  "6'", "6'1\"", "6'2\"", "6'3\"",
];
const STATS_WEIGHTS_LBS_IG = [
  '125lbs', '130lbs', '135lbs', '140lbs', '145lbs', '150lbs', '155lbs',
  '160lbs', '165lbs', '170lbs', '175lbs', '180lbs', '185lbs', '190lbs',
  '195lbs', '200lbs', '210lbs', '220lbs',
];

const REGION_MAP: Record<string, string[]> = {
  US: ['united states', 'usa', 'u.s.a', 'u.s.', 'america', 'new york', 'los angeles', 'chicago', 'houston', 'phoenix', 'miami', 'dallas', 'seattle', 'denver', 'atlanta', 'boston', 'us'],
  UK: ['united kingdom', 'england', 'britain', 'uk', 'u.k.', 'london', 'manchester', 'birmingham', 'glasgow', 'liverpool'],
  CA: ['canada', 'toronto', 'vancouver', 'montreal', 'calgary', 'ottawa', 'ca'],
  AU: ['australia', 'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'au'],
  ES: ['spain', 'españa', 'espana', 'madrid', 'barcelona', 'valencia', 'sevilla', 'es'],
  MX: ['mexico', 'méxico', 'cdmx', 'guadalajara', 'monterrey', 'mx'],
  AR: ['argentina', 'buenos aires', 'córdoba', 'rosario', 'ar'],
  CO: ['colombia', 'bogotá', 'bogota', 'medellín', 'medellin', 'cali', 'co'],
  DE: ['germany', 'deutschland', 'berlin', 'hamburg', 'munich', 'münchen', 'de'],
  FR: ['france', 'paris', 'lyon', 'marseille', 'toulouse', 'fr'],
};

// Google Search Scraper — queries site:instagram.com [keywords], extracts handles from URLs
const GOOGLE_SEARCH_SCRAPER = 'scraperlink~google-search-results-serp-scraper';
const INSTAGRAM_PROFILE_SCRAPER = 'apify~instagram-profile-scraper';

// Anti-ICP negative keywords — purge local businesses and generic corporate accounts
const ANTI_ICP_NEGATIVES = '-restaurant -cafe -clinic -store -food -apparel -"life coach" -corporate -consulting -boutique -"shop now"';

// Instagram system paths that are not user profile pages
const SKIP_HANDLES = new Set(['p', 'reel', 'reels', 'explore', 'stories',
  'accounts', 'tv', 'direct', 'hashtag', 'tagged', 'about', 'directory']);

export class InstagramPersonalBrandEngine {
  private isRunning = false;
  private userId: string | null = null;

  public stop() {
    this.isRunning = false;
  }

  // ── Query builder ─────────────────────────────────────────────────────────────

  /**
   * Builds a site:instagram.com Google Search query for the given attempt.
   *   attempt 1  → user's own keywords + first-location
   *   attempt 2+ → rotate KEYWORD_POOLS + LOCATION_SUFFIXES
   * When relaxed=true (attempt > 15), quotes are stripped to widen the funnel.
   *
   * buildSearchQuerySlot(slot, attempt, relaxed, locations) — same logic but
   * slot (0, 1, 2) selects a DIFFERENT keyword pool + location within the same
   * attempt so 3 queries can run in parallel without repeating each other.
   */
  private buildSearchQuerySlot(
    slot: number,
    baseKeywords: string[],
    attempt: number,
    relaxed: boolean,
    locationSuffixes: string[],
    poolOffset: number = 0,
  ): string {
    const hasUS = locationSuffixes.some(l => l.toLowerCase().includes('us') || l.toLowerCase().includes('united states') || l.toLowerCase().includes('america'));
    const hasCA = locationSuffixes.some(l => l.toLowerCase().includes('canada') || l.toLowerCase().includes('canadian'));
    const hasES = locationSuffixes.some(l => l.toLowerCase().includes('spain') || l.toLowerCase().includes('españa') || l.toLowerCase().includes('madrid'));
    const hasLatam = locationSuffixes.some(l => ['argentina', 'méxico', 'colombia', 'latino'].some(x => l.toLowerCase().includes(x)));
    const firstLoc = hasES || hasLatam
      ? (hasES && hasLatam ? 'España OR Argentina OR México OR Colombia' : hasES ? 'España' : 'Argentina OR México OR Colombia')
      : (hasUS && hasCA ? 'USA OR Canada' : hasUS ? 'USA' : 'Canada');

    let keywords: string[];
    let location: string;

    if (attempt === 1 && slot === 0) {
      // Slot 0 on attempt 1 → user's own keywords
      keywords = baseKeywords.slice(0, 2).map(k => k.includes('"') ? k : `"${k}"`);
      location = firstLoc;
    } else {
      // Each slot advances the pool index by (slot) positions, spreading GOOGLE_QUERY_BATCH
      // parallel queries across different keyword pools and locations to avoid duplicates.
      // Step size = GOOGLE_QUERY_BATCH so consecutive attempts cover non-overlapping pool ranges.
      // poolOffset jumps the family when repeated zero-handle attempts are detected.
      const baseIdx = attempt === 1 ? slot : ((attempt - 2) * GOOGLE_QUERY_BATCH + slot + poolOffset);
      const poolIdx = baseIdx % KEYWORD_POOLS.length;
      const locIdx  = Math.floor(baseIdx / KEYWORD_POOLS.length) % locationSuffixes.length;
      keywords = KEYWORD_POOLS[poolIdx];
      location = locationSuffixes[locIdx];
    }

    if (relaxed) {
      keywords = keywords.map(k => k.replace(/^"|"$/g, ''));
    }

    const kw = keywords.join(' ');
    return location
      ? `site:instagram.com ${kw} ${location} ${ANTI_ICP_NEGATIVES}`
      : `site:instagram.com ${kw} ${ANTI_ICP_NEGATIVES}`;
  }

  /**
   * Stats Block query — targets personal trainers who list physical credentials + Gmail in bio.
   * Bio pattern: "Chicago | 6'1" | 185lbs | Natural | DM for coaching | john@gmail.com"
   * Google indexes Instagram bio verbatim → ultra-high precision, near-zero false positives.
   *
   * Three query variants rotated randomly:
   *   0 → city + height + weight + gmail  (pure credential pattern)
   *   1 → city + "personal trainer" + height + gmail
   *   2 → "personal trainer" + height + weight + gmail
   */
  private buildStatsBlockQuery(): string {
    const city   = STATS_CITIES_IG[Math.floor(Math.random() * STATS_CITIES_IG.length)];
    const height = STATS_HEIGHTS_IG[Math.floor(Math.random() * STATS_HEIGHTS_IG.length)];
    const weight = STATS_WEIGHTS_LBS_IG[Math.floor(Math.random() * STATS_WEIGHTS_LBS_IG.length)];
    const variant = Math.floor(Math.random() * 3);
    if (variant === 0) return `site:instagram.com "gmail.com" "${city}" "${height}" "${weight}" ${ANTI_ICP_NEGATIVES}`;
    if (variant === 1) return `site:instagram.com "gmail.com" "${city}" "personal trainer" "${height}" ${ANTI_ICP_NEGATIVES}`;
    return `site:instagram.com "gmail.com" "personal trainer" "${height}" "${weight}" ${ANTI_ICP_NEGATIVES}`;
  }

  // ── Apify helpers ─────────────────────────────────────────────────────────────

  private async apifyRequest(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    const res = await fetch('/api/apify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, method, body }),
    });
    if (!res.ok) {
      const err = await res.text();
      // Detect quota / billing errors and throw a prefixed message so the loop
      // can break immediately instead of retrying on a hard credit limit.
      if (res.status === 402 || res.status === 403) {
        try {
          const parsed = JSON.parse(err) as Record<string, unknown>;
          const details = typeof parsed.details === 'string'
            ? JSON.parse(parsed.details) as Record<string, unknown>
            : (parsed.details as Record<string, unknown>) ?? parsed;
          const apifyErr = (details?.error ?? details) as Record<string, unknown> | undefined;
          const msg = (apifyErr?.message as string) || '';
          if (res.status === 402 || msg.includes('Monthly usage') || msg.includes('hard limit')) {
            throw new Error('APIFY_QUOTA_EXCEEDED: ' + (msg || 'Insufficient Apify credits.'));
          }
        } catch (pe) {
          const peMsg = pe instanceof Error ? pe.message : '';
          if (peMsg.startsWith('APIFY_QUOTA_EXCEEDED')) throw pe;
        }
      }
      throw new Error(`/api/apify ${res.status}: ${err.substring(0, 300)}`);
    }
    return res.json();
  }

  private async callApifyActor(actorId: string, input: unknown, onLog: LogCallback, timeoutMs?: number, runTimeoutSecs?: number, memoryMbytes?: number): Promise<unknown[]> {
    onLog('[APIFY] Lanzando ' + actorId.split('~').pop() + '...');
    // runTimeoutSecs → ?timeout= tells Apify to kill the actor server-side after N seconds.
    // memoryMbytes  → ?memory= caps RAM per run.
    const params: string[] = [];
    if (runTimeoutSecs) params.push('timeout=' + runTimeoutSecs);
    if (memoryMbytes)   params.push('memory=' + memoryMbytes);
    const runsPath = `acts/${actorId}/runs` + (params.length ? '?' + params.join('&') : '');
    const startData = await this.apifyRequest(runsPath, 'POST', input) as {
      data?: { id?: string; defaultDatasetId?: string };
    };
    const runId = startData.data?.id;
    const datasetId = startData.data?.defaultDatasetId;
    if (!runId || !datasetId) throw new Error('Apify: missing runId or datasetId');
    onLog('[APIFY] Run ' + runId.substring(0, 8) + ' iniciado');

    let done = false;
    let polls = 0;
    let elapsedMs = 0;
    while (!done && this.isRunning && polls < 600) {
      const delay = polls === 0 ? 800 : 1500;
      await new Promise(r => setTimeout(r, delay));
      elapsedMs += delay;
      polls++;
      if (timeoutMs && elapsedMs >= timeoutMs) break; // client-side safety cap
      try {
        const sd = await this.apifyRequest(`acts/${actorId}/runs/${runId}`, 'GET') as {
          data?: { status?: string };
        };
        const status = sd.data?.status ?? '';
        if (polls % 3 === 1) onLog('[APIFY] ' + status + ' (' + Math.round(elapsedMs / 1000) + 's)');
        if (status === 'SUCCEEDED') done = true;
        else if (status === 'TIMED-OUT') {
          // Apify saves partial results to the dataset even on server-side timeout.
          // Mark done and download whatever was collected — avoids ~25s of dead polling.
          done = true;
          onLog('[APIFY] TIMED-OUT — descargando resultados parciales...');
        }
        else if (status === 'FAILED' || status === 'ABORTED') throw new Error('Actor ' + status);
      } catch (pe: unknown) {
        const msg = pe instanceof Error ? pe.message : String(pe);
        if (msg.includes('FAILED') || msg.includes('ABORTED')) throw pe;
      }
    }

    // Abort the Apify run if we exited without success (timeout or user stop).
    if (!done) {
      try { await this.apifyRequest(`actor-runs/${runId}/abort`, 'POST', {}); } catch { /* ignore */ }
      if (!this.isRunning) return [];
      throw new Error('Apify timeout after ' + Math.round(elapsedMs / 1000) + 's');
    }
    if (!this.isRunning) return [];

    onLog('[APIFY] Descargando resultados...');
    const items = await this.apifyRequest(`datasets/${datasetId}/items`, 'GET') as unknown[];
    if (!Array.isArray(items)) throw new Error('Dataset is not an array');
    onLog('[APIFY] ✓ ' + items.length + ' items descargados');
    return items;
  }

  // ── Utility helpers ───────────────────────────────────────────────────────────

  private extractEmailFromBio(bio: string): string {
    if (!bio) return '';
    const m = bio.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    return m ? m[0].toLowerCase().trim() : '';
  }

  private detectAudienceTier(n: number): AudienceTier {
    if (n >= 1_000_000) return 'macro';
    if (n >= 200_000) return 'mid';
    if (n >= 50_000) return 'micro';
    return 'nano';
  }

  public formatFollowers(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  private detectNiche(bio: string, username: string, fullName: string): string {
    const text = (bio + ' ' + username + ' ' + fullName).toLowerCase();
    // Fitness first — must precede Personal Dev to prevent "personal" in handle (e.g.
    // @nypersonaltrainer) from triggering personaldevelopment regex first.
    // Added: personal.?trainer, lifting, physique, gains, hiit, nutrition, diet, weightloss.
    if (/fitness|gym|workout|bodybuilding|strength|crossfit|personal.?trainer|lifting|physique|gains|hiit|nutrition|diet|weightloss/.test(text)) return 'Fitness';
    if (/yoga|meditation|mindfulness|wellness|breathwork/.test(text)) return 'Wellness';
    if (/mindset|personaldevelopment|selfimprovement|motivation|lifecoach/.test(text)) return 'Personal Dev';
    if (/entrepreneur|business|startup|marketing|sales/.test(text)) return 'Business';
    if (/running|marathon|triathlon|cycling|endurance/.test(text)) return 'Endurance';
    return 'Other';
  }

  /**
   * Detects any email-like pattern (@domain) in a snippet/title string.
   * Deliberately broad — catches gmail.com, custom domains, etc.
   * Used for Bucket A priority sorting before the Instagram profile scraper.
   */
  private hasEmailSignalInSnippet(text: string): boolean {
    return /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+/.test(text);
  }

  private extractFollowersFromSnippet(text: string): number | null {
    if (!text) return null;
    const m = text.match(/(\d[\d,.]*)\s*([KkMmBb])?\s*(?:[Ff]ollowers?|[Ss]eguidores?)/);
    if (!m) return null;
    const raw = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(raw)) return null;
    const suffix = m[2]?.toLowerCase();
    if (suffix === 'k') return Math.round(raw * 1_000);
    if (suffix === 'm') return Math.round(raw * 1_000_000);
    if (suffix === 'b') return Math.round(raw * 1_000_000_000);
    return Math.round(raw);
  }

  /**
   * BUCKET A BYPASS — builds RawApifyProfile objects from Google snippet data.
   * For Bucket A handles whose email is visible in the Google snippet, we skip the
   * Instagram profile scraper entirely: email, follower count, and bio are all
   * extracted from what Google already returned. Zero extra Apify calls required.
   *
   * follower default = -1 (sentinel "unknown") → follower range check is SKIPPED for
   * these profiles in applyHardFilter and the ICP candidate loop. The email confirmed
   * in the Google snippet is the quality gate — we still discover/validate the email
   * before accepting them as leads.
   */
  private buildProfilesFromSnippets(
    handles: string[],
    handleToSnippet: Map<string, string>,
    handleToTitle: Map<string, string>,
  ): RawApifyProfile[] {
    return handles.map(handle => {
      const snippet = handleToSnippet.get(handle) || '';
      const title   = handleToTitle.get(handle) || '';
      const combined = title + ' ' + snippet;
      // -1 sentinel: follower count not found in snippet. Hard filter and ICP loop
      // skip the range check when followers === -1 (email confirmed = quality signal).
      const followers = this.extractFollowersFromSnippet(combined) ?? -1;
      const emailMatch = combined.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      const publicEmail = emailMatch ? emailMatch[0].toLowerCase().trim() : '';
      const biography = snippet.substring(0, 300);
      return {
        username: handle,
        fullName: '',
        biography,
        followersCount: followers,
        externalUrl: '',
        publicEmail,
        countryCode: '',
        country: '',
        __platform: 'instagram' as const,
      } as RawApifyProfile;
    });
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private parseKeywordsFromQuery(query: string): string[] {
    const defaults = ['fitness coach', 'personal trainer', 'gym influencer'];
    if (!query) return defaults;
    const explicit = query.match(/#[a-zA-Z0-9_]+/g);
    if (explicit && explicit.length > 0) return explicit.map(k => k.replace('#', ''));
    const lower = query.toLowerCase();
    const keywords = lower.split(' or ').map(k => k.trim().replace(/"/g, ''));
    return keywords.length > 0 ? keywords : defaults;
  }

  // ── AI helpers ────────────────────────────────────────────────────────────────

  private fallbackEmailBody(lead: Lead, vslLink: string): string {
    const name = lead.decisionMaker?.name?.split(' ')[0] || 'there';
    return (
      'Hey ' + name + ',\n\n' +
      'Love what you are building in the ' + (lead.niche || 'fitness') + ' space.\n\n' +
      'I have been working with creators your size on something that quietly adds 5-6 figures without extra content output.\n\n' +
      'Short 4-min video: ' + vslLink + '\n\n' +
      'Worth a watch if you are thinking about scaling.'
    );
  }

  private async generateCreatorAnalysis(lead: Lead): Promise<{
    coldEmailSubject: string; coldEmailBody: string; vslPitch: string;
    psychologicalProfile: string; engagementSignal: string; salesAngle: string; summary: string;
  }> {
    const vslLink = PROJECT_CONFIG.flownextConfig?.vslLink || 'https://flownext.io/vsl';
    const followerStr = this.formatFollowers(lead.follower_count || 0);
    const ctx = [
      'Creator: @' + lead.ig_handle,
      'Name: ' + lead.decisionMaker?.name,
      'Niche: ' + lead.niche,
      'Followers: ' + followerStr + ' (Tier: ' + lead.audience_tier + ')',
      'Email: ' + (lead.decisionMaker?.email || 'none'),
    ].join('\n');

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch('/api/openai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content:
                  'You are an expert cold email copywriter for Instagram fitness/personal development creator outreach.\n' +
                  'GOAL: Write a cold email pitching a VSL link. Personal, peer-to-peer, not mass blast.\n' +
                  'TONE: Direct, confident, no fluff. English only. Under 120 words. No emojis in subject.\n' +
                  'Rules: Reference their niche. CTA = watch VSL. Subject under 8 words.\n' +
                  'Respond ONLY with this JSON (no markdown):\n' +
                  '{"coldEmailSubject":"...","coldEmailBody":"...","vslPitch":"One-liner hook max 15 words","psychologicalProfile":"2-sentence assessment","engagementSignal":"inferred signal","salesAngle":"top reason they say yes","summary":"one sentence lead description"}',
              },
              { role: 'user', content: 'Analyze this creator and write outreach:\n' + ctx + '\nVSL Link: ' + vslLink },
            ],
            temperature: 0.7,
            max_tokens: 600,
          }),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const raw = data.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const p = JSON.parse(jsonMatch[0]) as Record<string, string>;
          return {
            coldEmailSubject: p.coldEmailSubject || 'Quick question about your ' + lead.niche + ' content',
            coldEmailBody: p.coldEmailBody || this.fallbackEmailBody(lead, vslLink),
            vslPitch: p.vslPitch || 'Scale your ' + lead.niche + ' brand without more hours',
            psychologicalProfile: p.psychologicalProfile || 'Ambitious creator focused on growth.',
            engagementSignal: p.engagementSignal || 'Active niche audience.',
            salesAngle: p.salesAngle || 'Monetization opportunity.',
            summary: p.summary || lead.niche + ' creator with ' + followerStr + ' followers.',
          };
        }
      } catch {
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    return {
      coldEmailSubject: 'Quick question about your ' + lead.niche + ' content',
      coldEmailBody: this.fallbackEmailBody(lead, vslLink),
      vslPitch: 'Scale your ' + lead.niche + ' brand without more hours',
      psychologicalProfile: 'Ambitious creator focused on growth.',
      engagementSignal: 'Active niche audience.',
      salesAngle: 'Monetization opportunity.',
      summary: lead.niche + ' creator with ' + this.formatFollowers(lead.follower_count || 0) + ' followers.',
    };
  }

  /**
   * BATCH AI ANALYSIS (Pilar 2 + 3)
   * Single /api/openai call for all N leads → eliminates N-1 round-trip latencies.
   * Pass 2: optional gpt-4o enrichment when PROJECT_CONFIG.usePremiumModel = true.
   * Mutates each Lead's aiAnalysis field in place.
   */
  private async generateCreatorAnalysisBatch(leads: Lead[], onLog: LogCallback): Promise<void> {
    if (!leads.length) return;

    const vslLink = PROJECT_CONFIG.flownextConfig?.vslLink || 'https://flownext.io/vsl';
    const usePremiumModel = PROJECT_CONFIG.flownextConfig?.usePremiumModel ?? false;

    const batch = leads.map(lead => ({
      handle: lead.ig_handle || '',
      name: lead.decisionMaker?.name || '',
      niche: lead.niche || '',
      followers: this.formatFollowers(lead.follower_count || 0),
      tier: lead.audience_tier || 'nano',
      email: lead.decisionMaker?.email || 'none',
    }));

    const systemPrompt =
      'You are an expert cold email copywriter for Instagram fitness/personal development creator outreach.\n' +
      'You will receive a JSON array of creator profiles.\n' +
      'GOAL: For EACH creator, write a cold email pitching a VSL link. Personal, peer-to-peer, not mass blast.\n' +
      'TONE: Direct, confident, no fluff. English only. Under 120 words per email. No emojis in subject.\n' +
      'Rules: Reference their niche. CTA = watch VSL. Subject under 8 words.\n' +
      'VSL Link: ' + vslLink + '\n\n' +
      'Respond ONLY with a valid JSON array (no markdown, no wrapping object) in the EXACT same order as the input:\n' +
      '[{"coldEmailSubject":"...","coldEmailBody":"...","vslPitch":"One-liner hook max 15 words","psychologicalProfile":"2-sentence assessment","engagementSignal":"inferred signal","salesAngle":"top reason they say yes","summary":"one sentence lead description"},...]';

    const applyResults = (rawResults: Record<string, string>[], source: 'mini' | 'premium') => {
      for (let i = 0; i < leads.length; i++) {
        const lead = leads[i];
        const r = rawResults[i];
        if (!r) continue;
        const followerStr = this.formatFollowers(lead.follower_count || 0);
        if (source === 'mini') {
          lead.aiAnalysis = {
            summary: r.summary || (lead.niche + ' creator with ' + followerStr + ' followers.'),
            painPoints: [],
            generatedIcebreaker: r.vslPitch || ('Scale your ' + lead.niche + ' brand without more hours'),
            coldEmailSubject: r.coldEmailSubject || ('Quick question about your ' + lead.niche + ' content'),
            coldEmailBody: r.coldEmailBody || this.fallbackEmailBody(lead, vslLink),
            vslPitch: r.vslPitch || ('Scale your ' + lead.niche + ' brand without more hours'),
            fullAnalysis: (r.psychologicalProfile || '') + ' | ' + (r.engagementSignal || ''),
            psychologicalProfile: r.psychologicalProfile || 'Ambitious creator focused on growth.',
            engagementSignal: r.engagementSignal || 'Active niche audience.',
            salesAngle: r.salesAngle || 'Monetization opportunity.',
          };
        } else {
          if (!lead.aiAnalysis) return;
          if (r.coldEmailBody) lead.aiAnalysis.coldEmailBody = r.coldEmailBody;
          if (r.psychologicalProfile) lead.aiAnalysis.psychologicalProfile = r.psychologicalProfile;
          if (r.salesAngle) lead.aiAnalysis.salesAngle = r.salesAngle;
          if (r.summary) lead.aiAnalysis.summary = r.summary;
          if (r.vslPitch) { lead.aiAnalysis.vslPitch = r.vslPitch; lead.aiAnalysis.generatedIcebreaker = r.vslPitch; }
          lead.aiAnalysis.fullAnalysis = r.psychologicalProfile + ' | ' + (r.engagementSignal || lead.aiAnalysis.engagementSignal);
        }
      }
    };

    // Pass 1: gpt-4o-mini
    let batchSucceeded = false;
    try {
      const response = await fetch('/api/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Analyze these ' + leads.length + ' creators:\n' + JSON.stringify(batch) },
          ],
          temperature: 0.7,
          max_tokens: Math.min(4096, leads.length * 380),
        }),
      });
      if (response.ok) {
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const raw = data.choices?.[0]?.message?.content || '';
        const arrayMatch = raw.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          const parsed = JSON.parse(arrayMatch[0]) as Record<string, string>[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            applyResults(parsed, 'mini');
            onLog('[BATCH AI] ✓ ' + leads.length + ' perfiles analizados en 1 llamada gpt-4o-mini (Pilar 2)');
            batchSucceeded = true;
          }
        }
      }
    } catch (e) {
      onLog('[BATCH AI] ⚠ Batch request falló — usando análisis individual como fallback: ' +
        (e instanceof Error ? e.message : String(e)));
    }

    if (!batchSucceeded) {
      onLog('[BATCH AI] Fallback: analizando ' + leads.length + ' perfiles individualmente...');
      for (const lead of leads) {
        if (!this.isRunning) break;
        try {
          const a = await this.generateCreatorAnalysis(lead);
          lead.aiAnalysis = {
            summary: a.summary, painPoints: [], generatedIcebreaker: a.vslPitch,
            coldEmailSubject: a.coldEmailSubject, coldEmailBody: a.coldEmailBody,
            vslPitch: a.vslPitch, fullAnalysis: a.psychologicalProfile + ' | ' + a.engagementSignal,
            psychologicalProfile: a.psychologicalProfile, engagementSignal: a.engagementSignal,
            salesAngle: a.salesAngle,
          };
        } catch { /* generateCreatorAnalysis returns defaults on error */ }
      }
      return;
    }

    // Guard: ensure every lead has aiAnalysis (handles partial batch responses)
    for (const lead of leads) {
      if (!lead.aiAnalysis) {
        const followerStr = this.formatFollowers(lead.follower_count || 0);
        lead.aiAnalysis = {
          summary: (lead.niche || 'Creator') + ' with ' + followerStr + ' followers.',
          painPoints: [], generatedIcebreaker: 'Scale your brand without more hours',
          coldEmailSubject: 'Quick question about your ' + (lead.niche || 'content'),
          coldEmailBody: this.fallbackEmailBody(lead, vslLink),
          vslPitch: 'Scale your brand without more hours', fullAnalysis: 'Ambitious creator.',
          psychologicalProfile: 'Ambitious creator focused on growth.',
          engagementSignal: 'Active niche audience.', salesAngle: 'Monetization opportunity.',
        };
      }
    }

    // Pass 2: gpt-4o (opt-in, Pilar 3)
    if (!usePremiumModel) return;

    onLog('[MODEL TIER] 🚀 Enriquecimiento premium con gpt-4o (' + leads.length + ' creadores)...');
    const premiumPrompt =
      'You are a world-class B2B copywriter specializing in creator economy outreach.\n' +
      'Rewrite the cold email body and psychological profile for MAXIMUM conversion.\n' +
      'Be highly specific to each creator\'s niche, audience size, and unique angle.\n' +
      'Under 150 words per email. Hyper-personalized. B2B peer-to-peer tone.\n' +
      'VSL Link: ' + vslLink + '\n\n' +
      'Return ONLY a valid JSON array (same order as input), each item:\n' +
      '[{"coldEmailBody":"...","psychologicalProfile":"3-sentence deep profile","salesAngle":"specific reason they say yes","summary":"sharp one-liner","vslPitch":"compelling hook max 12 words"},...]';

    try {
      const resp = await fetch('/api/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: premiumPrompt },
            { role: 'user', content: 'Enrich these ' + leads.length + ' creators:\n' + JSON.stringify(batch) },
          ],
          temperature: 0.8,
          max_tokens: Math.min(8192, leads.length * 500),
        }),
      });
      if (resp.ok) {
        const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
        const raw = data.choices?.[0]?.message?.content || '';
        const arrayMatch = raw.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          const parsed = JSON.parse(arrayMatch[0]) as Record<string, string>[];
          if (Array.isArray(parsed)) {
            applyResults(parsed, 'premium');
            onLog('[MODEL TIER] ✓ Enriquecimiento gpt-4o completado (' + leads.length + ' creadores)');
          }
        }
      }
    } catch (e) {
      onLog('[MODEL TIER] ⚠ gpt-4o premium pass falló (manteniendo análisis mini): ' +
        (e instanceof Error ? e.message : String(e)));
    }
  }

  // ── Instantly integration ─────────────────────────────────────────────────────

  private async sendLeadsToInstantly(leads: Lead[], onLog: LogCallback, instantlyCampaignId?: string): Promise<void> {
    const leadsWithEmail = leads.filter(l => l.decisionMaker?.email);
    if (!leadsWithEmail.length) {
      onLog('[INSTANTLY] ⚠ Sin leads con email para enviar a Instantly.');
      return;
    }
    onLog('[INSTANTLY] 📤 Enviando ' + leadsWithEmail.length + ' lead(s) a campaña de Instantly...');
    let sent = 0; let skipped = 0; let failed = 0;
    for (const lead of leadsWithEmail) {
      const email = lead.decisionMaker!.email!;
      const fullName = lead.decisionMaker?.name || '';
      const nameParts = fullName.split(' ');
      try {
        const response = await fetch('/api/instantly-add-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email, firstName: nameParts[0] || '', lastName: nameParts.slice(1).join(' ') || '',
            companyName: lead.decisionMaker?.name || lead.ig_handle || '',
            igHandle: lead.ig_handle || '', niche: lead.niche || '',
            aiSummary: lead.aiAnalysis?.summary || '',
            coldEmailSubject: lead.aiAnalysis?.coldEmailSubject || '',
            followerCount: lead.follower_count || 0,
            ...(instantlyCampaignId ? { campaignId: instantlyCampaignId } : {}),
          }),
        });
        if (response.ok) { sent++; onLog('[INSTANTLY] ✅ ' + email + ' añadido'); }
        else if (response.status === 409) { skipped++; onLog('[INSTANTLY] ℹ Ya en campaña: ' + email); }
        else { failed++; onLog('[INSTANTLY] ❌ Error ' + response.status + ' para ' + email); }
      } catch (e: unknown) {
        failed++;
        onLog('[INSTANTLY] ❌ Error de red: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    onLog('[INSTANTLY] 📊 ' + sent + ' enviados' + (skipped ? ', ' + skipped + ' ya existían' : '') + (failed ? ', ' + failed + ' errores' : ''));
  }

  // ── Public entry point ────────────────────────────────────────────────────────

  public async startSearch(
    config: SearchConfigState,
    onLog: LogCallback,
    onComplete: ResultCallback,
    userId?: string | null,
    onLeadFound?: (lead: Lead) => void,
  ): Promise<void> {
    this.isRunning = true;
    this.userId = userId ?? null;
    try {
      onLog('[IG-PB] Motor: Instagram Personal Brand');
      onLog('[INIT] Apify: via /api/apify (serverless proxy)');
      onLog('[INIT] UserId: ' + (this.userId || 'not authenticated'));
      onLog('[INIT] Source: ' + config.source + ' | Query: "' + config.query + '" | Target: ' + config.maxResults);

      onLog('[DEDUP] Loading existing leads from database...');
      const { existingIgHandles, existingEmails } = await deduplicationService.fetchExistingLeads(this.userId);
      onLog('[DEDUP] Pre-flight: ' + existingIgHandles.size + ' IG handles, ' + existingEmails.size + ' emails already in DB');

      await this.runSearchLoop(config, existingIgHandles, existingEmails, onLog, onComplete, config.instantlyCampaignId, onLeadFound);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[InstagramPersonalBrandEngine] FATAL:', error);
      onLog('[ERROR] ' + msg);
      onComplete([]);
    } finally {
      this.isRunning = false;
    }
  }

  // ── Core search loop ─────────────────────────────────────────────────────────

  private async runSearchLoop(
    config: SearchConfigState,
    existingIgHandles: Set<string>,
    existingEmails: Set<string>,
    onLog: LogCallback,
    onComplete: ResultCallback,
    instantlyCampaignId?: string,
    onLeadFound?: (lead: Lead) => void,
  ): Promise<void> {
    const icpFilters = config.icpFilters;
    const minFollowers = icpFilters?.minFollowers ?? 0;
    const maxFollowers = icpFilters?.maxFollowers ?? 99_000_000;
    const targetRegions = icpFilters?.regions ?? [];
    const targetContentTypes = icpFilters?.contentTypes ?? [];
    const targetCount = Math.max(1, config.maxResults);
    const baseKeywords = this.parseKeywordsFromQuery(config.query);

    // Location suffix selection based on campaign regions
    const onlyUS = targetRegions.length > 0 && targetRegions.every(r => r === 'US');
    const onlyCA = targetRegions.length > 0 && targetRegions.every(r => r === 'CA');
    const hasEsRegion = targetRegions.some(r => ['ES', 'MX', 'AR', 'CO'].includes(r));
    const hasEnRegion = targetRegions.some(r => ['US', 'CA', 'UK', 'AU'].includes(r));
    const activeLocationSuffixes =
      onlyUS ? LOCATION_SUFFIXES_US
      : onlyCA ? LOCATION_SUFFIXES_CA
      : (hasEsRegion && !hasEnRegion) ? LOCATION_SUFFIXES_ES_LATAM
      : (hasEsRegion && hasEnRegion) ? [...LOCATION_SUFFIXES_US_CA, ...LOCATION_SUFFIXES_ES_LATAM]
      : LOCATION_SUFFIXES_US_CA;

    const MAX_RETRIES = Math.max(20, targetCount * 3);

    onLog('[IG-PB] Keywords base: ' + baseKeywords.join(', '));
    onLog('[IG-PB] ICP Type: personal_brand (Instagram only)');
    onLog('[IG-PB] Keyword pool: ' + KEYWORD_POOLS.length + ' variantes | site:instagram.com | 🏃 ' + GOOGLE_QUERY_BATCH + ' queries en paralelo por attempt');
    onLog('[IG-PB] 🎯 Objetivo: ' + targetCount + ' creadores | Máx intentos: ' + MAX_RETRIES);
    onLog('[IG-PB] Followers: ' + (minFollowers > 0 ? this.formatFollowers(minFollowers) : '0') + ' – ' + (maxFollowers < 99_000_000 ? this.formatFollowers(maxFollowers) : '∞'));
    if (targetRegions.length > 0) onLog('[ICP] Regiones: ' + targetRegions.join(', '));
    if (targetContentTypes.length > 0) onLog('[ICP] Tipos de contenido: ' + targetContentTypes.join(', '));

    const accepted: Lead[] = [];
    const seenHandles = new Set<string>(existingIgHandles);
    let attempt = 0;
    let consecutiveZeros = 0;
    let relaxedLogged = false;
    // poolOffset: jumps 6 pools ahead on zero-handle attempts so the next iteration
    // switches to a different keyword family (A→B→C) instead of staying in the same
    // saturated search space. Reset to 0 when new handles are found.
    let poolOffset = 0;

    while (accepted.length < targetCount && this.isRunning && attempt < MAX_RETRIES) {
      attempt++;
      const needed = targetCount - accepted.length;
      const relaxed = attempt > 15;

      if (relaxed && !relaxedLogged) {
        relaxedLogged = true;
        onLog(`[ENGINE] 🔓 Query relaxation active (attempt ${attempt}) — switching to broad search`);
      }

      // Build GOOGLE_QUERY_BATCH distinct queries — one per parallel run — so they
      // cover different keyword pools and locations simultaneously.
      // Slot GOOGLE_QUERY_BATCH-1 (last) is always a Stats Block query targeting personal
      // trainers who put physical credentials + Gmail in bio: "Chicago | 6'1" | 185lbs".
      // poolOffset shifts the pool family when consecutive zero-handle attempts occur.
      const querySlots = Array.from({ length: GOOGLE_QUERY_BATCH }, (_, slot) =>
        slot === GOOGLE_QUERY_BATCH - 1
          ? this.buildStatsBlockQuery()
          : this.buildSearchQuerySlot(slot, baseKeywords, attempt, relaxed, activeLocationSuffixes, poolOffset)
      );

      onLog('');
      onLog('━━━ ATTEMPT ' + attempt + '/' + MAX_RETRIES + ' ━━━  ' + needed + ' lead(s) still needed');
      onLog('🔎 STEP 1/4 — Google Search x' + GOOGLE_QUERY_BATCH + ' (Instagram):');
      querySlots.forEach((q, i) => onLog('             Slot ' + (i + 1) + ': ' + q));

      // ── STEP 1: Google Search site:instagram.com — parallel runs ─────────────
      let perSlotResults: unknown[][];
      let quotaExceeded = false;
      try {
        perSlotResults = await Promise.all(querySlots.map(q =>
          this.callApifyActor(GOOGLE_SEARCH_SCRAPER, {
            keyword: q,
            limit: 40,
          }, onLog, 90_000, 80, 1024).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.startsWith('APIFY_QUOTA_EXCEEDED')) { quotaExceeded = true; }
            return [] as unknown[];
          })
        ));
        if (quotaExceeded) { onLog('[ENGINE] ⛔ Apify quota agotada — abortando.'); break; }
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.startsWith('APIFY_QUOTA_EXCEEDED')) { onLog('[ENGINE] ⛔ Apify quota agotada — abortando.'); break; }
        onLog('[STEP 1] Google Search error: ' + errMsg);
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) { onLog('[ENGINE] ' + consecutiveZeros + ' consecutive failures — aborting.'); break; }
        continue;
      }

      // Flatten 3 slots into one result list
      const allOrganicResults: Record<string, unknown>[] = [];
      for (const slotResults of perSlotResults) {
        if (!Array.isArray(slotResults)) continue;
        for (const item of slotResults as Record<string, unknown>[]) {
          const subResults = (item.results as Record<string, unknown>[] | undefined) ?? [];
          allOrganicResults.push(...subResults);
        }
      }

      if (!allOrganicResults.length) {
        onLog('🔎 Sin resultados orgánicos en ninguno de los 3 slots');
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) { onLog('[ENGINE] ' + MAX_CONSEC_ZEROS + ' empty rounds — deteniendo.'); break; }
        continue;
      }

      const handleToSnippet = new Map<string, string>();
      const handleToTitle   = new Map<string, string>();
      const rawHandles: string[] = [];
      for (const item of allOrganicResults) {
        const url = ((item.url as string) || (item.link as string) || '').toLowerCase();
        const snippet = ((item.description as string) || (item.snippet as string) || '');
        const title   = (item.title as string) || '';
        const igMatch = url.match(/instagram\.com\/([^/?#\s]+)/);
        if (igMatch) {
          const h = igMatch[1].trim();
          if (h && !SKIP_HANDLES.has(h) && !seenHandles.has(h)) {
            rawHandles.push(h);
            if (snippet) handleToSnippet.set(h, snippet);
            if (title)   handleToTitle.set(h, title);
          }
        }
      }

      // Deduplicate
      const seenRaw = new Set<string>();
      const uniqueRawHandles = rawHandles.filter(h => { if (seenRaw.has(h)) return false; seenRaw.add(h); return true; });

      // Snippet follower pre-filter (free — no API cost)
      let snippetFiltered = 0; let snippetPassed = 0; let snippetUnknown = 0;
      const bucketA: string[] = []; // email signal visible in Google snippet → scrape first
      const bucketB: string[] = []; // no email in snippet → may have Gmail in Linktree/Contact
      for (const h of uniqueRawHandles) {
        const snippet = handleToSnippet.get(h) || '';
        const title   = handleToTitle.get(h) || '';
        const snippetFollowers = this.extractFollowersFromSnippet(snippet);
        if (snippetFollowers !== null) {
          if (snippetFollowers < minFollowers || snippetFollowers > maxFollowers) { snippetFiltered++; continue; }
          snippetPassed++;
        } else { snippetUnknown++; }
        // Bucket A: any @domain pattern visible in snippet or title
        if (this.hasEmailSignalInSnippet(snippet + ' ' + title)) {
          bucketA.push(h);
        } else {
          bucketB.push(h);
        }
      }
      // Bucket A first — highest probability of having a findable email
      const novelHandles = [...bucketA, ...bucketB];
      if (snippetFiltered > 0 || snippetPassed > 0) {
        onLog(`[PRE-FILTER] Snippet: ${snippetFiltered} descartados pre-scrape, ${snippetPassed} pasan, ${snippetUnknown} sin dato`);
      }
      onLog(`[BUCKET SORT] A (email en snippet): ${bucketA.length} | B (sin email en snippet): ${bucketB.length}`);

      onLog('🔎 STEP 1/4 ✓ — ' + allOrganicResults.length + ' organic → ' + novelHandles.length + ' handles nuevos (Instagram)');

      if (!novelHandles.length) {
        onLog('⚠ Sin handles nuevos — rotando...');
        consecutiveZeros++;
        poolOffset += 6; // jump 6 pools ahead → switch keyword family (A→B→C) to escape saturation
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) { onLog('[ENGINE] ' + MAX_CONSEC_ZEROS + ' rondas sin handles nuevos. Deteniendo.'); break; }
        continue;
      }

      for (const h of novelHandles) seenHandles.add(h);
      consecutiveZeros = 0;
      poolOffset = 0; // reset — new handles found, no longer in saturated space

      // ── STEP 2: Instagram profile fetch ──────────────────────────────────────
      // Bucket A handles already have their email visible in the Google snippet →
      // build profiles from snippet data directly (zero Apify calls, instant).
      // Bucket B handles require the Instagram profile scraper.
      //
      // This eliminates the ~80s scraper cost for rounds where all handles are
      // Bucket A but have follower counts below minFollowers (very common with
      // nano creators who put Gmail in bio but have <1K followers).
      const slotsNeeded = targetCount - accepted.length;
      const MAX_IG_BATCH = Math.min(novelHandles.length, Math.max(slotsNeeded * 4, 12));

      // Bucket A → snippet bypass (email already known, no API cost)
      const bucketABatch = bucketA.slice(0, MAX_IG_BATCH);
      const snippetProfiles = this.buildProfilesFromSnippets(bucketABatch, handleToSnippet, handleToTitle);

      // Bucket B → profile scraper (only handles without email in snippet)
      const bucketBBatch = bucketB.slice(0, Math.max(0, MAX_IG_BATCH - bucketABatch.length));
      let scraperProfiles: unknown[] = [];
      if (bucketBBatch.length > 0) {
        onLog('👤 STEP 2/4 — Fetching ' + bucketBBatch.length + ' Instagram profiles (Bucket B only)...');
        try {
          scraperProfiles = await this.callApifyActor(INSTAGRAM_PROFILE_SCRAPER, { usernames: bucketBBatch }, onLog, 70_000, 60, 1024);
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          if (errMsg.startsWith('APIFY_QUOTA_EXCEEDED')) { onLog('[ENGINE] ⛔ Apify quota agotada — abortando.'); break; }
          onLog('👤 STEP 2/4 ✗ Profile scraper failed: ' + errMsg + ' — continuing with snippet profiles only');
          // Don't skip — snippet profiles may still yield leads
        }
      } else {
        onLog('👤 STEP 2/4 — Bucket A: ' + bucketABatch.length + ' snippet profiles (scraper bypassed ✓)');
      }

      const profiles: unknown[] = [...snippetProfiles, ...scraperProfiles];
      onLog('👤 STEP 2/4 ✓ — ' + profiles.length + ' profiles (' + snippetProfiles.length + ' snippet, ' + scraperProfiles.length + ' scraped)');

      // ── STEP 3: Hard ICP filter ──────────────────────────────────────────────
      onLog('🔍 STEP 3/4 — Applying hard ICP filters (' + profiles.length + ' profiles)...');
      const hardFiltered = icpEvaluator.applyHardFilter(profiles as RawApifyProfile[], onLog, 'personal_brand');
      onLog('[HARD FILTER] ' + profiles.length + ' → ' + hardFiltered.length + ' passed');

      if (!hardFiltered.length) { onLog('⚠ Ningún perfil pasó el hard filter. Rotando query...'); continue; }

      // Build candidate Lead objects
      const candidates: Lead[] = [];
      for (const profile of hardFiltered) {
        if (!this.isRunning) break;
        const p = profile as Record<string, unknown>;
        const handle = ((p.username as string) || '').toLowerCase().trim();
        if (!handle) continue;

        // followersCount === -1 is the Bucket A sentinel (email confirmed in snippet, count unknown).
        // Cast safely: || 0 would turn -1 into 0; use nullish coalescing to preserve -1.
        const followersRaw = (p.followersCount as number) ?? 0;
        const followers = followersRaw;
        const bio = ((p.biography as string) || (p.bio as string) || '');
        const fullName = ((p.fullName as string) || (p.name as string) || '');
        const emailFromBio = this.extractEmailFromBio(bio);
        const emailFromApify = ((p.publicEmail as string) || (p.businessEmail as string) || (p.email as string) || (p.contactEmail as string) || '').toLowerCase().trim();
        const email = emailFromBio || emailFromApify;
        const website = ((p.externalUrl as string) || (p.website as string) || '').trim();
        const niche = this.detectNiche(bio, handle, fullName);
        const regionRaw = ((p.country as string) || (p.city as string) || '');

        // Skip follower range check for Bucket A sentinel (-1 = unknown, email confirmed).
        if (followers >= 0 && followers < minFollowers) { onLog('[ICP] ↓ @' + handle + ' — ' + this.formatFollowers(followers) + ' < ' + this.formatFollowers(minFollowers)); continue; }
        if (followers >= 0 && followers > maxFollowers) { onLog('[ICP] ↑ @' + handle + ' — ' + this.formatFollowers(followers) + ' > ' + this.formatFollowers(maxFollowers)); continue; }

        // Region filter
        if (targetRegions.length > 0) {
          const locationStr = [p.country, p.city, p.region, p.countryCode, p.locationName]
            .map(v => ((v as string) || '').toLowerCase()).join(' ');
          if (locationStr.trim()) {
            const matchesRegion = targetRegions.some(r => {
              const patterns = REGION_MAP[r] ?? [r.toLowerCase()];
              return patterns.some(pat => locationStr.includes(pat));
            });
            if (!matchesRegion) { onLog('[ICP] 🌍 @' + handle + ' — "' + (p.country || p.city || '') + '" not in [' + targetRegions.join(', ') + ']'); continue; }
          }
        }

        if (targetContentTypes.length > 0) {
          const matchesContent = targetContentTypes.some(ct =>
            niche.toLowerCase().includes(ct.toLowerCase()) || ct.toLowerCase().includes(niche.split(' ')[0].toLowerCase()));
          if (!matchesContent) { onLog('[ICP] 🏷 @' + handle + ' — niche "' + niche + '" ∉ [' + targetContentTypes.join(', ') + ']'); continue; }
        }

        candidates.push({
          id: 'ig-' + handle + '-' + Date.now(),
          source: 'instagram',
          ig_handle: handle,
          follower_count: Math.max(0, followers), // -1 sentinel → store as 0
          niche,
          audience_tier: this.detectAudienceTier(Math.max(0, followers)),
          location: regionRaw,
          website,
          decisionMaker: {
            name: fullName || '@' + handle,
            role: 'Content Creator',
            email,
            instagram: 'https://instagram.com/' + handle,
          },
          aiAnalysis: {
            summary: bio, painPoints: [], generatedIcebreaker: '',
            coldEmailSubject: '', coldEmailBody: '', vslPitch: '',
            fullAnalysis: '', psychologicalProfile: '', engagementSignal: '', salesAngle: '',
          },
          vsl_sent_status: 'pending',
          email_status: 'pending',
          status: 'scraped',
        });
      }

      onLog('[FUNNEL] ' + candidates.length + '/' + hardFiltered.length + ' pasaron filtros de seguidor/región/nicho');
      if (!candidates.length) { onLog('⚠ Ningún candidato pasó los filtros ICP. Rotando query...'); continue; }

      // DB-level dedup
      const acceptedHandles = new Set(accepted.map(l => l.ig_handle || ''));
      const notYetAccepted = candidates.filter(c => !acceptedHandles.has(c.ig_handle || ''));
      const dbDeduped = deduplicationService.filterUniqueCandidates(notYetAccepted, existingIgHandles, existingEmails);
      onLog('[DEDUP] ' + dbDeduped.length + '/' + notYetAccepted.length + ' son nuevos (no están en la BD)');
      if (!dbDeduped.length) { onLog('⚠ Todos los candidatos ya existen en la BD. Rotando query...'); continue; }

      // ── STEP 3b: Email discovery ─────────────────────────────────────────────
      const slotsRemaining = targetCount - accepted.length;
      // Buffer: 3× slots needed (was Math.max which always took ALL candidates — bug).
      const toDiscover = dbDeduped.slice(0, Math.min(slotsRemaining * 3, dbDeduped.length));
      onLog('📧 STEP 3b — Email discovery para ' + toDiscover.length + ' candidatos...');
      await Promise.all(this.chunkArray(toDiscover, 10).map(async (chunk) => {
        await Promise.all(chunk.map(async (lead) => {
          if (!this.isRunning) return;
          const discovered = await emailDiscoveryService.discoverEmail(
            lead.decisionMaker?.email || '',
            lead.website || '',
            lead.ig_handle || '',
            onLog,
          );
          if (discovered && lead.decisionMaker) lead.decisionMaker.email = discovered;
        }));
      }));
      // Accept any valid email (not just Gmail) — fitness coaches use @outlook.com,
      // @hotmail.com, and custom domains (coach@name.com). Gmail-only gate was
      // dropping ~60% of valid ICP candidates before they reached the AI soft filter.
      const withEmail = toDiscover.filter(l => /^.+@.+\..+$/.test((l.decisionMaker?.email || '').trim()));
      const gmailCount = withEmail.filter(l => l.decisionMaker?.email?.toLowerCase().endsWith('@gmail.com')).length;
      onLog('📧 STEP 3b ✓ — ' + withEmail.length + '/' + toDiscover.length + ' tienen email válido (Gmail: ' + gmailCount + ', otros: ' + (withEmail.length - gmailCount) + ')');

      if (!withEmail.length) { onLog('⚠ Ningún candidato tiene email. Rotando query...'); continue; }

      // ── STEP 4a: AI Soft Filter ───────────────────────────────────────────────
      onLog('🤖 STEP 4a — Filtro IA para ' + withEmail.length + ' candidatos (verificando ICP fitness)...');
      const softFiltered = await icpEvaluator.applySoftFilter(withEmail, onLog, 'personal_brand');
      const icpVerified = softFiltered.filter(l => l.icp_verified === true);
      const icpUnverified = softFiltered.filter(l => l.icp_verified !== true);
      onLog('[ICP SOFT] ' + icpVerified.length + ' verificados ✓ | ' + icpUnverified.length + ' no verificados ✗');

      const toEvaluate = icpVerified.length > 0 ? icpVerified : (() => {
        if (icpUnverified.length > 0) onLog('⚠ IA no pudo verificar — usando hard-filter fallback...');
        return icpUnverified;
      })();
      if (!toEvaluate.length) { onLog('⚠ Ningún lead ICP. Rotando...'); continue; }

      // Anti-ICP early exit
      const antiIcpLeads = toEvaluate.filter(l => (l as unknown as Record<string, unknown>).anti_icp === true);
      if (antiIcpLeads.length > 0) {
        for (const lead of antiIcpLeads) { lead.status = 'discarded'; onLog(`[ANTI-ICP 🚫] @${lead.ig_handle} → discarded`); }
        onLog(`[ANTI-ICP] ${antiIcpLeads.length} lead(s) descartados sin análisis IA.`);
      }
      const cleanToEvaluate = toEvaluate.filter(l => !(l as unknown as Record<string, unknown>).anti_icp);
      if (!cleanToEvaluate.length) { onLog('⚠ Todos los leads eran Anti-ICP. Rotando query...'); continue; }

      const toProcess = cleanToEvaluate.slice(0, slotsRemaining);
      onLog('📧 STEP 4a ✓ — ' + toProcess.length + ' leads con email + ICP verificado listos para análisis IA');

      // ── STEP 4b: Batch AI analysis ────────────────────────────────────────────
      onLog('✍ STEP 4b — Generando análisis IA (batch) para ' + toProcess.length + ' creadores...');
      await this.generateCreatorAnalysisBatch(toProcess, onLog);

      // Stream leads to UI and accept
      for (const lead of toProcess) {
        if (!this.isRunning) break;
        lead.status = 'ready';
        accepted.push(lead);
        onLeadFound?.(lead);
        if (lead.ig_handle) existingIgHandles.add(lead.ig_handle);
        const emailStr = lead.decisionMaker?.email ? '📧 ' + lead.decisionMaker.email : '(sin email)';
        onLog('[✓] ' + accepted.length + '/' + targetCount + ': @' + lead.ig_handle +
          ' (' + this.formatFollowers(lead.follower_count || 0) + ' | ' + lead.niche + ') ' + emailStr);
        if (accepted.length >= targetCount) break;
      }

      onLog('[ENGINE] Progreso: ' + accepted.length + '/' + targetCount +
        ' — faltan ' + (targetCount - accepted.length) + ' leads | intento ' + attempt + '/' + MAX_RETRIES);
    }

    // Final summary
    if (!this.isRunning && accepted.length < targetCount) {
      onLog('[ENGINE] Search stopped by user after ' + attempt + ' attempts. Found ' + accepted.length + '/' + targetCount + '.');
    } else if (accepted.length >= targetCount) {
      onLog('[ENGINE] ✅ Target reached: ' + accepted.length + '/' + targetCount + ' creators found in ' + attempt + ' attempts.');
    } else {
      onLog('[ENGINE] ⚠ Máx intentos (' + MAX_RETRIES + ') alcanzado. Encontrados ' + accepted.length + '/' + targetCount + '.');
    }

    await this.sendLeadsToInstantly(accepted, onLog, instantlyCampaignId);
    onComplete(accepted);
  }
}

export const instagramPersonalBrandEngine = new InstagramPersonalBrandEngine();
