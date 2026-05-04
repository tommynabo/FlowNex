/**
 * TikTokFacelessEngine — Dedicated engine for "Faceless / Clipper / Motivación" ICP
 *
 * Scope: Faceless creators, motivational clippers, physique/natty progressors, and
 *        online-business faceless accounts on TikTok.
 *
 * Platform: 100% site:tiktok.com — zero Instagram-specific scraping in this file.
 * Scraper:  clockworks~tiktok-profile-scraper (TikTok internal API, not headless).
 *           ⚠️ BUG FIX: payload must be { profiles: string[] } — NOT { usernames: string[] }.
 *           Using `usernames` causes HTTP 400 from the clockworks actor.
 *
 * Lean Content Analysis (inline, real-time):
 *   After profile fetch, the last 3 TikTok videos (latestVideos[]) returned by the
 *   scraper are passed to ContentVerificationService.verifyCreatorContent() with
 *   prefetchedItems — zero extra Apify calls required.
 *   If is_icp_match === false → creator is skipped before email discovery or AI.
 *
 * Architecture mirrors InstagramPersonalBrandEngine:
 *   - Keep-going-until-N loop with consecutive-zeros guard
 *   - Session-level seenHandles Set
 *   - Batch AI analysis (Pilar 2: one OpenAI call per N leads)
 *   - Optional gpt-4o enrichment pass (Pilar 3, usePremiumModel flag)
 *   - Dedup pre-flight (Pilar 1)
 *   - Async streaming via onLeadFound (Pilar 4)
 *
 * Router: SearchService.ts delegates here when icpType === 'faceless_clipper'.
 */

import { Lead, SearchConfigState, AudienceTier, VideoItem } from '../../lib/types';
import { deduplicationService } from '../deduplication/DeduplicationService';
import { PROJECT_CONFIG } from '../../config/project';
import { icpEvaluator, RawApifyProfile, HARD_FILTER_MIN_FOLLOWERS } from './ICPEvaluator';
import { emailDiscoveryService } from './EmailDiscoveryService';
import { contentVerificationService } from './ContentVerificationService';
import type { LogCallback, ResultCallback } from './SearchService';

// ── Faceless & Clipper keyword pool ─────────────────────────────────────────
// 13 archetype-specific groups derived from ICP reference accounts:
//   @finesteditsz (clipper), @nofexcuses (EN motivation), @arys.fitness (ES fitness),
//   @brian09__ (ES gym creator), @bautibelloso (physique/natty), @moullaga67 (money faceless)
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
  // 13. Finance / money faceless accounts
  ['"dinero"', '"riqueza"', '"financial freedom"', '"money"', '"wealth"'],
];

const LOCATION_SUFFIXES_US = ['USA', 'United States', 'California', 'New York', 'Texas', 'Florida', 'American', 'US'];
const LOCATION_SUFFIXES_CA = ['Canada', 'Ontario', 'British Columbia', 'Canadian'];
const LOCATION_SUFFIXES_ES = ['España', 'Spain', 'Madrid', 'Barcelona', 'Valencia'];
const LOCATION_SUFFIXES_LATAM = ['Argentina', 'México', 'Colombia', 'Buenos Aires', 'Ciudad de México', 'Medellín', 'Latino'];
const LOCATION_SUFFIXES_US_CA = [...LOCATION_SUFFIXES_US, ...LOCATION_SUFFIXES_CA];
const LOCATION_SUFFIXES_ES_LATAM = [...LOCATION_SUFFIXES_ES, ...LOCATION_SUFFIXES_LATAM];

const MAX_CONSEC_ZEROS = 5;

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

// Google Search Scraper
const GOOGLE_SEARCH_SCRAPER = 'nFJndFXA5zjCTuudP';

// clockworks~tiktok-scraper is the general-purpose clockworks TikTok actor (170K+ users, 4.7★).
// It stores datasets under the CALLER's account (no 403 permission issues unlike tiktok-profile-scraper).
// Output format: video items with `authorMeta` nested object → handled by MODE B in groupTikTokItemsByProfile.
// Input: { profiles: ["handle"], resultsPerPage: 1 } → 1 video item per creator = minimal cost ($1.70/1K).
const TIKTOK_PROFILE_SCRAPER = 'clockworks~tiktok-scraper';

// Anti-ICP negative keywords — purge local businesses and off-target content
const ANTI_ICP_NEGATIVES = '-restaurant -cafe -clinic -store -food -apparel -"life coach" -corporate -consulting -boutique -"shop now" -"dance" -"beauty" -"makeup" -"cooking"';

// TikTok URL path segments that are not profile pages
const TIKTOK_SKIP_HANDLES = new Set(['tag', 'search', 'discover', 'music', 'video', 'live', 'trending', 'foryou', 't']);

export class TikTokFacelessEngine {
  private isRunning = false;
  private userId: string | null = null;

  public stop() {
    this.isRunning = false;
  }

