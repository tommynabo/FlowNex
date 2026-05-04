/**
 * ContentVerificationService
 *
 * Deep "lean" content analysis for Instagram and TikTok creators.
 * Instead of downloading video files, it:
 *   1. Scrapes the 3 most recent post thumbnails + captions/descriptions via Apify
 *   2. Feeds each (image + text) pair to GPT-4o-mini vision
 *   3. Returns an averaged content_alignment_score (0–100) and is_icp_match boolean
 *
 * This service is intentionally decoupled from the main SearchService so it can be
 * called asynchronously from the Vercel cron job (/api/cron/content-verification).
 */

import { ICPType, VideoItem, ContentVerificationResult } from '../../lib/types';

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of videos/posts to analyze per creator (cost control) */
const MAX_VIDEOS_TO_ANALYZE = 3;

/** Minimum score (0–100) for a creator to be considered an ICP match */
export const CONTENT_SCORE_THRESHOLD = 65;

/** Apify actor IDs */
const INSTAGRAM_POSTS_SCRAPER = 'apify~instagram-scraper';
const TIKTOK_PROFILE_SCRAPER  = 'clockworks~free-tiktok-scraper';

// ── Internal types ────────────────────────────────────────────────────────────

interface SingleVideoAnalysis {
  content_alignment_score: number;
  is_icp_match: boolean;
  reasoning: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** All Apify calls go through /api/apify (Vercel serverless — token never hits the browser) */
async function apifyRequest(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
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

/** Start an Apify actor, poll until SUCCEEDED, return dataset items */
async function callApifyActor(actorId: string, input: unknown): Promise<unknown[]> {
  const startData = await apifyRequest(`acts/${actorId}/runs`, 'POST', input) as {
    data?: { id?: string; defaultDatasetId?: string };
  };
  const runId    = startData.data?.id;
  const datasetId = startData.data?.defaultDatasetId;
  if (!runId || !datasetId) throw new Error(`Apify: missing runId or datasetId for ${actorId}`);

  let done = false;
  let polls = 0;
  while (!done && polls < 120) {
    await new Promise(r => setTimeout(r, 5000));
    polls++;
    const sd = await apifyRequest(`acts/${actorId}/runs/${runId}`, 'GET') as {
      data?: { status?: string };
    };
    const status = sd.data?.status ?? '';
    if (status === 'SUCCEEDED') { done = true; break; }
    if (status === 'FAILED' || status === 'ABORTED') throw new Error(`Actor ${actorId} ${status}`);
  }
  if (!done) throw new Error(`Apify actor ${actorId} timed out after ${polls * 5}s`);

  const items = await apifyRequest(`datasets/${datasetId}/items`, 'GET') as unknown[];
  if (!Array.isArray(items)) throw new Error('Apify dataset is not an array');
  return items;
}

// ── Core Service Class ────────────────────────────────────────────────────────

export class ContentVerificationService {

  // ── Scrapers ────────────────────────────────────────────────────────────────

  /**
   * Fetch up to 3 recent Instagram posts per handle.
   * Uses the instagram-scraper actor (same one as the existing post vision check).
   * Returns a map: handle → VideoItem[]
   */
  async scrapeInstagramPosts(handles: string[]): Promise<Map<string, VideoItem[]>> {
    const result = new Map<string, VideoItem[]>();
    if (!handles.length) return result;

    const items = await callApifyActor(INSTAGRAM_POSTS_SCRAPER, {
      directUrls: handles.map(h => `https://www.instagram.com/${h}/`),
      resultsType: 'posts',
      resultsLimit: 3,
    });

    for (const item of items as Record<string, unknown>[]) {
      const owner = ((item.ownerUsername as string) || '').toLowerCase().trim();
      if (!owner) continue;
      const caption = ((item.caption as string) || '').substring(0, 800);
      const thumbnailUrl = (item.displayUrl as string) || (item.thumbnailUrl as string) || '';
      const existing = result.get(owner) ?? [];
      if (existing.length < MAX_VIDEOS_TO_ANALYZE) {
        existing.push({ thumbnailUrl, transcript: caption || undefined, platform: 'instagram' });
        result.set(owner, existing);
      }
    }
    return result;
  }

  /**
   * Fetch up to 3 recent TikTok posts per username.
   * The clockworks~free-tiktok-scraper returns profile data + a latestVideos array.
   * We extract cover + text from the latestVideos field.
   * Returns a map: handle → VideoItem[]
   */
  async scrapeTikTokPosts(handles: string[]): Promise<Map<string, VideoItem[]>> {
    const result = new Map<string, VideoItem[]>();
    if (!handles.length) return result;

    // maxItems=3 requests only the profile + first 3 video entries
    const items = await callApifyActor(TIKTOK_PROFILE_SCRAPER, {
      usernames: handles,
      maxItems: 3,
    });

    for (const rawItem of items as Record<string, unknown>[]) {
      // The actor returns one object per username with a latestVideos[] array
      const username = (
        (rawItem.uniqueId as string) ||
        (rawItem.username as string) ||
        ''
      ).toLowerCase().trim();
      if (!username) continue;

      const latestVideos = (rawItem.latestVideos as Record<string, unknown>[]) ?? [];
      // Fallback: actor may return one object per video (video-feed mode)
      const videoObjects = latestVideos.length > 0 ? latestVideos : [rawItem];

      const entries: VideoItem[] = [];
      for (const v of videoObjects.slice(0, MAX_VIDEOS_TO_ANALYZE)) {
        const thumbnailUrl = (
          (v.coverUrl as string) ||
          (v.cover as string) ||
          (v.originCover as string) ||
          (rawItem.avatarMedium as string) || // last resort: avatar
          ''
        );
        const transcript = (
          (v.text as string) ||
          (v.desc as string) ||
          (v.title as string) ||
          ''
        ).substring(0, 800) || undefined;
        entries.push({ thumbnailUrl, transcript, platform: 'tiktok' });
      }
      if (entries.length > 0) result.set(username, entries);
    }
    return result;
  }

  // ── Analysis ────────────────────────────────────────────────────────────────

  /**
   * Analyze a single video item (thumbnail + transcript) against an ICP archetype.
   * Uses GPT-4o-mini with vision (cost-effective alternative to full gpt-4o).
   *
   * Falls back gracefully:
   *   - No thumbnail AND no transcript → score 50, pass by default
   *   - API failure                    → score 50, pass by default (never block on infra)
   */
  async analyzeVideoContent(
    item: VideoItem,
    icpType: ICPType,
  ): Promise<SingleVideoAnalysis> {
    // No data at all → pass by default.
    // Score 70 (above CONTENT_SCORE_THRESHOLD=65) ensures the aggregated average
    // also passes when ALL items have no data — prevents false negatives.
    if (!item.thumbnailUrl && !item.transcript) {
      return { content_alignment_score: 70, is_icp_match: true, reasoning: 'No data available — passed by default' };
    }

    const systemPrompt = this.buildSystemPrompt(icpType);
    const userText = [
      `Platform: ${item.platform}`,
      item.transcript ? `Caption/transcript: ${item.transcript}` : '(no text available)',
    ].join('\n');

    const contentParts: unknown[] = [{ type: 'text', text: userText }];
    if (item.thumbnailUrl) {
      contentParts.push({ type: 'image_url', image_url: { url: item.thumbnailUrl } });
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch('/api/openai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: contentParts },
            ],
            temperature: 0.2,
            max_tokens: 120,
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const raw = data.choices?.[0]?.message?.content || '';
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as Partial<SingleVideoAnalysis>;
          const score = Math.max(0, Math.min(100, Number(parsed.content_alignment_score) || 50));
          return {
            content_alignment_score: score,
            is_icp_match: score >= CONTENT_SCORE_THRESHOLD,
            reasoning: String(parsed.reasoning || '').substring(0, 300),
          };
        }
      } catch {
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
      }
    }
    // API failure → pass by default
    return { content_alignment_score: 50, is_icp_match: true, reasoning: 'Vision API unavailable — passed by default' };
  }

