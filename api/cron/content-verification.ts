import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import type { ICPType, VideoItem, Lead, ContentVerificationResult } from '../../lib/types';

/**
 * Vercel Cron Job: /api/cron/content-verification
 * Schedule: every 10 minutes (see vercel.json)
 *
 * Picks up leads with status 'pending_content_verification', runs deep
 * multimodal analysis (thumbnail + caption → GPT-4o-mini vision), then
 * transitions each lead to 'ready' (score ≥ 65) or 'discarded' (score < 65).
 *
 * Auth:
 *   - Vercel cron calls automatically include the x-vercel-cron header.
 *   - External/manual calls must include: Authorization: Bearer <CRON_SECRET>
 */

// ── Config ───────────────────────────────────────────────────────────────────

const SCORE_THRESHOLD     = 65;
const MAX_VIDEOS_PER_LEAD = 3;
const BATCH_SIZE          = 5;   // leads processed per cron invocation (controls cost + duration)

const INSTAGRAM_POSTS_SCRAPER = 'apify~instagram-scraper';
const TIKTOK_PROFILE_SCRAPER  = 'clockworks~free-tiktok-scraper';

// ── Supabase (server-side — uses service role key for cron writes) ───────────

function getSupabase() {
  const url    = process.env.VITE_SUPABASE_URL    || process.env.SUPABASE_URL    || '';
  const key    = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Supabase URL or key not configured');
  return createClient(url, key);
}

// ── Apify helpers ─────────────────────────────────────────────────────────────

const APIFY_BASE = 'https://api.apify.com/v2';

async function apifyPost(path: string, body: unknown, token: string): Promise<unknown> {
  const res = await fetch(`${APIFY_BASE}/${path}?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Apify POST ${path} → HTTP ${res.status}`);
  return res.json();
}

async function apifyGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${APIFY_BASE}/${path}?token=${token}`);
  if (!res.ok) throw new Error(`Apify GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function runApifyActor(actorId: string, input: unknown, token: string): Promise<unknown[]> {
  const start = await apifyPost(`acts/${actorId}/runs`, input, token) as {
    data?: { id?: string; defaultDatasetId?: string };
  };
  const runId     = start.data?.id;
  const datasetId = start.data?.defaultDatasetId;
  if (!runId || !datasetId) throw new Error(`Apify: missing runId/datasetId for ${actorId}`);

  // Poll until SUCCEEDED (max 10 min to stay under Vercel function timeout)
  let done = false;
  let polls = 0;
  while (!done && polls < 120) {
    await new Promise(r => setTimeout(r, 5000));
    polls++;
    const sd = await apifyGet(`acts/${actorId}/runs/${runId}`, token) as {
      data?: { status?: string };
    };
    const status = sd.data?.status ?? '';
    if (status === 'SUCCEEDED') { done = true; break; }
    if (status === 'FAILED' || status === 'ABORTED') throw new Error(`Actor ${actorId} ${status}`);
  }
  if (!done) throw new Error(`Apify actor ${actorId} timed out`);

  const items = await apifyGet(`datasets/${datasetId}/items`, token) as unknown[];
  return Array.isArray(items) ? items : [];
}

// ── Video item scrapers ───────────────────────────────────────────────────────

async function scrapeInstagramPosts(handles: string[], token: string): Promise<Map<string, VideoItem[]>> {
  const result = new Map<string, VideoItem[]>();
  if (!handles.length) return result;

  const items = await runApifyActor(INSTAGRAM_POSTS_SCRAPER, {
    directUrls: handles.map(h => `https://www.instagram.com/${h}/`),
    resultsType: 'posts',
    resultsLimit: 3,
  }, token);

  for (const item of items as Record<string, unknown>[]) {
    const owner = ((item.ownerUsername as string) || '').toLowerCase().trim();
    if (!owner) continue;
    const caption      = ((item.caption as string) || '').substring(0, 800);
    const thumbnailUrl = (item.displayUrl as string) || (item.thumbnailUrl as string) || '';
    const existing     = result.get(owner) ?? [];
    if (existing.length < MAX_VIDEOS_PER_LEAD) {
      existing.push({ thumbnailUrl, transcript: caption || undefined, platform: 'instagram' });
      result.set(owner, existing);
    }
  }
  return result;
}

