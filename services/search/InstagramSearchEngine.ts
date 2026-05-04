/**
 * InstagramSearchEngine — "Keep going until N leads found"
 *
 * Architecture mirrors SistemaLinkedin/lib/LinkedInSearchEngineV2.ts:
 *   - HASHTAG_POOL rotation so each attempt uses different hashtags
 *   - True while(found < target) loop — never stops early on empty batches
 *   - Consecutive-zeros guard to detect genuine niche exhaustion
 *   - Session-level seenHandles Set — no re-processing across attempts
 *   - Only ICP-verified (soft filter passed) leads are accepted
 *   - MAX_RETRIES scales with the target, capped at 100
 */

import { Lead, SearchConfigState, AudienceTier, ICPType, VideoItem } from '../../lib/types';
import { deduplicationService } from '../deduplication/DeduplicationService';
import { PROJECT_CONFIG } from '../../config/project';
import { icpEvaluator, RawApifyProfile } from './ICPEvaluator';
import { emailDiscoveryService } from './EmailDiscoveryService';
import type { LogCallback, ResultCallback } from './SearchService';

// ── Fitness-only keyword pool ────────────────────────────────────────────────
// All variants are gym/fitness — no wellness, mindset, or personal development
// Each inner array is one query variant per search attempt.
const KEYWORD_POOLS: string[][] = [
  ['"fitness coach"', '"personal trainer"'],
  ['"gym coach"', '"bodybuilding coach"'],
  ['"strength coach"', '"workout coach"'],
  ['"crossfit coach"', '"hiit coach"'],
  ['"physique coach"', '"muscle building"'],
  ['"fitness content creator"', '"gym influencer"'],
  ['"fitspo"', '"gymlife"'],
  ['"gymrat"', '"gains"'],
  ['"calisthenics"', '"weightlifting"'],
  ['"workout routine"', '"fitness tips"'],
  ['"personal trainer online"', '"online fitness coach"'],
  ['"body transformation"', '"fat loss"'],
  ['"gym vlog"', '"workout video"'],
  ['"gym motivation"', '"lifting"'],
  ['"nutrition coach"', '"diet coach"'],
  ['"meal prep"', '"sports nutrition"'],
];

// ── Faceless & Clipper keyword pool ────────────────────────────────────────
// 13 archetype-specific groups derived from ICP reference accounts:
//   @finesteditsz (clipper), @nofexcuses (EN motivation), @arys.fitness (ES fitness),
//   @brian09__ (ES gym creator), @bautibelloso (physique/natty), @moullaga67 (money faceless)
// Each inner array is one OR-group per search attempt.
// NOTE: "link in bio" is NOT required here — many ICP accounts have minimal bios.
// It is only injected on combined-platform queries (mod===0) in buildSearchQuery.
const FACELESS_CLIPPER_KEYWORD_POOLS: string[][] = [
  // 1. Clipper / editor identity — explicit self-identification
  ['"clipper"', '"editor"', '"edits"', '"daily clips"', '"dm for promos"'],
  // 2. EN motivation / no-excuses archetype
  ['"no excuses"', '"best version"', '"discipline"', '"hard work"'],
  // 3. EN hustle / wealth / online business
  ['"passive income"', '"wifi money"', '"make money online"', '"online business"'],
  // 4. EN gym motivation / physique
  ['"no days off"', '"body transformation"', '"physique"', '"gains"', '"natty"'],
  // 5. EN mindset / stoicism / grindset
  ['"mindset"', '"stoic"', '"grindset"', '"self improvement"', '"discipline"'],
  // 6. ES motivation / mentalidad — Spanish-speaking market
  ['"mentalidad"', '"motivación"', '"disciplina"', '"sin excusas"'],
  // 7. ES gym / fitness / physique in Spanish
  ['"natty"', '"rutina"', '"entrenamiento"', '"mejor versión"', '"physique"'],
  // 8. ES hustle / emprendimiento
  ['"emprendimiento"', '"dinero online"', '"libertad financiera"', '"mentalidad ganadora"'],
  // 9. CTA / creator-intent signals — links to payhip, gumroad, forms.gle, linktr.ee
  ['"payhip"', '"gumroad"', '"forms.gle"', '"linktr.ee"'],
  // 10. Slideshow / carousel / frases — content format signals
  ['"slideshow"', '"frases"', '"quotes"', '"tips diarios"', '"desliza"'],
  // 11. Transformation / progress content
  ['"transformation"', '"gymtok"', '"cutting"', '"bulking"', '"progreso"'],
  // 12. Figure-clip accounts (editors of Hormozi, Tate, Goggins etc.)
  ['"hormozi"', '"goggins"', '"tate"', '"gadzhi"', '"david goggins"'],
  // 13. Finance / money faceless accounts (emoji names, minimal bios)
  ['"dinero"', '"riqueza"', '"financial freedom"', '"money"', '"wealth"'],
];

// Location suffixes — split by region so the engine respects the campaign's targetRegions filter.
// buildSearchQuery() picks the right sub-array at runtime based on icpFilters.regions.
const LOCATION_SUFFIXES_US = [
  'USA',
  'United States',
  'California',
  'New York',
  'Texas',
  'Florida',
  'American',
  'US',
];
const LOCATION_SUFFIXES_CA = [
  'Canada',
  'Ontario',
  'British Columbia',
  'Canadian',
];
// Spanish-speaking markets — Spain + LatAm
const LOCATION_SUFFIXES_ES = [
  'España',
  'Spain',
  'Madrid',
  'Barcelona',
  'Valencia',
];
const LOCATION_SUFFIXES_LATAM = [
  'Argentina',
  'México',
  'Colombia',
  'Buenos Aires',
  'Ciudad de México',
  'Medellín',
  'Latino',
];
// Fallback when both US and CA are targeted (or no region filter set)
const LOCATION_SUFFIXES_US_CA = [...LOCATION_SUFFIXES_US, ...LOCATION_SUFFIXES_CA];
const LOCATION_SUFFIXES_ES_LATAM = [...LOCATION_SUFFIXES_ES, ...LOCATION_SUFFIXES_LATAM];

// After this many consecutive attempts yielding 0 novel handles → rotate query harder
const MAX_CONSEC_ZEROS = 5;

// Region patterns (same as SearchService)
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

// Google Search Scraper — queries `site:instagram.com [keywords]`, extracts handles from URLs
const GOOGLE_SEARCH_SCRAPER = 'nFJndFXA5zjCTuudP';
const INSTAGRAM_PROFILE_SCRAPER = 'apify~instagram-profile-scraper';
// apify~tiktok-profile-scraper returns one profile object per username (not a video feed).
// The old clockworks~free-tiktok-scraper was returning errors within 2 seconds, replaced by the official actor.
const TIKTOK_PROFILE_SCRAPER = 'apify~tiktok-profile-scraper';
const INSTAGRAM_POSTS_SCRAPER = 'apify~instagram-scraper';

// TikTok URL path segments that are not profile pages
const TIKTOK_SKIP_HANDLES = new Set(['tag', 'search', 'discover', 'music', 'video', 'live', 'trending', 'foryou', 't']);

// Anti-ICP negative keywords — always appended to every Google Search query to purge
// local physical businesses (restaurants, retail, clinics) and generic corporate accounts.
// This is the first-line defence against false positives at the search layer.
const ANTI_ICP_NEGATIVES = '-restaurant -cafe -clinic -store -food -apparel -"life coach" -corporate -consulting -boutique -"shop now"';

// Handle with platform tag — produced during multi-platform search result parsing
type HandleWithPlatform = { handle: string; platform: 'instagram' | 'tiktok' };

// ── Engine ─────────────────────────────────────────────────────────────────────

export class InstagramSearchEngine {
  private isRunning = false;
  private userId: string | null = null;

  public stop() {
    this.isRunning = false;
  }

  // ── Keyword / query rotation ─────────────────────────────────────────────────

  /** Returns the appropriate keyword pool based on ICPType */
  private detectKeywordPool(_baseKeywords: string[], icpType?: ICPType): string[][] {
    if (icpType === 'faceless_clipper') return FACELESS_CLIPPER_KEYWORD_POOLS;
    return KEYWORD_POOLS;
  }