  /**
   * Full verification pipeline for one creator.
   *
   * If `prefetchedItems` are provided (collected during the search loop and stored
   * in lead._videoItemsForVerification), they are used directly — no extra Apify call.
   * Otherwise, posts are fetched fresh based on the creator's platform + handle.
   */
  async verifyCreatorContent(
    handle: string,
    platform: 'instagram' | 'tiktok',
    icpType: ICPType,
    prefetchedItems?: VideoItem[],
  ): Promise<ContentVerificationResult> {
    // 1. Collect video items
    let items: VideoItem[];
    if (prefetchedItems && prefetchedItems.length > 0) {
      items = prefetchedItems.slice(0, MAX_VIDEOS_TO_ANALYZE);
    } else {
      const postsMap = platform === 'tiktok'
        ? await this.scrapeTikTokPosts([handle])
        : await this.scrapeInstagramPosts([handle]);
      items = (postsMap.get(handle) ?? []).slice(0, MAX_VIDEOS_TO_ANALYZE);
    }

    // 2. No items found → pass by default
    if (!items.length) {
      return {
        overall_score: 50,
        is_icp_match: true,
        analyzed_videos: 0,
        analyzed_at: new Date().toISOString(),
        reasoning: 'No posts/videos found — passed by default',
      };
    }

    // 3. Analyze all items in parallel
    const analyses = await Promise.all(
      items.map(item => this.analyzeVideoContent(item, icpType)),
    );

    // 4. Average score
    const overall_score = Math.round(
      analyses.reduce((sum, a) => sum + a.content_alignment_score, 0) / analyses.length,
    );
    const reasonings = analyses.map((a, i) => `Video ${i + 1}: ${a.reasoning}`).join(' | ');

    return {
      overall_score,
      is_icp_match: overall_score >= CONTENT_SCORE_THRESHOLD,
      analyzed_videos: analyses.length,
      analyzed_at: new Date().toISOString(),
      reasoning: reasonings.substring(0, 600),
    };
  }

