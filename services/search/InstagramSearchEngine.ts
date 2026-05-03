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

import { Lead, SearchConfigState, AudienceTier, ICPType } from '../../lib/types';
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
// Behavior-based dorks targeting motivational/clipper/faceless accounts.
// Avoids celebrity names (they surface official verified accounts instead of
// clipper pages). Uses engagement patterns to find page-owner profiles.
// Each inner array is one OR-group per search attempt.
const FACELESS_CLIPPER_KEYWORD_POOLS: string[][] = [
  ['"link in bio"', '"DM me"', '"mentorship"'],
  ['"wifi money"', '"daily clips"', '"wealth"'],
  ['"motivation"', '"hustle"', '"entrepreneur clips"'],
  ['"passive income"', '"financial freedom"', '"mindset"'],
  ['"make money online"', '"online business"', '"success"'],
  ['"daily motivation"', '"discipline"', '"self improvement"'],
  ['"motivational content"', '"entrepreneur mindset"'],
  ['"money mindset"', '"wealth mindset"', '"hustle culture"'],
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
// Fallback when both US and CA are targeted (or no region filter set)
const LOCATION_SUFFIXES_US_CA = [...LOCATION_SUFFIXES_US, ...LOCATION_SUFFIXES_CA];

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
const TIKTOK_PROFILE_SCRAPER = 'clockworks~tiktok-profile-scraper';
const INSTAGRAM_POSTS_SCRAPER = 'apify~instagram-scraper';

// TikTok URL path segments that are not profile pages
const TIKTOK_SKIP_HANDLES = new Set(['tag', 'search', 'discover', 'music', 'video', 'live', 'trending', 'foryou', 't']);

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
    const firstLoc = hasUS && hasCA ? 'USA OR Canada' : hasUS ? 'USA' : 'Canada';

    // Faceless & Clipper: build OR-group dorks — alternate Instagram / TikTok by attempt parity
    if (icpType === 'faceless_clipper') {
      const poolIdx = attempt <= 1 ? 0 : (attempt - 2) % keywordPool.length;
      const locIdx  = attempt <= 1 ? 0 : Math.floor((attempt - 2) / keywordPool.length) % locSuffixes.length;
      const terms = keywordPool[poolIdx];
      const orGroup = '(' + terms.join(' OR ') + ')';
      const loc = attempt === 1 ? firstLoc : locSuffixes[locIdx];
      // Odd attempts → Instagram, even → TikTok (multi-platform rotation)
      if (attempt % 2 !== 0) {
        return `site:instagram.com ${orGroup} ${loc} -site:instagram.com/p/ -site:instagram.com/reel/`;
      } else {
        return `site:tiktok.com ${orGroup} ${loc} -site:tiktok.com/tag/`;
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
    return location ? `site:instagram.com ${kw} ${location}` : `site:instagram.com ${kw}`;
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

    // Poll until done
    let done = false;
    let polls = 0;
    while (!done && this.isRunning && polls < 600) {
      await new Promise(r => setTimeout(r, 5000));
      polls++;
      try {
        const sd = await this.apifyRequest(`acts/${actorId}/runs/${runId}`, 'GET') as {
          data?: { status?: string };
        };
        const status = sd.data?.status ?? '';
        if (polls % 3 === 1) onLog('[APIFY] ' + status + ' (' + polls * 5 + 's)');
        if (status === 'SUCCEEDED') done = true;
        else if (status === 'FAILED' || status === 'ABORTED') throw new Error('Actor ' + status);
      } catch (pe: unknown) {
        const msg = pe instanceof Error ? pe.message : String(pe);
        if (msg.includes('FAILED') || msg.includes('ABORTED')) throw pe;
      }
    }

    if (!done) throw new Error('Apify timeout after ' + polls * 5 + 's');
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
    if (/fitness|gym|workout|bodybuilding|strength|crossfit/.test(text)) return 'Fitness';
    if (/yoga|meditation|mindfulness|wellness|breathwork/.test(text)) return 'Wellness';
    if (/nutrition|diet|healthyfood|mealprep|weightloss/.test(text)) return 'Nutrition';
    if (/mindset|personaldevelopment|selfimprovement|motivation|lifecoach/.test(text)) return 'Personal Dev';
    if (/entrepreneur|business|startup|marketing|sales/.test(text)) return 'Business';
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
   * Handles: "12.5K Followers", "2.3M Followers", "150,000 Followers", "850 followers"
   * Returns the count as a number, or null if the pattern is absent.
   */
  private extractFollowersFromSnippet(text: string): number | null {
    if (!text) return null;
    const m = text.match(/(\d[\d,.]*)([KkMm])?\s*[Ff]ollower/);
    if (!m) return null;
    const raw = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(raw)) return null;
    const suffix = m[2]?.toLowerCase();
    if (suffix === 'k') return Math.round(raw * 1_000);
    if (suffix === 'm') return Math.round(raw * 1_000_000);
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

  // ── Post Vision Verifier ──────────────────────────────────────────────────────

  /**
   * Fetches the 3 most recent posts for a batch of IG handles using the
   * instagram-scraper actor and builds a map handle → PostSummary[].
   * TikTok handles receive an empty array (their recent videos come from
   * the profile scraper via normalizeTikTokProfile, handled separately).
   */
  private async fetchRecentPosts(
    igHandles: string[],
    onLog: LogCallback,
  ): Promise<Map<string, { caption: string; isVideo: boolean; thumbnailUrl: string }[]>> {
    const result = new Map<string, { caption: string; isVideo: boolean; thumbnailUrl: string }[]>();
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
        const caption = ((item.caption as string) || '').substring(0, 400);
        const isVideo = ((item.type as string) || '').toLowerCase() === 'video';
        const thumbnailUrl = (item.displayUrl as string) || (item.thumbnailUrl as string) || '';
        const existing = result.get(owner) ?? [];
        if (existing.length < 3) {
          existing.push({ caption, isVideo, thumbnailUrl });
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
    posts: { caption: string; isVideo: boolean; thumbnailUrl: string }[],
    onLog: LogCallback,
  ): Promise<{ approved: boolean; reason: string; confidence: number }> {
    // No posts available → pass through (benefit of the doubt)
    if (!posts.length) {
      return { approved: true, reason: 'No posts available — passed by default', confidence: 50 };
    }

    const postsContext = posts.map((p, i) =>
      `Post ${i + 1}: type=${p.isVideo ? 'video' : 'image/carousel'}\nCaption: ${p.caption || '(no caption)'}`
    ).join('\n\n');

    const systemPrompt =
      'You are an expert content analyst for a creator outreach agency. ' +
      'Your task: decide if a creator\'s last 3 posts match the FACELESS / CLIPPER / MOTIVATIONAL content archetype.\n\n' +
      'APPROVE (approved=true) if AT LEAST 2 of the 3 posts are:\n' +
      '- Slideshow/carousel: motivational quotes, mindset tips, wealth/success content, gym motivation\n' +
      '- Clipper: edited clips from known figures (Hormozi, Tate, Gadzhi, etc.) or other motivational speakers\n' +
      '- Faceless motivation video: no face shown, voiceover + b-roll, entrepreneurship or self-improvement content\n' +
      '- Online business tips: passive income, make money online, dropshipping, smma, agency growth\n\n' +
      'REJECT (approved=false) if the majority of posts are:\n' +
      '- Personal lifestyle with face shown (selfies, vlogs, travel, food)\n' +
      '- Physical fitness/gym workout demonstrations by a trainer or athlete\n' +
      '- Entertainment, comedy, or completely unrelated niches\n\n' +
      'Reply ONLY with valid JSON, no markdown:\n' +
      '{"approved":true,"confidence":85,"reason":"2 of 3 are Hormozi clip carousels + mindset slideshows"}';

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
    const bioLink = p.bioLink as Record<string, unknown> | undefined;
    const website = (bioLink?.link as string) || (p.bioLink as string) || (p.website as string) || '';
    const regionCode = ((p.region as string) || '').toUpperCase();
    return {
      username: ((p.uniqueId as string) || (p.username as string) || '').toLowerCase(),
      followersCount: (p.fans as number) || (p.followerCount as number) || (p.follower_count as number) || 0,
      biography: ((p.signature as string) || (p.desc as string) || (p.bio as string) || ''),
      fullName: ((p.nickname as string) || (p.displayName as string) || (p.name as string) || ''),
      externalUrl: website,
      publicEmail: (p.email as string) || '',
      // Pass region so the US/CA location filter can match
      countryCode: regionCode,
      country: regionCode === 'US' ? 'United States' : regionCode === 'CA' ? 'Canada' : regionCode,
      // Tag so candidate-building section can set lead.source = 'tiktok'
      __platform: 'tiktok',
    } as RawApifyProfile;
  }

  // ── Public entry point ───────────────────────────────────────────────────────

  public async startSearch(
    config: SearchConfigState,
    onLog: LogCallback,
    onComplete: ResultCallback,
    userId?: string | null,
  ): Promise<void> {
    this.isRunning = true;
    this.userId = userId ?? null;
    try {
      onLog('[INIT] Apify: via /api/apify (serverless proxy)');
      onLog('[INIT] UserId: ' + (this.userId || 'not authenticated'));
      onLog('[INIT] Source: ' + config.source + ' | Query: "' + config.query + '" | Target: ' + config.maxResults);

      onLog('[DEDUP] Loading existing leads from database...');
      const { existingIgHandles, existingEmails } = await deduplicationService.fetchExistingLeads(this.userId);
      onLog('[DEDUP] Pre-flight: ' + existingIgHandles.size + ' IG handles, ' + existingEmails.size + ' emails already in DB');

      await this.runSearchLoop(config, existingIgHandles, existingEmails, onLog, onComplete, config.instantlyCampaignId);
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
    // This ensures a US-only campaign never rotates into Canadian location suffixes.
    const onlyUS = targetRegions.length > 0 && targetRegions.every(r => r === 'US');
    const onlyCA = targetRegions.length > 0 && targetRegions.every(r => r === 'CA');
    const activeLocationSuffixes = onlyUS ? LOCATION_SUFFIXES_US
      : onlyCA ? LOCATION_SUFFIXES_CA
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
      let searchResults: unknown[];
      try {
        searchResults = await this.callApifyActor(GOOGLE_SEARCH_SCRAPER, {
          queries: searchQuery,
          maxPagesPerQuery: 1,
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
      for (const item of uniqueRawHandles.slice(0, Math.min(50, needed * 5))) {
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
      const igHandles = novelHandles.filter(h => h.platform === 'instagram').map(h => h.handle);
      const ttHandles = novelHandles.filter(h => h.platform === 'tiktok').map(h => h.handle);
      onLog(`👤 STEP 2/4 — Fetching profiles: ${igHandles.length} Instagram, ${ttHandles.length} TikTok`);
      let profiles: unknown[];
      try {
        const scrapePromises: Promise<unknown[]>[] = [];
        if (igHandles.length > 0) {
          scrapePromises.push(
            this.callApifyActor(INSTAGRAM_PROFILE_SCRAPER, { usernames: igHandles }, onLog),
          );
        }
        if (ttHandles.length > 0 && icpType === 'faceless_clipper') {
          scrapePromises.push(
            this.callApifyActor(
              TIKTOK_PROFILE_SCRAPER,
              { profiles: ttHandles.map(h => `https://www.tiktok.com/@${h}`) },
              onLog,
            ).then(ttProfiles =>
              (ttProfiles as Record<string, unknown>[]).map(p => this.normalizeTikTokProfile(p)),
            ),
          );
        }
        const results = await Promise.all(scrapePromises);
        profiles = results.flat();
      } catch (e: unknown) {
        onLog('👤 STEP 2/4 ✗ Profile scraper error: ' + (e instanceof Error ? e.message : String(e)));
        // Don't count as zero — we did get handles, scraper just failed temporarily
        continue;
      }
      onLog('👤 STEP 2/4 ✓ — ' + profiles.length + ' profiles received');

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

      // ── STEP 3c: Post Vision Verifier (faceless_clipper only) ────────────────
      // Fetch the 3 most recent posts and use GPT-4o vision to verify that at
      // least 2 match the clipper/faceless/motivational archetype BEFORE spending
      // credits on email discovery or AI analysis.
      let postVerifiedCandidates = dbDeduped;
      if (icpType === 'faceless_clipper') {
        const igCandidates = dbDeduped.filter(l => l.source !== 'tiktok');
        const ttCandidates = dbDeduped.filter(l => l.source === 'tiktok');
        const igHandlesForPosts = igCandidates.map(l => l.ig_handle || '').filter(Boolean);

        onLog(`🎬 STEP 3c — Post vision: verificando ${dbDeduped.length} candidatos (últimos 3 posts)...`);

        // Fetch recent posts for IG handles in one batch call
        const postsMap = igHandlesForPosts.length > 0
          ? await this.fetchRecentPosts(igHandlesForPosts, onLog)
          : new Map<string, { caption: string; isVideo: boolean; thumbnailUrl: string }[]>();

        // Analyze IG candidates in chunks of 5 to avoid OpenAI rate limits
        const igVerified: typeof dbDeduped = [];
        for (const chunk of this.chunkArray(igCandidates, 5)) {
          if (!this.isRunning) break;
          await Promise.all(chunk.map(async (lead) => {
            if (!this.isRunning) return;
            const handle = lead.ig_handle || '';
            const posts = postsMap.get(handle) ?? [];
            const result = await this.analyzePostsForFacelessICP(handle, posts, onLog);
            if (result.approved) {
              onLog(`[POST VISION] ✓ @${handle} — "${result.reason}" (${result.confidence}%)`);
              igVerified.push(lead);
            } else {
              onLog(`[POST VISION] ✗ @${handle} — "${result.reason}"`);
            }
          }));
        }

        // TikTok candidates pass through without post-fetch (latestVideos already in profile)
        postVerifiedCandidates = [...igVerified, ...ttCandidates];
        onLog(`[POST VISION] Resultado: ${postVerifiedCandidates.length}/${dbDeduped.length} pasan verificación de posts`);

        if (!postVerifiedCandidates.length) {
          onLog('⚠ Ningún candidato pasó la verificación de posts. Rotando query...');
          continue;
        }
      }

      // ── STEP 3b: Email discovery FIRST — no email = skip AI credits ──────────
      // Rule: discover email before spending OpenAI tokens. Only leads WITH email
      // proceed to ICP soft filter and AI analysis.
      const slotsRemaining = targetCount - accepted.length;
      const toDiscover = postVerifiedCandidates.slice(0, Math.max(slotsRemaining * 8, postVerifiedCandidates.length));
      onLog('📧 STEP 3b — Email discovery para ' + toDiscover.length + ' candidatos (antes de gastar IA)...');
      for (const chunk of this.chunkArray(toDiscover, 8)) {
        if (!this.isRunning) break;
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
      }
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

      // Accept only leads that passed ICP (all already have email at this point)
      const toProcess = toEvaluate.slice(0, slotsRemaining);
      onLog('📧 STEP 4a ✓ — ' + toProcess.length + ' leads con email + ICP verificado listos para análisis IA');

      if (!toProcess.length) {
        onLog('⚠ Ningún candidato ICP verificado en este batch. Rotando query...');
        continue;
      }

      // ── STEP 4b: AI analysis for ICP-verified leads with email ───────────────
      onLog('✍ STEP 4b — Generando análisis IA para ' + toProcess.length + ' creadores (con email + ICP ✓)...');
      const analyzed: Lead[] = [];
      for (const chunk of this.chunkArray(toProcess, 5)) {
        if (!this.isRunning) break;
        const chunkResults = await Promise.all(chunk.map(async (lead) => {
          if (!this.isRunning) return null;
          try {
            const a = await this.generateCreatorAnalysis(lead);
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
            lead.status = 'ready';
          } catch {
            lead.status = 'ready';
          }
          return lead;
        }));
        analyzed.push(...chunkResults.filter((l): l is Lead => l !== null));
      }

      // Accept all analyzed leads (with or without email)
      for (const lead of analyzed) {
        accepted.push(lead);
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
  private parseKeywordsFromQuery(_query: string): string[] {
    // Always use fitness/gym base keywords — target is gym/fitness creators only
    // The keyword pool handles all variation via KEYWORD_POOLS rotation
    return ['fitness coach', 'personal trainer'];
  }
}

export const instagramSearchEngine = new InstagramSearchEngine();