  // ── Query builder ─────────────────────────────────────────────────────────────

  /**
   * Builds a site:tiktok.com Google Search query for the given attempt.
   * 4-cycle rotation — TikTok-first (3:1 over combined):
   *   mod === 0  → site:tiktok.com + CTA dorks (business-online intent signal)
   *   mod === 1  → site:tiktok.com only (minimal-bio creators — no CTA required)
   *   mod === 2  → site:tiktok.com + specific CTA group (DM for promo / linktr.ee)
   *   mod === 3  → site:tiktok.com + business dorks ("curso" / "programa" / "link in bio")
   * All queries are location-independent to maximise reach.
   */
  private buildSearchQuery(
    attempt: number,
  ): string {
    const poolIdx = attempt <= 1 ? 0 : (attempt - 2) % FACELESS_CLIPPER_KEYWORD_POOLS.length;
    const terms = FACELESS_CLIPPER_KEYWORD_POOLS[poolIdx];
    const orGroup = '(' + terms.join(' OR ') + ')';

    const ctaGroup = '("link in bio" OR "DM for promo" OR "linktr.ee" OR "payhip" OR "forms.gle")';
    const businessGroup = '("curso" OR "programa" OR "link in bio" OR "coaching" OR "mentoria")';
    const dmCtaGroup = '("dm for promo" OR "linktr.ee" OR "payhip" OR "gumroad")';

    const mod = attempt % 4;

    if (mod === 0) {
      // TikTok + CTA — narrowed to force creator-intent signal
      return `site:tiktok.com ${orGroup} ${ctaGroup} -site:tiktok.com/tag/ ${ANTI_ICP_NEGATIVES}`;
    } else if (mod === 1) {
      // TikTok only — no CTA: finds minimal-bio creators
      return `site:tiktok.com ${orGroup} -site:tiktok.com/tag/ ${ANTI_ICP_NEGATIVES}`;
    } else if (mod === 2) {
      // TikTok + DM/linktree CTA — second TikTok cycle
      return `site:tiktok.com ${orGroup} ${dmCtaGroup} -site:tiktok.com/tag/ ${ANTI_ICP_NEGATIVES}`;
    } else {
      // TikTok + Spanish/EN business dorks
      return `site:tiktok.com ${orGroup} ${businessGroup} -site:tiktok.com/tag/ ${ANTI_ICP_NEGATIVES}`;
    }
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

      // Helper: parse Apify error body regardless of nesting
      const parseApifyError = (raw: string): { type: string; message: string } => {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const rawDetails = parsed.details;
          const details = typeof rawDetails === 'string'
            ? JSON.parse(rawDetails) as Record<string, unknown>
            : (rawDetails as Record<string, unknown>) ?? parsed;
          const apifyError = (details?.error ?? details) as Record<string, unknown> | undefined;
          return {
            type: (apifyError?.type as string) || '',
            message: (apifyError?.message as string) || '',
          };
        } catch {
          return { type: '', message: '' };
        }
      };

      // ── 402: not enough usage credits ────────────────────────────────────────
      if (res.status === 402) {
        const { message } = parseApifyError(err);
        throw new Error('APIFY_QUOTA_EXCEEDED: ' + (message || 'Insufficient Apify credits — top up or upgrade plan.'));
      }

      // ── 403: check for quota OR actor-forbidden errors ────────────────────────
      if (res.status === 403) {
        const { type, message } = parseApifyError(err);
        if (
          type === 'platform-feature-disabled' ||
          type === 'actor-disabled' ||
          message.includes('Monthly usage hard limit')
        ) {
          throw new Error('APIFY_QUOTA_EXCEEDED: ' + (message || 'Monthly limit exceeded — upgrade your Apify plan.'));
        }
        if (type === 'insufficient-permissions') {
          throw new Error('APIFY_ACTOR_FORBIDDEN: ' + (message || 'Token lacks permissions for this actor/dataset.'));
        }
      }