  /**
   * Builds a Google Search query for a given attempt.
   *   attempt 1  → user's own keywords, no location
   *   attempt 2+ → rotate through keyword pool variants + location suffixes
   *
   * When `relaxed = true` (triggered after attempt 15), quotes are stripped from
   * all keyword phrases to widen the Google search funnel automatically.
   *
   * Result (strict):  `site:instagram.com "keyword1" "keyword2" Location`
   * Result (relaxed): `site:instagram.com keyword1 keyword2 Location`
   */
  private buildSearchQuery(
    baseKeywords: string[],
    attempt: number,
    keywordPool: string[][],
    relaxed: boolean,
    icpType?: ICPType,
    locationSuffixes?: string[],
  ): string {
    const locSuffixes = locationSuffixes ?? LOCATION_SUFFIXES_US_CA;
    // Derive first-attempt location string from active suffixes
    const hasUS = locSuffixes.some(l => l.toLowerCase().includes('us') || l.toLowerCase().includes('united states') || l.toLowerCase().includes('america'));
    const hasCA = locSuffixes.some(l => l.toLowerCase().includes('canada') || l.toLowerCase().includes('canadian'));
    const hasES = locSuffixes.some(l => l.toLowerCase().includes('spain') || l.toLowerCase().includes('españa') || l.toLowerCase().includes('madrid'));
    const hasLatam = locSuffixes.some(l => ['argentina','méxico','colombia','latino'].some(x => l.toLowerCase().includes(x)));
    const firstLoc = hasES || hasLatam
      ? (hasES && hasLatam ? 'España OR Argentina OR México OR Colombia' : hasES ? 'España' : 'Argentina OR México OR Colombia')
      : (hasUS && hasCA ? 'USA OR Canada' : hasUS ? 'USA' : 'Canada');

    // Faceless & Clipper: 4-cycle rotation — TikTok-first (2:1 over Instagram).
    //   mod === 0  → Combined  (site:tiktok.com OR site:instagram.com) + CTA group
    //   mod === 1  → TikTok only  (no "link in bio" — many ICP accounts have minimal bios)
    //   mod === 2  → TikTok only  (different keyword group)
    //   mod === 3  → Instagram only
    // "link in bio" is ONLY injected on combined-platform queries (mod===0).
    // Single-platform queries use the raw OR-group to avoid filtering out @bautibelloso-style
    // accounts with minimal bios.
    if (icpType === 'faceless_clipper') {
      const poolIdx = attempt <= 1 ? 0 : (attempt - 2) % keywordPool.length;
      const locIdx  = attempt <= 1 ? 0 : Math.floor((attempt - 2) / keywordPool.length) % locSuffixes.length;
      const terms = keywordPool[poolIdx];
      const orGroup = '(' + terms.join(' OR ') + ')';
      const loc = attempt === 1 ? firstLoc : locSuffixes[locIdx];
      // CTA group — injected only on combined-platform queries to narrow intent
      const ctaGroup = '("link in bio" OR "DM for promo" OR "linktr.ee" OR "payhip" OR "forms.gle")';
      const mod = attempt % 4;
      if (mod === 0) {
        // Combined: broadest reach, CTA-narrowed to force creator-intent signal
        return `(site:tiktok.com OR site:instagram.com) ${orGroup} ${ctaGroup} ${loc} -site:instagram.com/p/ -site:instagram.com/reel/ -site:tiktok.com/tag/ ${ANTI_ICP_NEGATIVES}`;
      } else if (mod === 1) {
        // TikTok-only — no "link in bio" requirement: finds minimal-bio creators
        return `site:tiktok.com ${orGroup} ${loc} -site:tiktok.com/tag/ ${ANTI_ICP_NEGATIVES}`;
      } else if (mod === 2) {
        // TikTok-only with CTA signal — second TikTok cycle per 4-attempt rotation
        return `site:tiktok.com ${orGroup} ("dm for promo" OR "linktr.ee" OR "payhip") ${loc} -site:tiktok.com/tag/ ${ANTI_ICP_NEGATIVES}`;
      } else {
        // Instagram-only — no "link in bio" requirement
        return `site:instagram.com ${orGroup} ${loc} -site:instagram.com/p/ -site:instagram.com/reel/ ${ANTI_ICP_NEGATIVES}`;
      }
    }

    let keywords: string[];
    let location: string;

    if (attempt === 1) {
      keywords = baseKeywords.slice(0, 2).map(k => k.includes('"') ? k : `"${k}"`);
      location = firstLoc;
    } else {
      const poolIdx = (attempt - 2) % keywordPool.length;
      const locIdx  = Math.floor((attempt - 2) / keywordPool.length) % locSuffixes.length;
      keywords = keywordPool[poolIdx];
      location = locSuffixes[locIdx];
    }

    // Dynamic relaxation: strip surrounding quotes when the niche is too narrow
    if (relaxed) {
      keywords = keywords.map(k => k.replace(/^"|"$/g, ''));
    }

    const kw = keywords.join(' ');
    return location ? `site:instagram.com ${kw} ${location} ${ANTI_ICP_NEGATIVES}` : `site:instagram.com ${kw} ${ANTI_ICP_NEGATIVES}`;
  }

  // ── Apify calls ──────────────────────────────────────────────────────────────

  /**
   * All Apify calls go through /api/apify (Vercel serverless function).
   * The Apify token lives server-side only — never sent to the browser.
   * Works in dev (Vite dev server runs the api/ functions) AND in prod (Vercel).
   */
  private async apifyRequest(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    const res = await fetch('/api/apify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, method, body }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`/api/apify ${res.status}: ${err.substring(0, 300)}`);
    }
    return res.json();
  }

  private async callApifyActor(actorId: string, input: unknown, onLog: LogCallback): Promise<unknown[]> {
    onLog('[APIFY] Lanzando ' + actorId.split('~').pop() + '...');

    // Start the actor run
    const startData = await this.apifyRequest(`acts/${actorId}/runs`, 'POST', input) as {
      data?: { id?: string; defaultDatasetId?: string };
    };
    const runId = startData.data?.id;
    const datasetId = startData.data?.defaultDatasetId;
    if (!runId || !datasetId) throw new Error('Apify: missing runId or datasetId');
    onLog('[APIFY] Run ' + runId.substring(0, 8) + ' iniciado');

    // Poll until done — adaptive interval: 1500ms first poll, 2000ms thereafter.
    // Google Search actors finish in 2-4s → caught on poll 2 at ~3.5s total elapsed.
    // Profile scrapers finish in 3-8s → caught on polls 2-4 at 3.5-7.5s total.
    // Old fixed 5000ms delay wasted 3-4s per actor call regardless of actual run time.
    let done = false;
    let polls = 0;
    let elapsedMs = 0;
    while (!done && this.isRunning && polls < 600) {
      const delay = polls === 0 ? 1500 : 2000;
      await new Promise(r => setTimeout(r, delay));
      elapsedMs += delay;
      polls++;
      try {
        const sd = await this.apifyRequest(`acts/${actorId}/runs/${runId}`, 'GET') as {
          data?: { status?: string };
        };
        const status = sd.data?.status ?? '';
        if (polls % 3 === 1) onLog('[APIFY] ' + status + ' (' + Math.round(elapsedMs / 1000) + 's)');
        if (status === 'SUCCEEDED') done = true;
        else if (status === 'FAILED' || status === 'ABORTED') throw new Error('Actor ' + status);
      } catch (pe: unknown) {
        const msg = pe instanceof Error ? pe.message : String(pe);
        if (msg.includes('FAILED') || msg.includes('ABORTED')) throw pe;
      }
    }

    if (!done) throw new Error('Apify timeout after ' + Math.round(elapsedMs / 1000) + 's');
    if (!this.isRunning) return [];

    // Download results
    onLog('[APIFY] Descargando resultados...');
    const items = await this.apifyRequest(`datasets/${datasetId}/items`, 'GET') as unknown[];
    if (!Array.isArray(items)) throw new Error('Dataset is not an array');
    onLog('[APIFY] ✓ ' + items.length + ' items descargados');
    return items;
  }