async function scrapeTikTokPosts(handles: string[], token: string): Promise<Map<string, VideoItem[]>> {
  const result = new Map<string, VideoItem[]>();
  if (!handles.length) return result;

  const items = await runApifyActor(TIKTOK_PROFILE_SCRAPER, {
    usernames: handles,
    maxItems: 3,
  }, token);

  for (const rawItem of items as Record<string, unknown>[]) {
    const username = (
      (rawItem.uniqueId as string) ||
      (rawItem.username as string) ||
      ''
    ).toLowerCase().trim();
    if (!username) continue;

    const latestVideos  = (rawItem.latestVideos as Record<string, unknown>[]) ?? [];
    const videoObjects  = latestVideos.length > 0 ? latestVideos : [rawItem];
    const entries: VideoItem[] = [];

    for (const v of videoObjects.slice(0, MAX_VIDEOS_PER_LEAD)) {
      const thumbnailUrl = (
        (v.coverUrl as string) ||
        (v.cover    as string) ||
        (v.originCover as string) ||
        (rawItem.avatarMedium as string) ||
        ''
      );
      const transcript = (
        (v.text  as string) ||
        (v.desc  as string) ||
        (v.title as string) ||
        ''
      ).substring(0, 800) || undefined;
      entries.push({ thumbnailUrl, transcript, platform: 'tiktok' });
    }
    if (entries.length > 0) result.set(username, entries);
  }
  return result;
}

// ── OpenAI vision analysis ────────────────────────────────────────────────────

function buildSystemPrompt(icpType: ICPType): string {
  const facelessCriteria = `
APPROVE (score ≥ 65) if the content matches ANY of these patterns:
- Faceless motivation: no face shown, voiceover + b-roll, discipline, entrepreneurship, self-improvement
- Clipper/reposter: edited clips from known figures (Hormozi, Tate, Gadzhi, Goggins, etc.)
- Slideshow/carousel: motivational quotes, mindset tips, wealth/success, hustle, grind culture
- Gym motivation: body transformation, before/after physique, "no days off" WITH motivational message
- Online business tips: passive income, make money online, dropshipping, SMMA, wifi money

REJECT (score < 65) if the majority of content is:
- Personal face-forward lifestyle (selfies, vlogs, food/travel) with no motivational angle
- Pure gym tutorial/form-check by a certified trainer (educational, NOT motivational)
- Entertainment, comedy, gaming, or niches unrelated to motivation/mindset/fitness/business`.trim();

  const personalBrandCriteria = `
APPROVE (score ≥ 65) if the content shows:
- Gym workouts, physique content, fitness demonstrations, workout tutorials
- Creator's face visible, personal training tips, body transformation

REJECT (score < 65) if the majority of content is:
- Completely unrelated to fitness/health/gym
- Brand/agency content with no individual creator presence`.trim();

  const criteria = icpType === 'faceless_clipper' ? facelessCriteria : personalBrandCriteria;

  return `You are a short-form content analyst for a creator outreach agency.
Evaluate the provided video thumbnail and caption/transcript.
Determine if this content matches the "${icpType}" archetype.

${criteria}

Score guide: 0–40 = wrong niche | 41–64 = borderline | 65–84 = good match | 85–100 = perfect match

Respond ONLY with valid JSON, no markdown:
{"content_alignment_score": <0-100>, "is_icp_match": <true if score≥65>, "reasoning": "<one brief sentence>"}`;
}

async function analyzeVideoItem(
  item: VideoItem,
  icpType: ICPType,
  openaiKey: string,
): Promise<{ score: number; reasoning: string }> {
  // No data at all → neutral pass
  if (!item.thumbnailUrl && !item.transcript) {
    return { score: 50, reasoning: 'No data — passed by default' };
  }

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
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: buildSystemPrompt(icpType) },
            { role: 'user',   content: contentParts },
          ],
          temperature: 0.2,
          max_tokens: 120,
        }),
      });
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const raw   = data.choices?.[0]?.message?.content || '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as Record<string, unknown>;
        const score  = Math.max(0, Math.min(100, Number(parsed.content_alignment_score) || 50));
        return { score, reasoning: String(parsed.reasoning || '').substring(0, 250) };
      }
    } catch {
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
    }
  }
  // API failure → pass by default
  return { score: 50, reasoning: 'Vision API unavailable — passed by default' };
}