      throw new Error(`/api/apify ${res.status}: ${err.substring(0, 300)}`);
    }
    return res.json();
  }

  private async callApifyActor(actorId: string, input: unknown, onLog: LogCallback, itemsLimit?: number): Promise<unknown[]> {
    onLog('[APIFY] Lanzando ' + actorId.split('~').pop() + '...');
    const startData = await this.apifyRequest(`acts/${actorId}/runs`, 'POST', input) as {
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

    onLog('[APIFY] Descargando resultados...');
    const datasetPath = itemsLimit
      ? `datasets/${datasetId}/items?limit=${itemsLimit}`
      : `datasets/${datasetId}/items`;
    const items = await this.apifyRequest(datasetPath, 'GET') as unknown[];
    if (!Array.isArray(items)) throw new Error('Dataset is not an array');
    onLog('[APIFY] ✓ ' + items.length + ' items descargados');
    return items;
  }

  // ── TikTok profile grouping ──────────────────────────────────────────────────

  /**
   * clockworks~tiktok-profile-scraper returns VIDEO items — not profile objects.
   * Each item represents one video; the profile data lives in authorMeta.
   * Key fields:
   *   item.author          → handle (string)
   *   item.authorMeta.name → handle (string) — same as item.author
   *   item.authorMeta.nickName → display name
   *   item.authorMeta.signature → bio
   *   item.authorMeta.fans → follower count
   *   item.authorMeta.region → country code
   *   item.authorMeta.bioLink → string URL or { link: string }
   *   item.desc            → video caption (used as latestVideo)
   *   item.covers[]        → thumbnail URLs
   *
   * This function groups items by author → one RawApifyProfile per creator.
   * The first 3 videos per creator are stored in _latestVideos for inline
   * Lean Content Analysis (zero extra Apify calls).
   */
  /**
   * Handles BOTH output shapes of clockworks~tiktok-profile-scraper:
   *
   * MODE A — resultsType:'profiles' (preferred, 1 item per creator):
   *   item.uniqueId / item.username  → handle
   *   item.fans                      → followers
   *   item.signature                 → bio
   *   item.nickName                  → display name
   *   item.region                    → country code
   *   item.bioLink                   → website
   *   Detection: item.authorMeta is absent
   *
   * MODE B — default video-item output (1 item per video, N videos per creator):
   *   item.author / item.authorMeta.name → handle
   *   item.authorMeta.fans               → followers
   *   item.authorMeta.signature          → bio
   *   item.authorMeta.nickName           → display name
   *   item.authorMeta.region             → country code
   *   item.authorMeta.bioLink            → website
   *   item.desc / item.covers[]          → video data for LCA
   *   Detection: item.authorMeta is present
   */
  private groupTikTokItemsByProfile(
    items: Record<string, unknown>[],
  ): Array<RawApifyProfile & { _latestVideos: { thumbnailUrl: string; desc: string }[] }> {
    type Entry = {
      meta: Record<string, unknown>;
      isProfileMode: boolean;
      videos: { thumbnailUrl: string; desc: string }[];
    };
    const profileMap = new Map<string, Entry>();

    for (const item of items) {
      const hasMeta = item.authorMeta && typeof item.authorMeta === 'object';

      if (!hasMeta) {
        // ── MODE A: profile object ────────────────────────────────────────────
        const handle = (
          (item.uniqueId as string) ||
          (item.username as string) ||
          (item.name as string) ||
          ''
        ).toLowerCase().replace(/^@/, '').trim();
        if (!handle || profileMap.has(handle)) continue;
        profileMap.set(handle, { meta: item, isProfileMode: true, videos: [] });
      } else {
        // ── MODE B: video item ────────────────────────────────────────────────
        const meta = item.authorMeta as Record<string, unknown>;
        const handle = (
          (meta.name as string) ||
          (item.author as string) ||
          (meta.uniqueId as string) ||
          ''
        ).toLowerCase().replace(/^@/, '').trim();
        if (!handle) continue;
        if (!profileMap.has(handle)) profileMap.set(handle, { meta, isProfileMode: false, videos: [] });
        const entry = profileMap.get(handle)!;
        if (entry.videos.length < 5) {
          entry.videos.push({
            thumbnailUrl:
              (Array.isArray(item.covers) ? (item.covers as string[])[0] : '') ||
              (item.thumbnail as string) || '',
            desc: (item.desc as string) || (item.description as string) || '',
          });
        }
      }
    }

    const results: Array<RawApifyProfile & { _latestVideos: { thumbnailUrl: string; desc: string }[] }> = [];
    for (const [handle, { meta, videos }] of profileMap) {
      const bioLinkRaw = meta.bioLink;
      const bioLink =
        typeof bioLinkRaw === 'string' ? bioLinkRaw :
        (bioLinkRaw && typeof (bioLinkRaw as Record<string, unknown>).link === 'string')
          ? (bioLinkRaw as Record<string, unknown>).link as string : '';
      const regionCode = ((meta.region as string) || (meta.countryCode as string) || '').toUpperCase();
      results.push({
        username: handle,
        followersCount: (meta.fans as number) || (meta.followerCount as number) || 0,
        biography: (meta.signature as string) || (meta.bio as string) || '',
        fullName: (meta.nickName as string) || (meta.nickname as string) || (meta.displayName as string) || '',
        externalUrl: bioLink,
        publicEmail: (meta.email as string) || '',
        countryCode: regionCode,
        country: regionCode,
        __platform: 'tiktok',
        _latestVideos: videos,
      } as RawApifyProfile & { _latestVideos: { thumbnailUrl: string; desc: string }[] });
    }
    return results;
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
    if (/clipper|editor\b|edits|daily.?clips|dm.?for.?promo/.test(text)) return 'Clips & Edits';
    if (/natty|physique|cutting|bulking|gains|aesthetics|body.?transformation|shredded/.test(text)) return 'Physique';
    if (/wifi.?money|passive.?income|financial.?freedom|make.?money|dinero|riqueza|libertad.?financiera/.test(text)) return 'Business';
    if (/mindset|motivation|discipline|no.?excuses|grindset|hard.?work|mentalidad|motivaci[oó]n|disciplina|sin.?excusas/.test(text)) return 'Motivation';
    if (/fitness|gym|workout|bodybuilding|strength|crossfit/.test(text)) return 'Fitness';
    if (/entrenamiento|rutina|ejercicio/.test(text)) return 'Fitness';
    if (/entrepreneur|business|startup|marketing|sales|emprendimiento/.test(text)) return 'Business';
    return 'Other';
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

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }

  /**
   * SNIPPET MODE — builds RawApifyProfile objects from Google Search result data.
   * Used as fallback when clockworks~tiktok-profile-scraper is unavailable (403 forbidden).
   * Extracts follower count from title/snippet text, email from snippet, bio from snippet.
   * When follower count cannot be determined, defaults to HARD_FILTER_MIN_FOLLOWERS (1 000)
   * so the profile passes the hard filter — accounts found by keyword search are likely creators.
   */
  private buildProfilesFromSnippets(
    handles: string[],
    handleToSnippet: Map<string, string>,
    handleToTitle: Map<string, string>,
  ): Array<RawApifyProfile & { _latestVideos: { thumbnailUrl: string; desc: string }[] }> {
    const defaultFollowers = HARD_FILTER_MIN_FOLLOWERS;

    return handles.map(handle => {
      const snippet = handleToSnippet.get(handle) || '';
      const title   = handleToTitle.get(handle) || '';
      const combined = title + ' ' + snippet;

      // Followers from title or snippet
      const followers = this.extractFollowersFromSnippet(combined) ?? defaultFollowers;

      // Email from snippet
      const emailMatch = combined.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      const publicEmail = emailMatch ? emailMatch[0].toLowerCase().trim() : '';

      // Bio is the snippet text (best approximation without profile scraping)
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
        __platform: 'tiktok' as const,
        _latestVideos: [],
      } as RawApifyProfile & { _latestVideos: { thumbnailUrl: string; desc: string }[] };
    });
  }

  private parseKeywordsFromQuery(query: string): string[] {
    const defaults = ['mindset', 'motivation', 'wifi money', 'clips'];
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
      'Love what you are building in the ' + (lead.niche || 'motivation') + ' space.\n\n' +
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
      'Platform: TikTok',
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
                  'You are an expert cold email copywriter for TikTok faceless/clipper/motivation creator outreach.\n' +
                  'GOAL: Write a cold email pitching a VSL link. Personal, peer-to-peer, not mass blast.\n' +
                  'TONE: Direct, confident, no fluff. English only. Under 120 words. No emojis in subject.\n' +
                  'Rules: Reference their niche (clips, motivation, physique, etc.). CTA = watch VSL. Subject under 8 words.\n' +
                  'Respond ONLY with this JSON (no markdown):\n' +
                  '{"coldEmailSubject":"...","coldEmailBody":"...","vslPitch":"One-liner hook max 15 words","psychologicalProfile":"2-sentence assessment","engagementSignal":"inferred signal","salesAngle":"top reason they say yes","summary":"one sentence lead description"}',
              },
              { role: 'user', content: 'Analyze this TikTok creator and write outreach:\n' + ctx + '\nVSL Link: ' + vslLink },
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
      platform: 'tiktok',
      name: lead.decisionMaker?.name || '',
      niche: lead.niche || '',
      followers: this.formatFollowers(lead.follower_count || 0),
      tier: lead.audience_tier || 'nano',
      email: lead.decisionMaker?.email || 'none',
    }));

    const systemPrompt =
      'You are an expert cold email copywriter for TikTok faceless/clipper/motivation creator outreach.\n' +
      'You will receive a JSON array of TikTok creator profiles.\n' +
      'GOAL: For EACH creator, write a cold email pitching a VSL link. Personal, peer-to-peer, not mass blast.\n' +
      'TONE: Direct, confident, no fluff. English only. Under 120 words per email. No emojis in subject.\n' +
      'Rules: Reference their niche (clips, motivation, physique, business). CTA = watch VSL. Subject under 8 words.\n' +
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
            { role: 'user', content: 'Analyze these ' + leads.length + ' TikTok creators:\n' + JSON.stringify(batch) },
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
            onLog('[BATCH AI] ✓ ' + leads.length + ' perfiles TikTok analizados en 1 llamada gpt-4o-mini (Pilar 2)');
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

    // Guard: ensure every lead has aiAnalysis
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

    onLog('[MODEL TIER] 🚀 Enriquecimiento premium con gpt-4o (' + leads.length + ' creadores TikTok)...');
    const premiumPrompt =
      'You are a world-class B2B copywriter specializing in TikTok creator economy outreach.\n' +
      'Rewrite the cold email body and psychological profile for MAXIMUM conversion.\n' +
      'Be highly specific to each creator\'s niche (clips, motivation, physique, business), audience size, and unique angle.\n' +
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
            { role: 'user', content: 'Enrich these ' + leads.length + ' TikTok creators:\n' + JSON.stringify(batch) },
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
            onLog('[MODEL TIER] ✓ Enriquecimiento gpt-4o completado (' + leads.length + ' creadores TikTok)');
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
      onLog('[TT-FC] Motor: TikTok Faceless / Clipper');
      onLog('[INIT] Apify: via /api/apify (serverless proxy)');
      onLog('[INIT] UserId: ' + (this.userId || 'not authenticated'));
      onLog('[INIT] Source: ' + config.source + ' | Query: "' + config.query + '" | Target: ' + config.maxResults);
      onLog('[TT-FC] Lean Content Analysis: ACTIVO (inline, sin scraping extra)');

      onLog('[DEDUP] Loading existing leads from database...');
      const { existingIgHandles, existingEmails } = await deduplicationService.fetchExistingLeads(this.userId);
      onLog('[DEDUP] Pre-flight: ' + existingIgHandles.size + ' handles, ' + existingEmails.size + ' emails already in DB');

      await this.runSearchLoop(config, existingIgHandles, existingEmails, onLog, onComplete, config.instantlyCampaignId, onLeadFound);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[TikTokFacelessEngine] FATAL:', error);
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
    const targetCount = Math.max(1, config.maxResults);

    // Reduced from 40-75 to 8-15 to avoid credit burn when scraper is down
    const MAX_RETRIES = Math.min(15, Math.max(8, targetCount * 3));

    onLog('[TT-FC] ICP Type: faceless_clipper (TikTok only)');
    onLog('[TT-FC] Keyword pool: ' + FACELESS_CLIPPER_KEYWORD_POOLS.length + ' variantes | site:tiktok.com');
    onLog('[TT-FC] 🎯 Objetivo: ' + targetCount + ' creadores | Máx intentos: ' + MAX_RETRIES);
    onLog('[TT-FC] Followers: ' + (minFollowers > 0 ? this.formatFollowers(minFollowers) : '0') + ' – ' + (maxFollowers < 99_000_000 ? this.formatFollowers(maxFollowers) : '∞'));
    if (targetRegions.length > 0) onLog('[ICP] Regiones: ' + targetRegions.join(', '));

    const accepted: Lead[] = [];
    const seenHandles = new Set<string>(existingIgHandles);
    let attempt = 0;
    let consecutiveZeros = 0;
    // Snippet fallback state — activated after 2 consecutive TikTok scraper 403s
    let ttScraperConsecFails = 0;
    let skipTtScraper = false;

    while (accepted.length < targetCount && this.isRunning && attempt < MAX_RETRIES) {
      attempt++;
      const needed = targetCount - accepted.length;
      const searchQuery = this.buildSearchQuery(attempt);

      onLog('');
      onLog('━━━ ATTEMPT ' + attempt + '/' + MAX_RETRIES + ' ━━━  ' + needed + ' lead(s) still needed');
      onLog('🔎 STEP 1/4 — Google Search (TikTok): ' + searchQuery);

      // ── STEP 1: Google Search site:tiktok.com ────────────────────────────────
      let searchResults: unknown[];
      try {
        searchResults = await this.callApifyActor(GOOGLE_SEARCH_SCRAPER, {
          queries: searchQuery,
          maxPagesPerQuery: 1,
          resultsPerPage: 100,
        }, onLog);
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.startsWith('APIFY_QUOTA_EXCEEDED')) {
          onLog('[ENGINE] ⛔ Apify quota agotada — ' + errMsg.replace('APIFY_QUOTA_EXCEEDED: ', '') + ' Abortando inmediatamente.');
          break;
        }
        onLog('[STEP 1] Google Search error: ' + errMsg);
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) { onLog('[ENGINE] ' + consecutiveZeros + ' consecutive failures — aborting.'); break; }
        continue;
      }

      if (!searchResults.length) {
        onLog('🔎 No results for: ' + searchQuery);
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) { onLog('[ENGINE] ' + MAX_CONSEC_ZEROS + ' empty rounds — deteniendo.'); break; }
        continue;
      }

      // Extract TikTok handles from Google Search results
      const allOrganicResults: Record<string, unknown>[] = [];
      for (const item of searchResults as Record<string, unknown>[]) {
        const organic = item.organicResults as Record<string, unknown>[] | undefined;
        if (Array.isArray(organic)) allOrganicResults.push(...organic);
        else if (item.url || item.link) allOrganicResults.push(item);
      }

      const handleToSnippet = new Map<string, string>();
      const handleToTitle   = new Map<string, string>();
      const rawHandles: string[] = [];
      for (const item of allOrganicResults) {
        const url     = ((item.url as string) || (item.link as string) || '').toLowerCase();
        const snippet = ((item.description as string) || (item.snippet as string) || '');
        const title   = (item.title as string) || '';
        const ttMatch = url.match(/tiktok\.com\/@([^/?#\s]+)/);
        if (ttMatch) {
          const h = ttMatch[1].trim();
          if (h && !TIKTOK_SKIP_HANDLES.has(h) && !seenHandles.has(h)) {
            rawHandles.push(h);
            if (snippet) handleToSnippet.set(h, snippet);
            if (title)   handleToTitle.set(h, title);
          }
        }
      }

      // Deduplicate
      const seenRaw = new Set<string>();
      const uniqueRawHandles = rawHandles.filter(h => { if (seenRaw.has(h)) return false; seenRaw.add(h); return true; });

      // Snippet follower pre-filter
      let snippetFiltered = 0;
      const novelHandles: string[] = [];
      for (const h of uniqueRawHandles) {
        const snippet = handleToSnippet.get(h) || '';
        const snippetFollowers = this.extractFollowersFromSnippet(snippet);
        if (snippetFollowers !== null && (snippetFollowers < minFollowers || snippetFollowers > maxFollowers)) {
          snippetFiltered++;
          continue;
        }
        novelHandles.push(h);
      }
      if (snippetFiltered > 0) onLog(`[PRE-FILTER] Snippet: ${snippetFiltered} descartados pre-scrape`);

      onLog('🔎 STEP 1/4 ✓ — ' + allOrganicResults.length + ' organic → ' + novelHandles.length + ' handles TikTok nuevos');

      if (!novelHandles.length) {
        onLog('⚠ Sin handles TikTok nuevos — rotando...');
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) { onLog('[ENGINE] ' + MAX_CONSEC_ZEROS + ' rondas sin handles nuevos. Deteniendo.'); break; }
        continue;
      }

      for (const h of novelHandles) seenHandles.add(h);
      consecutiveZeros = 0;

      // ── STEP 2: TikTok profile fetch (with snippet fallback) ─────────────────
      // skipTtScraper is set after 2 consecutive 403 ACTOR_FORBIDDEN errors.
      // In snippet mode: 0 extra Apify calls — profiles are built from Google data.
      const MAX_TT_BATCH = 5;
      const ttBatch = novelHandles.slice(0, MAX_TT_BATCH);
      let normalizedProfiles: ReturnType<typeof this.groupTikTokItemsByProfile>;

      if (skipTtScraper) {
        // ── Snippet mode ──────────────────────────────────────────────────────
        onLog('👤 STEP 2/4 — Snippet mode (TikTok scraper skipped, 0 Apify credits): ' + ttBatch.length + ' handles');
        normalizedProfiles = this.buildProfilesFromSnippets(ttBatch, handleToSnippet, handleToTitle);
        onLog('👤 STEP 2/4 ✓ — ' + normalizedProfiles.length + ' profiles built from Google snippets');
      } else {
        // ── Live TikTok scraper ───────────────────────────────────────────────
        onLog('👤 STEP 2/4 — Fetching ' + ttBatch.length + ' TikTok profiles (batch capped at ' + MAX_TT_BATCH + ')...');
        let rawTikTokProfiles: unknown[];
        try {
          // clockworks~tiktok-scraper: 1 video item per profile → cheapest way to get authorMeta.
          // resultsPerPage:1 + shouldDownload*:false → minimal cost, datasets stored under caller's account.
          rawTikTokProfiles = await this.callApifyActor(
            TIKTOK_PROFILE_SCRAPER,
            {
              profiles: ttBatch,
              resultsPerPage: 1,
              profileScrapeSections: ['videos'],
              maxProfilesPerQuery: ttBatch.length,
              shouldDownloadVideos: false,
              shouldDownloadCovers: false,
              shouldDownloadAvatars: false,
              shouldDownloadSubtitles: false,
              shouldDownloadSlideshowImages: false,
              shouldDownloadMusicCovers: false,
            },
            onLog,
            ttBatch.length * 3,
          );
          ttScraperConsecFails = 0;
          normalizedProfiles = this.groupTikTokItemsByProfile(
            rawTikTokProfiles as Record<string, unknown>[],
          );
          onLog('👤 STEP 2/4 ✓ — ' + rawTikTokProfiles.length + ' raw items → ' + normalizedProfiles.length + ' unique profiles');
        } catch (e: unknown) {
          const errMsg2 = e instanceof Error ? e.message : String(e);
          if (errMsg2.startsWith('APIFY_QUOTA_EXCEEDED')) {
            onLog('[ENGINE] ⛔ Apify quota agotada — ' + errMsg2.replace('APIFY_QUOTA_EXCEEDED: ', '') + ' Abortando inmediatamente.');
            break;
          }
          // 403 insufficient-permissions or other scraper error → snippet fallback
          if (errMsg2.startsWith('APIFY_ACTOR_FORBIDDEN')) {
            ttScraperConsecFails++;
            if (ttScraperConsecFails >= 2) {
              skipTtScraper = true;
              onLog('👤 STEP 2/4 ⚠ TikTok scraper: 2 consecutive 403s — activando modo snippets para el resto de la sesión.');
            } else {
              onLog('👤 STEP 2/4 ⚠ TikTok scraper 403 (#' + ttScraperConsecFails + ') — usando snippets este attempt.');
            }
          } else {
            onLog('👤 STEP 2/4 ✗ TikTok scraper error — usando snippets este attempt: ' + errMsg2);
          }
          // Fall back to snippet profiles instead of skipping the whole attempt
          normalizedProfiles = this.buildProfilesFromSnippets(ttBatch, handleToSnippet, handleToTitle);
          onLog('👤 STEP 2/4 — ' + normalizedProfiles.length + ' profiles from Google snippets (fallback)');
        }
      }

      // ── STEP 3: Hard ICP filter ──────────────────────────────────────────────
      onLog('🔍 STEP 3/4 — Applying hard ICP filters (' + normalizedProfiles.length + ' profiles)...');
      const hardFiltered = icpEvaluator.applyHardFilter(
        normalizedProfiles as unknown as RawApifyProfile[],
        onLog,
        'faceless_clipper',
      );
      onLog('[HARD FILTER] ' + normalizedProfiles.length + ' → ' + hardFiltered.length + ' passed');

      if (!hardFiltered.length) { onLog('⚠ Ningún perfil pasó el hard filter. Rotando query...'); continue; }

      // ── STEP 3a: Lean Content Analysis (inline, Pilar velocidad) ────────────
      // Extract latestVideos from normalized profiles and pass to ContentVerificationService
      // as prefetched items — zero extra Apify calls.
      // Profiles that fail content verification are skipped before email discovery or AI.
      onLog('🎬 STEP 3a — Lean Content Analysis (últimos 3 videos, 0 Apify extra)...');
      const contentPassedProfiles: typeof normalizedProfiles[number][] = [];

      for (const profile of normalizedProfiles) {
        if (!this.isRunning) break;
        if (!hardFiltered.find(h => h.username === profile.username)) continue; // didn't pass hard filter

        const extProfile = profile as typeof profile & { _latestVideos: { thumbnailUrl: string; desc: string }[] };
        const latestVideos = extProfile._latestVideos || [];

        if (!latestVideos.length) {
          // No video data available → pass through (benefit of the doubt)
          contentPassedProfiles.push(profile);
          continue;
        }

        const prefetchedItems: VideoItem[] = latestVideos.map(v => ({
          thumbnailUrl: v.thumbnailUrl,
          transcript: v.desc || undefined,
          platform: 'tiktok' as const,
        }));

        try {
          const result = await contentVerificationService.verifyCreatorContent(
            profile.username,
            'tiktok',
            'faceless_clipper',
            prefetchedItems,
          );
          if (result.is_icp_match) {
            contentPassedProfiles.push(profile);
            onLog(`[LEAN CONTENT] ✓ @${profile.username} — score ${result.overall_score} — ${result.reasoning}`);
          } else {
            onLog(`[LEAN CONTENT] ✗ @${profile.username} — score ${result.overall_score} — ${result.reasoning} — SKIP`);
          }
        } catch (e: unknown) {
          // ContentVerification error → pass through
          contentPassedProfiles.push(profile);
          onLog(`[LEAN CONTENT] ⚠ @${profile.username} — verification error, passing by default`);
        }
      }

      onLog('[LEAN CONTENT] ' + contentPassedProfiles.length + '/' + hardFiltered.length + ' pasaron verificación de contenido');
      if (!contentPassedProfiles.length) { onLog('⚠ Ningún perfil pasó Lean Content Analysis. Rotando query...'); continue; }

      // Build candidate Lead objects
      const candidates: Lead[] = [];
      for (const profile of contentPassedProfiles) {
        if (!this.isRunning) break;
        const handle = profile.username;
        if (!handle) continue;

        const followers = profile.followersCount || 0;
        const bio = profile.biography || '';
        const fullName = profile.fullName || '';
        const emailFromBio = this.extractEmailFromBio(bio);
        const emailFromApify = ((profile.publicEmail as string) || '').toLowerCase().trim();
        const email = emailFromBio || emailFromApify;
        const website = ((profile.externalUrl as string) || '').trim();
        const niche = this.detectNiche(bio, handle, fullName);
        const regionRaw = (profile.country as string) || '';

        if (followers < minFollowers) { onLog('[ICP] ↓ @' + handle + ' — ' + this.formatFollowers(followers) + ' < ' + this.formatFollowers(minFollowers)); continue; }
        if (followers > maxFollowers) { onLog('[ICP] ↑ @' + handle + ' — ' + this.formatFollowers(followers) + ' > ' + this.formatFollowers(maxFollowers)); continue; }

        if (targetRegions.length > 0) {
          const locationStr = [(profile.country as string) || '', (profile.countryCode as string) || '']
            .map(v => v.toLowerCase()).join(' ');
          if (locationStr.trim()) {
            const matchesRegion = targetRegions.some(r => {
              const patterns = REGION_MAP[r] ?? [r.toLowerCase()];
              return patterns.some(pat => locationStr.includes(pat));
            });
            if (!matchesRegion) { onLog('[ICP] 🌍 @' + handle + ' — "' + regionRaw + '" not in [' + targetRegions.join(', ') + ']'); continue; }
          }
        }

        candidates.push({
          id: 'tt-' + handle + '-' + Date.now(),
          source: 'tiktok',
          ig_handle: handle,
          follower_count: followers,
          niche,
          audience_tier: this.detectAudienceTier(followers),
          location: regionRaw,
          website,
          decisionMaker: {
            name: fullName || '@' + handle,
            role: 'Content Creator',
            email,
            instagram: 'https://tiktok.com/@' + handle,
          },
          aiAnalysis: {
            summary: bio, painPoints: [], generatedIcebreaker: '',
            coldEmailSubject: '', coldEmailBody: '', vslPitch: '',
            fullAnalysis: '', psychologicalProfile: '', engagementSignal: '', salesAngle: '',
          },
          vsl_sent_status: 'pending',
          email_status: 'pending',
          status: 'scraped',
          _icpType: 'faceless_clipper',
        });
      }

      onLog('[FUNNEL] ' + candidates.length + '/' + contentPassedProfiles.length + ' pasaron filtros de seguidor/región');
      if (!candidates.length) { onLog('⚠ Ningún candidato pasó los filtros ICP. Rotando query...'); continue; }

      // DB-level dedup
      const acceptedHandles = new Set(accepted.map(l => l.ig_handle || ''));
      const notYetAccepted = candidates.filter(c => !acceptedHandles.has(c.ig_handle || ''));
      const dbDeduped = deduplicationService.filterUniqueCandidates(notYetAccepted, existingIgHandles, existingEmails);
      onLog('[DEDUP] ' + dbDeduped.length + '/' + notYetAccepted.length + ' son nuevos (no están en la BD)');
      if (!dbDeduped.length) { onLog('⚠ Todos los candidatos ya existen en la BD. Rotando query...'); continue; }

      // ── STEP 3b: Email discovery (TikTok) ───────────────────────────────────
      const slotsRemaining = targetCount - accepted.length;
      const toDiscover = dbDeduped.slice(0, Math.max(slotsRemaining * 8, dbDeduped.length));
      onLog('📧 STEP 3b — Email discovery (TikTok) para ' + toDiscover.length + ' candidatos...');
      await Promise.all(this.chunkArray(toDiscover, 10).map(async (chunk) => {
        await Promise.all(chunk.map(async (lead) => {
          if (!this.isRunning) return;
          const discovered = await emailDiscoveryService.discoverEmailForTikTok(
            lead.decisionMaker?.email || '',
            lead.website || '',
            lead.ig_handle || '',
            onLog,
          );
          if (discovered && lead.decisionMaker) lead.decisionMaker.email = discovered;
        }));
      }));
      const withEmail = toDiscover.filter(l => l.decisionMaker?.email);
      onLog('📧 STEP 3b ✓ — ' + withEmail.length + '/' + toDiscover.length + ' tienen email');

      if (!withEmail.length) { onLog('⚠ Ningún candidato tiene email. Rotando query...'); continue; }

      // ── STEP 4a: AI Soft Filter ───────────────────────────────────────────────
      onLog('🤖 STEP 4a — Filtro IA para ' + withEmail.length + ' candidatos (verificando ICP faceless)...');
      const softFiltered = await icpEvaluator.applySoftFilter(withEmail, onLog, 'faceless_clipper');
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
      onLog('✍ STEP 4b — Generando análisis IA (batch) para ' + toProcess.length + ' creadores TikTok...');
      await this.generateCreatorAnalysisBatch(toProcess, onLog);

      // Stream leads to UI and accept (Pilar 4: Streaming)
      for (const lead of toProcess) {
        if (!this.isRunning) break;
        lead.status = 'pending_content_verification';
        lead._icpType = 'faceless_clipper';
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
      onLog('[ENGINE] ✅ Target reached: ' + accepted.length + '/' + targetCount + ' TikTok creators found in ' + attempt + ' attempts.');
    } else {
      onLog('[ENGINE] ⚠ Máx intentos (' + MAX_RETRIES + ') alcanzado. Encontrados ' + accepted.length + '/' + targetCount + '.');
    }

    await this.sendLeadsToInstantly(accepted, onLog, instantlyCampaignId);
    onComplete(accepted);
  }
}

export const tikTokFacelessEngine = new TikTokFacelessEngine();