  // ── Prompt Builder ───────────────────────────────────────────────────────────

  private buildSystemPrompt(icpType: ICPType): string {
    const facelessCriteria = `
CRITICAL REJECTION CRITERIA (ANTI-ICP): Score 0 immediately if the content shows:
- Food, restaurant, cafe, acai/smoothie/juice brand, retail store, or physical product promotion
- Traditional life coaching sessions (non-fitness, non-digital), HR/corporate consulting content
- Standard personal lifestyle vlogs (selfies, food, travel, pets) with zero hustle/wealth/entrepreneurship angle
If ANY of these apply, return content_alignment_score: 0 and is_icp_match: false.

APPROVE (score ≥ 65) if the content matches ANY of these patterns:
- Faceless motivation: no face shown, voiceover + b-roll, discipline, entrepreneurship, self-improvement
- Clipper/reposter: edited clips from known figures (Hormozi, Tate, Gadzhi, Goggins, etc.)
- Slideshow/carousel: motivational quotes, mindset tips, wealth/success, hustle, grind culture
- Gym motivation: body transformation, before/after physique, "no days off", "no excuses" WITH motivational message
- Online business tips: passive income, make money online, dropshipping, SMMA, agency growth, wifi money

REJECT (score < 65) if the majority of content is:
- Personal face-forward lifestyle (selfies, daily vlogs, food/travel) with no motivational angle
- Pure gym tutorial/form-check by a certified trainer (educational instruction, NOT motivation)
- Entertainment, comedy, gaming, or niches unrelated to motivation/mindset/fitness/business`.trim();

    const personalBrandCriteria = `
APPROVE (score ≥ 65) if the content shows:
- Gym workouts, physique content, fitness demonstrations, workout tutorials
- Creator's face visible, personal training tips, body transformation journey
- Fitness lifestyle content, supplement reviews, gym equipment reviews

REJECT (score < 65) if the majority of content is:
- Completely unrelated to fitness/health/gym
- Pure motivational clips with no physical fitness element (that belongs to faceless_clipper)
- Brand/agency content with no individual creator presence`.trim();

    const criteria = icpType === 'faceless_clipper' ? facelessCriteria : personalBrandCriteria;

    return `You are a short-form content analyst for a creator outreach agency.
Evaluate the provided video thumbnail/frame and caption/transcript.
Determine if this content matches the "${icpType}" archetype.

${criteria}

Score guide: 0–40 = clearly wrong niche | 41–64 = borderline/uncertain | 65–84 = good match | 85–100 = perfect match

Respond ONLY with valid JSON, no markdown:
{"content_alignment_score": <0-100>, "is_icp_match": <true if score≥65>, "reasoning": "<one brief sentence>"}`;
  }
}

export const contentVerificationService = new ContentVerificationService();