  // ── Utility helpers ──────────────────────────────────────────────────────────

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
    // Clipper / editor — highest specificity, check first
    if (/clipper|editor\b|edits|daily.?clips|dm.?for.?promo/.test(text)) return 'Clips & Edits';
    // Physique / natty — gym progression creators
    if (/natty|physique|cutting|bulking|gains|aesthetics|body.?transformation|shredded/.test(text)) return 'Physique';
    // Finance / wealth faceless
    if (/wifi.?money|passive.?income|financial.?freedom|make.?money|dinero|riqueza|libertad.?financiera/.test(text)) return 'Business';
    // Motivation / mindset (EN + ES)
    if (/mindset|motivation|discipline|no.?excuses|grindset|hard.?work|mentalidad|motivaci[oó]n|disciplina|sin.?excusas/.test(text)) return 'Motivation';
    // Fitness (EN)
    if (/fitness|gym|workout|bodybuilding|strength|crossfit/.test(text)) return 'Fitness';
    // Fitness (ES)
    if (/entrenamiento|rutina|ejercicio|forma.?f[ií]sica/.test(text)) return 'Fitness';
    if (/yoga|meditation|mindfulness|wellness|breathwork/.test(text)) return 'Wellness';
    if (/nutrition|diet|healthyfood|mealprep|weightloss|nutrici[oó]n/.test(text)) return 'Nutrition';
    if (/entrepreneur|business|startup|marketing|sales|emprendimiento/.test(text)) return 'Business';
    if (/running|marathon|triathlon|cycling|endurance/.test(text)) return 'Endurance';
    return 'Other';
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
      summary: lead.niche + ' creator with ' + followerStr + ' followers.',
    };
  }

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

  // ── Snippet follower extraction ───────────────────────────────────────────────

  /**
   * Attempts to extract a follower count from a Google snippet string.
   * Handles: "12.5K Followers", "2.3M Followers", "150,000 Followers", "850 followers",
   *          "15 K Followers" (space before suffix), "seguidores" (Spanish snippets).
   * Returns the count as a number, or null if the pattern is absent.
   */
  private extractFollowersFromSnippet(text: string): number | null {
    if (!text) return null;
    // \s* after the number allows "15 K" (space before suffix)
    // [Bb] covers billions (rare edge case)
    // followers? covers singular; seguidores? covers Spanish snippets
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
   * Splits an array into sequential chunks of the given size.
   * Used to bound concurrency for email discovery and AI analysis calls.
   */
  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  // ── Batch LLM Analysis (Pilar 2 + 3) ─────────────────────────────────────────
  /**
   * BATCH AI ANALYSIS — replaces N individual generateCreatorAnalysis() calls
   * with a single /api/openai call that processes all leads at once.
   *
   * Why: Each individual call carries ~300-800ms of network round-trip overhead.
   * For 10 leads, 10 calls = 3–8s of pure latency overhead before any tokens are
   * processed. One batch call eliminates 9 of those 10 round trips.
   *
   * Model Tiering (Pilar 3):
   *   Pass 1 — gpt-4o-mini: fast, cheap, handles the full batch in one call.
   *   Pass 2 — gpt-4o (optional): premium enrichment for coldEmailBody and
   *             psychologicalProfile only, activated by usePremiumModel=true in
   *             PROJECT_CONFIG.flownextConfig. Doubles AI cost; disable by default.
   *
   * Mutates each Lead's aiAnalysis field in place.
   * Falls back to individual generateCreatorAnalysis() calls if the batch fails.
   */
  private async generateCreatorAnalysisBatch(
    leads: Lead[],
    onLog: LogCallback,
    icpType: ICPType,
  ): Promise<void> {
    if (!leads.length) return;

    const vslLink = PROJECT_CONFIG.flownextConfig?.vslLink || 'https://flownext.io/vsl';
    const usePremiumModel = PROJECT_CONFIG.flownextConfig?.usePremiumModel ?? false;

    // Build compact batch input — only the fields the LLM needs
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

    // Helper: applies a parsed results array onto lead objects
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
          // Premium enrichment: only overwrite the richer fields on top of mini base
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

    // ── Pass 1: gpt-4o-mini — fast batch for all leads ───────────────────────
    let batchSucceeded = false;
    try {
      const response = await fetch('/api/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // FAST MODEL (Pilar 3): gpt-4o-mini handles the full batch in one call.
          // It is fast (~1-2s per batch regardless of N) and cheap ($0.15/1M tokens).
          // DO NOT swap this for gpt-4o here — use usePremiumModel flag for enrichment.
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Analyze these ' + leads.length + ' creators:\n' + JSON.stringify(batch) },
          ],
          temperature: 0.7,
          // Allow enough tokens for the full array: ~350 tokens per lead
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
      // Fallback: individual calls (old behavior) — preserves correctness over speed
      onLog('[BATCH AI] Fallback: analizando ' + leads.length + ' perfiles individualmente...');
      for (const lead of leads) {
        if (!this.isRunning) break;
        try {
          const a = await this.generateCreatorAnalysis(lead);
          const followerStr = this.formatFollowers(lead.follower_count || 0);
          lead.aiAnalysis = {
            summary: a.summary,
            painPoints: [],
            generatedIcebreaker: a.vslPitch,
            coldEmailSubject: a.coldEmailSubject,
            coldEmailBody: a.coldEmailBody,
            vslPitch: a.vslPitch,
            fullAnalysis: a.psychologicalProfile + ' | ' + a.engagementSignal,
            psychologicalProfile: a.psychologicalProfile,
            engagementSignal: a.engagementSignal,
            salesAngle: a.salesAngle,
          };
          void followerStr; // suppress unused warning
        } catch { /* generateCreatorAnalysis already returns defaults on error */ }
      }
      return;
    }

    // Ensure every lead has aiAnalysis set (guards against partial batch responses)
    for (const lead of leads) {
      if (!lead.aiAnalysis) {
        const followerStr = this.formatFollowers(lead.follower_count || 0);
        lead.aiAnalysis = {
          summary: (lead.niche || 'Creator') + ' with ' + followerStr + ' followers.',
          painPoints: [],
          generatedIcebreaker: 'Scale your brand without more hours',
          coldEmailSubject: 'Quick question about your ' + (lead.niche || 'content'),
          coldEmailBody: this.fallbackEmailBody(lead, vslLink),
          vslPitch: 'Scale your brand without more hours',
          fullAnalysis: 'Ambitious creator.',
          psychologicalProfile: 'Ambitious creator focused on growth.',
          engagementSignal: 'Active niche audience.',
          salesAngle: 'Monetization opportunity.',
        };
      }
    }

    // ── Pass 2: gpt-4o — premium enrichment (Pilar 3, opt-in) ───────────────
    // Only runs when usePremiumModel=true. Overwrites coldEmailBody, psychologicalProfile,
    // salesAngle, and summary with richer, more conversion-focused copy.
    // Cost: ~$5-15/1M tokens vs $0.15/1M for gpt-4o-mini. Enable deliberately.
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
          // PREMIUM MODEL (Pilar 3): only reached when usePremiumModel=true.
          // Used exclusively for enrichment — the fast filter already ran above.
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

  // ── Post Vision Verifier ──────────────────────────────────────────────────────

  /**
   * Fetches the 3 most recent posts for a batch of IG handles using the
   * instagram-scraper actor and builds a map handle → PostSummary[].
   * TikTok handles receive an empty array (their recent videos come from
   * the profile scraper via normalizeTikTokProfile, handled separately).
   *
   * SLOW SCRAPER NOTE (Pilar 5): apify~instagram-scraper below IS Puppeteer-based.
   * This is intentional and acceptable ONLY because fetchRecentPosts() is called
   * exclusively for faceless_clipper content verification, which runs as an async
   * cron job (ContentVerificationService) — NEVER during a live user search.
   * DO NOT call this method from the main search loop.
   */
  private async fetchRecentPosts(
    igHandles: string[],
    onLog: LogCallback,
  ): Promise<Map<string, { caption: string; hashtags: string[]; isVideo: boolean; thumbnailUrl: string }[]>> {
    const result = new Map<string, { caption: string; hashtags: string[]; isVideo: boolean; thumbnailUrl: string }[]>();
    if (!igHandles.length) return result;

    try {
      const items = await this.callApifyActor(INSTAGRAM_POSTS_SCRAPER, {
        directUrls: igHandles.map(h => `https://www.instagram.com/${h}/`),
        resultsType: 'posts',
        resultsLimit: 3,
      }, onLog);

      for (const item of items as Record<string, unknown>[]) {
        const owner = ((item.ownerUsername as string) || '').toLowerCase().trim();
        if (!owner) continue;
        const fullCaption = (item.caption as string) || '';
        const caption = fullCaption.substring(0, 600);
        // Extract hashtags from the caption for richer post-vision context
        const hashtags = (fullCaption.match(/#[\w]+/g) || []).slice(0, 20);
        const isVideo = ((item.type as string) || '').toLowerCase() === 'video';
        const thumbnailUrl = (item.displayUrl as string) || (item.thumbnailUrl as string) || '';
        const existing = result.get(owner) ?? [];
        if (existing.length < 3) {
          existing.push({ caption, hashtags, isVideo, thumbnailUrl });
          result.set(owner, existing);
        }
      }
    } catch (e: unknown) {
      onLog('[POST VISION] ⚠ Posts scraper error (skipping vision step): ' + (e instanceof Error ? e.message : String(e)));
    }
    return result;
  }

  /**
   * Sends the last 3 posts (captions + thumbnails) of a creator to GPT-4o vision
   * and asks whether ≥2 posts match the faceless/clipper/motivational content type.
   *
   * Returns approved=true on API error (benefit of the doubt — never block on infra failures).
   * Returns approved=true when no posts are available (TikTok profiles with no latestVideos).
   */
  private async analyzePostsForFacelessICP(
    handle: string,
    posts: { caption: string; hashtags: string[]; isVideo: boolean; thumbnailUrl: string }[],
    onLog: LogCallback,
  ): Promise<{ approved: boolean; reason: string; confidence: number }> {
    // No posts available → pass through (benefit of the doubt)
    if (!posts.length) {
      return { approved: true, reason: 'No posts available — passed by default', confidence: 50 };
    }

    const postsContext = posts.map((p, i) => {
      const hashtagLine = p.hashtags.length > 0 ? `\nHashtags: ${p.hashtags.join(' ')}` : '';
      return `Post ${i + 1}: type=${p.isVideo ? 'video' : 'image/carousel'}\nCaption: ${p.caption || '(no caption)'}${hashtagLine}`;
    }).join('\n\n');

    const systemPrompt =
      'You are an expert content analyst for a creator outreach agency. ' +
      'Your task: decide if a creator\'s last 3 posts match the FACELESS / CLIPPER / MOTIVATIONAL / GYM-MOTIVATION content archetype.\n\n' +
      'APPROVE (approved=true) if AT LEAST 2 of the 3 posts fall into ANY of these categories:\n' +
      '- Faceless motivation: no face shown, voiceover + b-roll, mindset, discipline, entrepreneurship, self-improvement\n' +
      '- Clipper/reposter: edited clips from known figures (Hormozi, Tate, Gadzhi, Goggins, etc.) or other motivational speakers\n' +
      '- Slideshow/carousel: motivational quotes, mindset tips, wealth/success, discipline, hustle, grind culture\n' +
      '- Gym motivation: body transformation posts, before/after physique, "no days off", "no excuses", discipline in the gym, cutting/bulking journeys WITH a motivational message or caption\n' +
      '- Online business tips: passive income, make money online, dropshipping, smma, agency growth, wifi money\n\n' +
      'REJECT (approved=false) if the majority of posts are:\n' +
      '- Personal face-forward lifestyle content (selfies, daily vlogs, travel diaries, food posts) with no motivational angle\n' +
      '- Pure gym tutorial/form-check demonstrations by a certified trainer (educational fitness instruction, NOT motivation)\n' +
      '- Entertainment, comedy, gaming, or niches completely unrelated to motivation/mindset/fitness/business\n\n' +
      'NOTE: Gym transformation or physique progress posts are VALID when paired with a motivational/discipline caption or hashtags like #nodaysoff #discipline #transformation.\n\n' +
      'Reply ONLY with valid JSON, no markdown:\n' +
      '{"approved":true,"confidence":85,"reason":"2 of 3 are discipline/transformation posts with motivational captions"}';

    const userMessage = `Analyze these 3 most recent posts for creator @${handle}:\n\n${postsContext}`;
    const imageMessages = posts
      .filter(p => p.thumbnailUrl)
      .slice(0, 3)
      .map(p => ({ type: 'image_url' as const, image_url: { url: p.thumbnailUrl } }));

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch('/api/openai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: [
                  { type: 'text', text: userMessage },
                  ...imageMessages,
                ],
              },
            ],
            temperature: 0.2,
            max_tokens: 150,
          }),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const raw = data.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { approved?: boolean; confidence?: number; reason?: string };
          return {
            approved: parsed.approved ?? true,
            reason: parsed.reason || '',
            confidence: parsed.confidence ?? 70,
          };
        }
      } catch {
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
      }
    }
    // API failure → pass through
    return { approved: true, reason: 'Vision API unavailable — passed by default', confidence: 50 };
  }

  /**
   * Normalizes a TikTok profile (clockworks/tiktok-profile-scraper output) into the
   * RawApifyProfile shape expected by ICPEvaluator.applyHardFilter().
   * Adds __platform: 'tiktok' so the candidate-building section sets lead.source correctly.
   */
  private normalizeTikTokProfile(p: Record<string, unknown>): RawApifyProfile {
    // Support both clockworks~free-tiktok-scraper (flat fields) and legacy actor
    // (which nested profile data under authorMeta on video-feed items).
    const meta = (p.authorMeta as Record<string, unknown>) || {};
    const bioLink = (p.bioLink as Record<string, unknown>) || {};
    const website =
      (typeof bioLink.link === 'string' ? bioLink.link : '') ||
      (p.bioLink as string) ||
      (p.website as string) ||
      (meta.bioLink as string) || '';
    const regionCode = ((p.region as string) || (p.countryCode as string) || (meta.region as string) || '').toUpperCase();
    const username = (
      (p.uniqueId as string) ||
      (p.username as string) ||
      (meta.uniqueId as string) ||
      (meta.username as string) ||
      ''
    ).toLowerCase().trim();
    const followersCount = (
      (p.fans as number) ||
      (p.followerCount as number) ||
      (p.follower_count as number) ||
      (meta.fans as number) ||
      (meta.followerCount as number) ||
      0
    );
    const biography = (
      (p.signature as string) ||
      (p.bio as string) ||
      (p.desc as string) ||
      (meta.signature as string) ||
      (meta.bio as string) ||
      ''
    );
    const fullName = (
      (p.nickname as string) ||
      (p.displayName as string) ||
      (p.name as string) ||
      (meta.nickname as string) ||
      (meta.displayName as string) ||
      ''
    );
    return {
      username,
      followersCount,
      biography,
      fullName,
      externalUrl: website,
      publicEmail: (p.email as string) || (meta.email as string) || '',
      countryCode: regionCode,
      country: regionCode === 'US' ? 'United States' : regionCode === 'CA' ? 'Canada' : regionCode,
      __platform: 'tiktok',
    } as RawApifyProfile;
  }

  // ── Public entry point ───────────────────────────────────────────────────────

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
      onLog('[INIT] Apify: via /api/apify (serverless proxy)');
      onLog('[INIT] UserId: ' + (this.userId || 'not authenticated'));
      onLog('[INIT] Source: ' + config.source + ' | Query: "' + config.query + '" | Target: ' + config.maxResults);

      onLog('[DEDUP] Loading existing leads from database (últimos 30 días)...');
      const { existingIgHandles, existingEmails } = await deduplicationService.fetchExistingLeads(this.userId);
      onLog('[DEDUP] Pre-flight: ' + existingIgHandles.size + ' IG handles, ' + existingEmails.size + ' emails already in DB');

      await this.runSearchLoop(config, existingIgHandles, existingEmails, onLog, onComplete, config.instantlyCampaignId, onLeadFound);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[InstagramSearchEngine] FATAL:', error);
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
    const icpType: ICPType = icpFilters?.icpType ?? 'personal_brand';
    const targetCount = Math.max(1, config.maxResults);
    const baseKeywords = this.parseKeywordsFromQuery(config.query);
    const keywordPool  = this.detectKeywordPool(baseKeywords, icpType);

    // Derive location suffixes to use for query rotation based on campaign's targetRegions.
    // This ensures a US-only campaign never rotates into Canadian location suffixes,
    // and a Spanish-language campaign uses ES/LatAm suffixes instead of US/CA.
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

    // MAX_RETRIES scales with target size — base of 40 so even small targets (1-5) have enough runway
    const MAX_RETRIES = Math.min(75, Math.max(40, targetCount * 5));

    onLog('[IG] Keywords base: ' + baseKeywords.join(', '));      onLog('[IG] ICP Type: ' + icpType);    onLog('[IG] Keyword pool: ' + keywordPool.length + ' variantes de búsqueda (Google site:instagram.com)');
    onLog('[IG] 🎯 Objetivo: ' + targetCount + ' creadores | Máx intentos: ' + MAX_RETRIES);
    onLog('[IG] Followers: ' + (minFollowers > 0 ? this.formatFollowers(minFollowers) : '0') + ' – ' + (maxFollowers < 99_000_000 ? this.formatFollowers(maxFollowers) : '∞'));
    console.log('[InstagramEngine] START — target:', targetCount, '| maxRetries:', MAX_RETRIES, '| keywords:', baseKeywords);
    if (minFollowers > 0 || maxFollowers < 99_000_000) {
      onLog('[ICP] Follower range: ' + this.formatFollowers(minFollowers) + ' – ' + this.formatFollowers(maxFollowers));
    }
    if (targetRegions.length > 0) onLog('[ICP] Regiones: ' + targetRegions.join(', '));
    if (targetContentTypes.length > 0) onLog('[ICP] Tipos de contenido: ' + targetContentTypes.join(', '));

    const accepted: Lead[] = [];

    // Session-level handle tracker: includes DB handles + all handles seen this session
    // Prevents re-processing the same account even when hashtags rotate
    const seenHandles = new Set<string>(existingIgHandles);

    let attempt = 0;
    let consecutiveZeros = 0;
    let relaxedLogged = false;

    // Handles to skip — Instagram system/non-user paths
    const SKIP_HANDLES = new Set(['p', 'reel', 'reels', 'explore', 'stories',
      'accounts', 'tv', 'direct', 'hashtag', 'tagged', 'about', 'directory']);

    while (accepted.length < targetCount && this.isRunning && attempt < MAX_RETRIES) {
      attempt++;
      const needed = targetCount - accepted.length;
      const relaxed = attempt > 15;

      if (relaxed && !relaxedLogged) {
        relaxedLogged = true;
        onLog(`[ENGINE] 🔓 Query relaxation active (attempt ${attempt}) — switching to broad search`);
        console.log('[InstagramEngine] Query relaxation activated at attempt', attempt);
      }

      const searchQuery = this.buildSearchQuery(baseKeywords, attempt, keywordPool, relaxed, icpType, activeLocationSuffixes);

      onLog('');
      onLog('━━━ ATTEMPT ' + attempt + '/' + MAX_RETRIES + ' ━━━  ' +
        needed + ' lead(s) still needed');
      onLog('🔎 STEP 1/4 — Google Search: ' + searchQuery);

      // ── STEP 1: Google Search site:instagram.com → novel handles ────────────
      // FAST SCRAPER (Pilar 5): nFJndFXA5zjCTuudP is an API-based Google Search
      // scraper — returns JSON in ~1-2s. DO NOT replace with a headless/Puppeteer
      // actor. This actor does NOT start a browser; it uses Google's public API.
      let searchResults: unknown[];
      try {
        searchResults = await this.callApifyActor(GOOGLE_SEARCH_SCRAPER, {
          queries: searchQuery,
          maxPagesPerQuery: 2,  // 2 pages × 100 = up to 200 organic results per attempt
          resultsPerPage: 100,
        }, onLog);
      } catch (e: unknown) {
        onLog('[STEP 1] Google Search error: ' + (e instanceof Error ? e.message : String(e)));
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) {
          onLog('[ENGINE] ' + consecutiveZeros + ' consecutive failures — aborting.');
          break;
        }
        continue;
      }

      if (!searchResults.length) {
        onLog('🔎 No results for: ' + searchQuery);
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) {
          onLog('[ENGINE] ' + MAX_CONSEC_ZEROS + ' empty rounds — rotando queries. Deteniendo.');
          break;
        }
        continue;
      }

      // Extract IG handles — actor wraps results inside organicResults[] (same as LinkedIn engine)
      const allOrganicResults: Record<string, unknown>[] = [];
      for (const item of searchResults as Record<string, unknown>[]) {
        const organic = item.organicResults as Record<string, unknown>[] | undefined;
        if (Array.isArray(organic)) {
          allOrganicResults.push(...organic);
        } else if (item.url || item.link) {
          allOrganicResults.push(item); // fallback: top-level item already has url
        }
      }
      // Build snippet map and extract handles with platform tag (Instagram + TikTok)
      const handleToSnippet = new Map<string, string>();
      const rawHandlesWithPlatform: HandleWithPlatform[] = [];
      for (const item of allOrganicResults) {
        const url = ((item.url as string) || (item.link as string) || '').toLowerCase();
        const snippet = ((item.description as string) || (item.snippet as string) || (item.title as string) || '');
        const igMatch = url.match(/instagram\.com\/([^/?#\s]+)/);
        if (igMatch) {
          const h = igMatch[1].trim();
          if (h && !SKIP_HANDLES.has(h) && !seenHandles.has(h)) {
            rawHandlesWithPlatform.push({ handle: h, platform: 'instagram' });
            if (snippet) handleToSnippet.set(h, snippet);
          }
        } else {
          const ttMatch = url.match(/tiktok\.com\/@([^/?#\s]+)/);
          if (ttMatch) {
            const h = ttMatch[1].trim();
            if (h && !TIKTOK_SKIP_HANDLES.has(h) && !seenHandles.has(h)) {
              rawHandlesWithPlatform.push({ handle: h, platform: 'tiktok' });
              if (snippet) handleToSnippet.set(h, snippet);
            }
          }
        }
      }

      // Deduplicate (keep first occurrence per handle)
      const seenRaw = new Set<string>();
      const uniqueRawHandles = rawHandlesWithPlatform.filter(({ handle }) => {
        if (seenRaw.has(handle)) return false;
        seenRaw.add(handle);
        return true;
      });

      // Snippet follower pre-filter: free discard before expensive profile scraping
      let snippetFiltered = 0;
      let snippetPassed = 0;
      let snippetUnknown = 0;
      const novelHandles: HandleWithPlatform[] = [];
      // Iterate ALL unique handles — the regex check is free (no API cost), so there
      // is no reason to cap it. Only survivors reach the expensive profile scraper.
      for (const item of uniqueRawHandles) {
        const snippet = handleToSnippet.get(item.handle) || '';
        const snippetFollowers = this.extractFollowersFromSnippet(snippet);
        if (snippetFollowers !== null) {
          if (snippetFollowers < minFollowers || snippetFollowers > maxFollowers) {
            snippetFiltered++;
            continue;
          }
          snippetPassed++;
        } else {
          snippetUnknown++;
        }
        novelHandles.push(item);
      }
      if (snippetFiltered > 0 || snippetPassed > 0) {
        onLog(`[PRE-FILTER] Snippet regex: ${snippetFiltered} descartados pre-scrape, ${snippetPassed} pasan, ${snippetUnknown} sin dato`);
      }

      onLog('🔎 STEP 1/4 ✓ — ' + searchResults.length + ' items (' + allOrganicResults.length + ' organic) → ' + novelHandles.length + ' handles nuevos');
      console.log('[InstagramEngine] Attempt', attempt, '| novel handles:', novelHandles.length, 'from', allOrganicResults.length, 'organic results');

      if (!novelHandles.length) {
        onLog('⚠ Sin handles nuevos en esta query — rotando...');
        console.warn('[InstagramEngine] Attempt', attempt, '— 0 novel handles. Rotating.');
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) {
          onLog('[ENGINE] ' + MAX_CONSEC_ZEROS + ' rondas sin handles nuevos. Deteniendo.');
          break;
        }
        continue;
      }

      // Mark ALL novel handles as seen immediately (prevents parallel re-processing)
      for (const { handle } of novelHandles) seenHandles.add(handle);
      consecutiveZeros = 0; // reset — fresh handles found

      // ── STEP 2: Full profile scrape — parallel by platform ──────────────────────
      // PRE-SCRAPE DEDUP NOTE (Pilar 1): handles from Google Search are already
      // filtered against existingIgHandles (seenHandles Set) above — known handles
      // never reach this point. Only genuinely novel handles hit the profile scraper.
      //
      // FAST SCRAPER (Pilar 5):
      //   Instagram: apify~instagram-profile-scraper uses Instagram's internal GraphQL
      //   API (NOT Puppeteer/headless). Returns profile JSON in 2-5s per batch.
      //   If this actor is ever replaced, ensure the replacement also uses GraphQL
      //   (e.g. apify/instagram-api-scraper). DO NOT use Puppeteer-based actors here —
      //   headless browser cold-start adds 30-60s overhead per run.
      //
      //   TikTok: clockworks~free-tiktok-scraper uses TikTok's internal API (not
      //   headless). DO NOT replace with a Puppeteer/Playwright-based TikTok actor.
      const igHandles = novelHandles.filter(h => h.platform === 'instagram').map(h => h.handle);
      const ttHandles = novelHandles.filter(h => h.platform === 'tiktok').map(h => h.handle);
      onLog(`👤 STEP 2/4 — Fetching profiles: ${igHandles.length} Instagram, ${ttHandles.length} TikTok`);
      // ── STEP 2: Profile scrapers — partial results via Promise.allSettled ───
      // Promise.allSettled ensures a TikTok scraper failure does NOT discard
      // Instagram results that already completed. Each scraper is independent;
      // we collect fulfilled results and log individual failures.
      const scrapeJobs: { label: string; promise: Promise<unknown[]> }[] = [];
      if (igHandles.length > 0) {
        scrapeJobs.push({
          label: 'Instagram',
          promise: this.callApifyActor(INSTAGRAM_PROFILE_SCRAPER, { usernames: igHandles }, onLog),
        });
      }
      if (ttHandles.length > 0 && icpType === 'faceless_clipper') {
        scrapeJobs.push({
          label: 'TikTok',
          promise: this.callApifyActor(
            TIKTOK_PROFILE_SCRAPER,
            // maxItems:1 — fetch only the profile object, not the video feed
            { usernames: ttHandles, maxItems: 1 },
            onLog,
          ).then(ttProfiles => {
            const normalized = (ttProfiles as Record<string, unknown>[])
              .map(p => this.normalizeTikTokProfile(p))
              .filter(p => p.username !== ''); // discard video-feed items with no username
            // Deduplicate by username (video-feed items can repeat the same profile)
            const seen = new Set<string>();
            const deduped = normalized.filter(p => {
              if (seen.has(p.username)) return false;
              seen.add(p.username);
              return true;
            });
            onLog(`[TIKTOK] ${ttProfiles.length} raw items → ${deduped.length} unique profiles after normalization`);
            return deduped;
          }),
        });
      }
      const scrapeSettled = await Promise.allSettled(scrapeJobs.map(j => j.promise));
      const profiles: unknown[] = [];
      let allScrapersFailed = true;
      for (let si = 0; si < scrapeSettled.length; si++) {
        const r = scrapeSettled[si];
        if (r.status === 'fulfilled') {
          profiles.push(...r.value);
          allScrapersFailed = false;
        } else {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          onLog(`👤 STEP 2/4 ⚠ ${scrapeJobs[si].label} scraper failed: ${msg}`);
        }
      }
      if (allScrapersFailed) {
        onLog('👤 STEP 2/4 ✗ All scrapers failed — rotating query...');
        continue;
      }
      onLog('👤 STEP 2/4 ✓ — ' + profiles.length + ' profiles received' +
        (allScrapersFailed ? '' : scrapeSettled.some(r => r.status === 'rejected') ? ' (partial — some scrapers failed)' : ''));

      // ── STEP 3: Hard ICP filter ──────────────────────────────────────────────
      onLog('🔍 STEP 3/4 — Aplicando filtros ICP duros (' + profiles.length + ' perfiles)...');
      const hardFiltered = icpEvaluator.applyHardFilter(profiles as RawApifyProfile[], onLog, icpType);
      onLog('[HARD FILTER] Embudo: ' + profiles.length + ' descargados → ' + hardFiltered.length +
        ' pasaron (followers ✓, sin marca ✓, keyword fitness ✓)');
      console.log('[InstagramEngine] Attempt', attempt, '| hard filter:', profiles.length, '→', hardFiltered.length);

      if (!hardFiltered.length) {
        onLog('⚠ Ningún perfil pasó el hard filter en este batch. Rotando query...');
        console.warn('[InstagramEngine] Attempt', attempt, '— 0 passed hard filter');
        continue;
      }

      // Build candidate Lead objects
      const candidates: (Lead & { _rawBio: string })[] = [];
      for (const profile of hardFiltered) {
        if (!this.isRunning) break;
        const p = profile as Record<string, unknown>;
        const handle = ((p.username as string) || '').toLowerCase().trim();
        if (!handle) continue;

        const followers = (p.followersCount as number) || 0;
        const bio = ((p.biography as string) || (p.bio as string) || '');
        const fullName = ((p.fullName as string) || (p.name as string) || '');
        const emailFromBio = this.extractEmailFromBio(bio);
        const emailFromApify = (
          (p.publicEmail as string) ||
          (p.businessEmail as string) ||
          (p.email as string) ||
          (p.contactEmail as string) || ''
        ).toLowerCase().trim();
        const email = emailFromBio || emailFromApify;
        const website = ((p.externalUrl as string) || (p.website as string) || '').trim();
        const niche = this.detectNiche(bio, handle, fullName);
        const regionRaw = ((p.country as string) || (p.city as string) || '');

        // Custom follower range (ICP filter override)
        if (followers < minFollowers) {
          onLog('[ICP] ↓ @' + handle + ' — ' + this.formatFollowers(followers) + ' < ' + this.formatFollowers(minFollowers));
          continue;
        }
        if (followers > maxFollowers) {
          onLog('[ICP] ↑ @' + handle + ' — ' + this.formatFollowers(followers) + ' > ' + this.formatFollowers(maxFollowers));
          continue;
        }

        // Region filter — always enforce US/Canada only (target market)
        const US_CA_PATTERNS = ['united states', 'usa', 'u.s.', 'america', 'us', 'canada', 'canadian', 'alberta', 'ontario', 'british columbia', 'quebec', 'california', 'new york', 'texas', 'florida'];
        const locationStr = [p.country, p.city, p.region, p.countryCode, p.locationName]
          .map(v => ((v as string) || '').toLowerCase())
          .join(' ');
        if (locationStr.trim()) {
          const matchesUSCA = US_CA_PATTERNS.some(pat => locationStr.includes(pat));
          if (!matchesUSCA) {
            onLog('[ICP] 🌍 @' + handle + ' — "' + (p.country || p.city || '') + '" no es US/Canada — descartado');
            continue;
          }
        }
        // No location data → allow through (Google Search ya filtra por US/CA)

        // Content type filter
        if (targetContentTypes.length > 0) {
          const matchesContent = targetContentTypes.some(ct =>
            niche.toLowerCase().includes(ct.toLowerCase()) ||
            ct.toLowerCase().includes(niche.split(' ')[0].toLowerCase()),
          );
          if (!matchesContent) {
            onLog('[ICP] 🏷 @' + handle + ' — niche "' + niche + '" ∉ [' + targetContentTypes.join(', ') + ']');
            continue;
          }
        }

        const platformTag = (p.__platform as string) === 'tiktok' ? 'tiktok' : 'instagram';
        candidates.push({
          id: platformTag + '-' + handle + '-' + Date.now(),
          source: platformTag as 'instagram' | 'tiktok',
          ig_handle: handle,
          follower_count: followers,
          niche,
          audience_tier: this.detectAudienceTier(followers),
          location: regionRaw,
          website,
          _rawBio: bio,
          decisionMaker: {
            name: fullName || '@' + handle,
            role: 'Content Creator',
            email,
            instagram: platformTag === 'tiktok'
              ? 'https://tiktok.com/@' + handle
              : 'https://instagram.com/' + handle,
          },
          aiAnalysis: {
            summary: bio,
            painPoints: [],
            generatedIcebreaker: '',
            coldEmailSubject: '',
            coldEmailBody: '',
            vslPitch: '',
            fullAnalysis: '',
            psychologicalProfile: '',
            engagementSignal: '',
            salesAngle: '',
          },
          vsl_sent_status: 'pending',
          email_status: 'pending',
          status: 'scraped',
        });
      }

      onLog('[FUNNEL] ' + candidates.length + '/' + hardFiltered.length +
        ' pasaron filtros de seguidor/región/nicho');
      console.log('[InstagramEngine] Attempt', attempt, '| after ICP filters:', candidates.length, 'candidates');

      if (!candidates.length) {
        onLog('⚠ Ningún candidato pasó los filtros ICP en este batch. Rotando query...');
        console.warn('[InstagramEngine] Attempt', attempt, '— 0 candidates after ICP filters. Check follower range and region settings.');
        continue;
      }

      // DB-level dedup (also checks against already-accepted leads in this session)
      const acceptedHandles = new Set(accepted.map(l => l.ig_handle || ''));
      const notYetAccepted = candidates.filter(c => !acceptedHandles.has(c.ig_handle || ''));
      const dbDeduped = deduplicationService.filterUniqueCandidates(notYetAccepted, existingIgHandles, existingEmails);
      onLog('[DEDUP] ' + dbDeduped.length + '/' + notYetAccepted.length + ' son nuevos (no están en la BD)');
      console.log('[InstagramEngine] Attempt', attempt, '| after dedup:', dbDeduped.length);

      if (!dbDeduped.length) {
        onLog('⚠ Todos los candidatos ya existen en la BD. Rotando query...');
        continue;
      }

      // ── STEP 3c: Post Data Collection (faceless_clipper only) ───────────────
      // CONCURRENCY: fire this Apify call immediately and DON'T await it here.
      // Email discovery (Step 3b) runs in parallel. Posts (10-30s) and email
      // discovery (1-5s) overlap; we await results just before saving leads.
      const postVerifiedCandidates = dbDeduped;
      type PostItem3c = { caption: string; hashtags: string[]; isVideo: boolean; thumbnailUrl: string };
      let postsPromise: Promise<Map<string, PostItem3c[]>> = Promise.resolve(new Map());
      let igCandidatesForPosts: Lead[] = [];
      if (icpType === 'faceless_clipper') {
        igCandidatesForPosts = dbDeduped.filter(l => l.source !== 'tiktok');
        const igHandlesForPosts = igCandidatesForPosts.map(l => l.ig_handle || '').filter(Boolean);
        if (igHandlesForPosts.length > 0) {
          onLog(`🎬 STEP 3c — Recolectando posts para ${igHandlesForPosts.length} candidatos IG (en paralelo con email discovery)...`);
          postsPromise = this.fetchRecentPosts(igHandlesForPosts, onLog).catch((e: unknown) => {
            onLog(`[STEP 3c] ⚠ Post collection error (skipping): ${e instanceof Error ? e.message : String(e)}`);
            return new Map<string, PostItem3c[]>();
          });
        }
      }

      // ── STEP 3b: Email discovery FIRST — no email = skip AI credits ──────────
      // Runs concurrently with Step 3c post collection above.
      // Rule: discover email before spending OpenAI tokens. Only leads WITH email
      // proceed to ICP soft filter and AI analysis.
      const slotsRemaining = targetCount - accepted.length;
      const toDiscover = postVerifiedCandidates.slice(0, Math.max(slotsRemaining * 8, postVerifiedCandidates.length));
      onLog('📧 STEP 3b — Email discovery para ' + toDiscover.length + ' candidatos (antes de gastar IA)...');
      // All chunks fire in parallel — each chunk itself is a Promise.all of 10 concurrent requests
      await Promise.all(this.chunkArray(toDiscover, 10).map(async (chunk) => {
        await Promise.all(chunk.map(async (lead) => {
          if (!this.isRunning) return;
          const discovered = lead.source === 'tiktok'
            ? await emailDiscoveryService.discoverEmailForTikTok(
                lead.decisionMaker?.email || '',
                lead.website || '',
                lead.ig_handle || '',
                onLog,
              )
            : await emailDiscoveryService.discoverEmail(
                lead.decisionMaker?.email || '',
                lead.website || '',
                lead.ig_handle || '',
                onLog,
              );
          if (discovered && lead.decisionMaker) lead.decisionMaker.email = discovered;
        }));
      }));
      const withEmail = toDiscover.filter(l => l.decisionMaker?.email);
      const withoutEmail = toDiscover.filter(l => !l.decisionMaker?.email);
      onLog('📧 STEP 3b ✓ — ' + withEmail.length + '/' + toDiscover.length + ' tienen email | ' +
        withoutEmail.length + ' descartados (sin email → sin gasto de IA)');
      console.log('[InstagramEngine] Attempt', attempt, '| with email:', withEmail.length, '/', toDiscover.length);

      if (!withEmail.length) {
        onLog('⚠ Ningún candidato tiene email en este batch. Rotando query...');
        continue;
      }

      // ── STEP 4: AI Soft Filter — solo para leads CON email ───────────────────
      onLog('🤖 STEP 4a — Filtro IA para ' + withEmail.length + ' candidatos con email (verificando ICP fitness)...');
      const softFiltered = await icpEvaluator.applySoftFilter(withEmail, onLog, icpType);
      const icpVerified = softFiltered.filter(l => l.icp_verified === true);
      const icpUnverified = softFiltered.filter(l => l.icp_verified !== true);

      onLog('[ICP SOFT] Resultado: ' + icpVerified.length + ' verificados ✓ | ' +
        icpUnverified.length + ' no verificados ✗ (de ' + softFiltered.length + ' evaluados)');
      console.log('[InstagramEngine] Attempt', attempt, '| icp_verified:', icpVerified.length, '/', softFiltered.length);

      // If AI completely failed (0 verified AND soft filter returned all unverified),
      // use hard-filtered candidates as fallback rather than discarding the entire batch
      const toEvaluate = icpVerified.length > 0 ? icpVerified : (() => {
        if (icpUnverified.length > 0) {
          onLog('⚠ IA no pudo verificar este batch (posible error de API). Usando candidatos del hard filter como fallback...');
          console.warn('[InstagramEngine] Attempt', attempt, '— AI soft filter returned 0 verified. Using hard-filter fallback.');
        }
        return icpUnverified;
      })();

      if (!toEvaluate.length) {
        onLog('⚠ Ningún lead ICP en este batch. Rotando hashtags...');
        continue;
      }

      // ── Anti-ICP Early Exit (Paso 3) ─────────────────────────────────────────
      // Leads flagged as Anti-ICP by the soft filter are discarded HERE — before
      // generateCreatorAnalysisBatch(). Zero tokens spent on summaries, pain_points,
      // cold emails, or psychological profiles for accounts that are clearly wrong targets.
      const antiIcpLeads = toEvaluate.filter(l => (l as any).anti_icp === true);
      if (antiIcpLeads.length > 0) {
        for (const lead of antiIcpLeads) {
          lead.status = 'discarded';
          onLog(`[ANTI-ICP 🚫] @${lead.ig_handle} → discarded (cero tokens IA gastados)`);
        }
        onLog(`[ANTI-ICP] ${antiIcpLeads.length} lead(s) descartados sin análisis IA.`);
      }
      const cleanToEvaluate = toEvaluate.filter(l => !(l as any).anti_icp);
      if (!cleanToEvaluate.length) {
        onLog('⚠ Todos los leads del batch eran Anti-ICP. Rotando query...');
        continue;
      }

      // Accept only leads that passed ICP (all already have email at this point)
      const toProcess = cleanToEvaluate.slice(0, slotsRemaining);
      onLog('📧 STEP 4a ✓ — ' + toProcess.length + ' leads con email + ICP verificado listos para análisis IA');

      if (!toProcess.length) {
        onLog('⚠ Ningún candidato ICP verificado en este batch. Rotando query...');
        continue;
      }

      // ── STEP 4b: AI analysis for ICP-verified leads with email ───────────────
      onLog('✍ STEP 4b — Generando análisis IA para ' + toProcess.length + ' creadores (con email + ICP ✓)...');

      // ── BATCH AI ANALYSIS (Pilar 2: LLM Prompt Batching) ─────────────────────
      // One /api/openai call for ALL N leads instead of N individual calls.
      // Eliminates N-1 round-trip latencies (~300-800ms each). For 10 leads this
      // is ~10× faster than the old Promise.all(chunkArray(leads, 5)) approach.
      // Model Tiering (Pilar 3): fast gpt-4o-mini first; optional gpt-4o enrichment
      // pass if PROJECT_CONFIG.flownextConfig.usePremiumModel = true.
      // Falls back to individual calls if the batch request fails.
      await this.generateCreatorAnalysisBatch(toProcess, onLog, icpType);

      // ── Await Step 3c posts (started concurrently with email discovery) ────
      // By this point email discovery (~1-5s) + soft filter (~2s) + AI (~2s)
      // have already elapsed. Posts collection (10-30s) is likely still running
      // for the first portion; we wait only for whatever remains.
      if (igCandidatesForPosts.length > 0) {
        const postsMap = await postsPromise;
        if (postsMap.size > 0) {
          for (const lead of igCandidatesForPosts) {
            const handle = lead.ig_handle || '';
            const posts = postsMap.get(handle) ?? [];
            if (posts.length > 0) {
              (lead as Lead)._videoItemsForVerification = posts.map(p => ({
                thumbnailUrl: p.thumbnailUrl,
                transcript: p.caption || undefined,
                platform: 'instagram' as const,
              } satisfies VideoItem));
            }
          }
          onLog(`[STEP 3c] ✓ Posts recolectados para ${postsMap.size}/${igCandidatesForPosts.length} handles`);
        }
      }

      // Set lead status and stream each lead to the UI immediately (Pilar 4: Streaming)
      // onLeadFound fires per lead as soon as analysis is done — the screen populates
      // while the engine continues its next attempt in the background.
      const analyzed: Lead[] = [];
      for (const lead of toProcess) {
        if (!this.isRunning) break;
        lead.status = icpType === 'faceless_clipper' ? 'pending_content_verification' : 'ready';
        if (icpType === 'faceless_clipper') lead._icpType = 'faceless_clipper';
        analyzed.push(lead);
      }

      // Accept all analyzed leads (with or without email)
      for (const lead of analyzed) {
        accepted.push(lead);
        // Stream this lead to the UI immediately — don't wait for the full run to finish
        onLeadFound?.(lead);
        // Register in existingIgHandles so future dedup passes are aware
        if (lead.ig_handle) existingIgHandles.add(lead.ig_handle);
        const emailStr = lead.decisionMaker?.email ? '📧 ' + lead.decisionMaker.email : '(sin email — pendiente enriquecimiento)';
        onLog('[✓] ' + accepted.length + '/' + targetCount +
          ': @' + lead.ig_handle +
          ' (' + this.formatFollowers(lead.follower_count || 0) +
          ' | ' + lead.niche + ') ' + emailStr);
        if (accepted.length >= targetCount) break;
      }

      onLog('[ENGINE] Progreso: ' + accepted.length + '/' + targetCount +
        ' — faltan ' + (targetCount - accepted.length) + ' leads | intento ' + attempt + '/' + MAX_RETRIES);
      console.log('[InstagramEngine] After attempt', attempt, '| accepted:', accepted.length, '/', targetCount);
    }

    // ── Final summary ─────────────────────────────────────────────────────────
    if (!this.isRunning && accepted.length < targetCount) {
      onLog('[ENGINE] Search stopped by user after ' + attempt + ' attempts. Found ' +
        accepted.length + '/' + targetCount + '.');
    } else if (accepted.length >= targetCount) {
      onLog('[ENGINE] ✅ Target reached: ' + accepted.length + '/' + targetCount + ' creators found in ' + attempt + ' attempts.');
    } else {
      onLog('[ENGINE] ⚠ Máx intentos (' + MAX_RETRIES + ') alcanzado. Encontrados ' + accepted.length + '/' + targetCount +
        '. Prueba keywords más amplias o relaja filtros ICP.');
    }

    await this.sendLeadsToInstantly(accepted, onLog, instantlyCampaignId);
    onComplete(accepted);
  }

  // ── Instantly integration ─────────────────────────────────────────────

  private async sendLeadsToInstantly(leads: Lead[], onLog: LogCallback, instantlyCampaignId?: string): Promise<void> {
    const leadsWithEmail = leads.filter(l => l.decisionMaker?.email);
    console.log('[INSTANTLY] sendLeadsToInstantly — total accepted:', leads.length, '| with email:', leadsWithEmail.length, '| campaignId:', instantlyCampaignId || '(env default)');
    if (!leadsWithEmail.length) {
      onLog('[INSTANTLY] ⚠ Sin leads con email para enviar a Instantly.');
      return;
    }
    onLog('[INSTANTLY] 📤 Enviando ' + leadsWithEmail.length + ' lead(s) a campaña de Instantly...');

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const lead of leadsWithEmail) {
      const email = lead.decisionMaker!.email!;
      const fullName = lead.decisionMaker?.name || '';
      const nameParts = fullName.split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      console.log('[INSTANTLY] → Sending:', email, '(@' + lead.ig_handle + ')');
      try {
        const response = await fetch('/api/instantly-add-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            firstName,
            lastName,
            companyName: lead.decisionMaker?.name || lead.ig_handle || '',
            igHandle: lead.ig_handle || '',
            niche: lead.niche || '',
            aiSummary: lead.aiAnalysis?.summary || '',
            coldEmailSubject: lead.aiAnalysis?.coldEmailSubject || '',
            followerCount: lead.follower_count || 0,
            ...(instantlyCampaignId ? { campaignId: instantlyCampaignId } : {}),
          }),
        });

        const responseData = await response.json().catch(() => ({})) as Record<string, unknown>;
        console.log('[INSTANTLY] ← Response for', email, '— HTTP', response.status, '| body:', JSON.stringify(responseData).substring(0, 400));

        if (response.ok) {
          sent++;
          onLog('[INSTANTLY] ✅ ' + email + ' (@' + lead.ig_handle + ') añadido a campaña');
        } else if (response.status === 409) {
          skipped++;
          onLog('[INSTANTLY] ℹ Ya en campaña: ' + email);
        } else {
          failed++;
          onLog('[INSTANTLY] ❌ Error ' + response.status + ' para ' + email + ': ' + JSON.stringify(responseData).substring(0, 300));
        }
      } catch (e: unknown) {
        failed++;
        console.error('[INSTANTLY] Network error for', email, e);
        onLog('[INSTANTLY] ❌ Error de red para ' + email + ': ' + (e instanceof Error ? e.message : String(e)));
      }
    }

    onLog('[INSTANTLY] 📊 ' + sent + ' enviados' +
      (skipped ? ', ' + skipped + ' ya existían' : '') +
      (failed ? ', ' + failed + ' errores' : ''));
  }

  // ── Keyword parser ────────────────────────────────────────────────────────────

  /**
   * Extracts search keywords from the user's query string.
   * Handles:
   *   - Hashtag-only queries (#fitnesscoach OR #gymlife) → detects niche, returns phrases
   *   - Plain keyword queries (fitness coach, yoga) → returns as-is
   *   - Boolean queries ("coach" OR "trainer") → strips operators, returns phrases
   */
  private parseKeywordsFromQuery(query: string): string[] {
    const defaults = ['mindset', 'motivation', 'wifi money', 'clips'];
    if (!query) return defaults;

    const explicit = query.match(/#[a-zA-Z0-9_]+/g);
    if (explicit && explicit.length > 0) {
      return explicit.map(k => k.replace('#', ''));
    }

    const lower = query.toLowerCase();
    const keywords = lower.split(' or ').map(k => k.trim().replace(/"/g, ''));

    return keywords.length > 0 ? keywords : defaults;
  }
}

export const instagramSearchEngine = new InstagramSearchEngine();