async function verifyLead(
  lead: Lead,
  apifyToken: string,
  openaiKey: string,
): Promise<ContentVerificationResult> {
  const handle   = lead.ig_handle || '';
  const platform = lead.source as 'instagram' | 'tiktok';
  const icpType: ICPType  = lead._icpType ?? 'faceless_clipper';

  // Use prefetched items stored during search loop if available
  let items: VideoItem[] = (lead._videoItemsForVerification ?? []).slice(0, MAX_VIDEOS_PER_LEAD);

  // Otherwise scrape fresh
  if (!items.length && handle) {
    const postsMap = platform === 'tiktok'
      ? await scrapeTikTokPosts([handle], apifyToken)
      : await scrapeInstagramPosts([handle], apifyToken);
    items = (postsMap.get(handle) ?? []).slice(0, MAX_VIDEOS_PER_LEAD);
  }

  // No posts found → neutral pass
  if (!items.length) {
    return {
      overall_score: 50,
      is_icp_match: true,
      analyzed_videos: 0,
      analyzed_at: new Date().toISOString(),
      reasoning: 'No posts found — passed by default',
    };
  }

  // Analyze all items in parallel
  const analyses = await Promise.all(
    items.map(item => analyzeVideoItem(item, icpType, openaiKey)),
  );

  const overall_score = Math.round(
    analyses.reduce((sum, a) => sum + a.score, 0) / analyses.length,
  );
  const reasoning = analyses
    .map((a, i) => `Video ${i + 1}: ${a.reasoning}`)
    .join(' | ')
    .substring(0, 600);

  return {
    overall_score,
    is_icp_match: overall_score >= SCORE_THRESHOLD,
    analyzed_videos: analyses.length,
    analyzed_at: new Date().toISOString(),
    reasoning,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Auth: accept Vercel's automatic cron header OR a manual Bearer token
  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader   = req.headers['authorization'] || '';
  const bearerToken  = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!isVercelCron && !(cronSecret && bearerToken === cronSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apifyToken = process.env.VITE_APIFY_API_TOKEN || process.env.APIFY_API_TOKEN || '';
  const openaiKey  = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || '';

  if (!apifyToken) return res.status(500).json({ error: 'APIFY_API_TOKEN not configured' });
  if (!openaiKey)  return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const supabase = getSupabase();

  // Fetch pending leads (BATCH_SIZE at a time to stay within function timeout)
  const { data: rows, error: fetchErr } = await supabase
    .from('search_results')
    .select('id, user_id, lead_data')
    .eq('lead_data->>status', 'pending_content_verification')
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error('[cron/content-verification] Supabase fetch error:', fetchErr.message);
    return res.status(500).json({ error: fetchErr.message });
  }

  const pending = rows ?? [];
  if (!pending.length) {
    return res.status(200).json({ processed: 0, ready: 0, discarded: 0, message: 'No pending leads' });
  }

  let ready = 0;
  let discarded = 0;
  const errors: string[] = [];

  for (const row of pending) {
    try {
      const lead = row.lead_data as Lead;

      // Mark as 'verifying' optimistically to prevent duplicate processing by
      // concurrent cron runs (Vercel does not guarantee non-overlap)
      await supabase
        .from('search_results')
        .update({ lead_data: { ...lead, status: 'verifying' as Lead['status'] } })
        .eq('id', row.id);

      const result = await verifyLead(lead, apifyToken, openaiKey);
      const newStatus: Lead['status'] = result.is_icp_match ? 'ready' : 'discarded';

      const updatedLead: Lead = {
        ...lead,
        status: newStatus,
        content_alignment_score: result.overall_score,
        content_verification_details: result,
        // Clear transient field after processing to keep DB lean
        _videoItemsForVerification: undefined,
      };

      const { error: updateErr } = await supabase
        .from('search_results')
        .update({ lead_data: updatedLead })
        .eq('id', row.id);

      if (updateErr) throw new Error(updateErr.message);

      if (result.is_icp_match) { ready++; } else { discarded++; }
      console.log(
        `[cron] @${lead.ig_handle} → ${newStatus} (score: ${result.overall_score}) | ${result.reasoning.substring(0, 80)}`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`row ${row.id}: ${msg}`);
      console.error('[cron/content-verification] Error processing row', row.id, msg);

      // Revert optimistic status so the lead can be retried next run
      const lead = row.lead_data as Lead;
      await supabase
        .from('search_results')
        .update({ lead_data: { ...lead, status: 'pending_content_verification' } })
        .eq('id', row.id)
        .then(() => {/* fire-and-forget revert */});
    }
  }

  return res.status(200).json({
    processed: pending.length,
    ready,
    discarded,
    errors: errors.length ? errors : undefined,
  });
}
