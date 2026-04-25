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

import { Lead, SearchConfigState, AudienceTier } from '../../lib/types';
import { deduplicationService } from '../deduplication/DeduplicationService';
import { PROJECT_CONFIG } from '../../config/project';
import { icpEvaluator, RawApifyProfile } from './ICPEvaluator';
import { emailDiscoveryService } from './EmailDiscoveryService';
import type { LogCallback, ResultCallback } from './SearchService';

// ── Hashtag pools by niche ─────────────────────────────────────────────────────
// 20-30 variants per niche; rotated across attempts so Instagram sees fresh content

const HASHTAG_POOLS: Record<string, string[]> = {
  fitness: [
    'fitnesscoach', 'personaltrainer', 'gymlife', 'workout', 'bodybuilding',
    'strengthtraining', 'fitnessmotivation', 'gymrat', 'fitlife', 'gains',
    'crossfit', 'hiit', 'physique', 'musclebuilding', 'weightlifting',
    'powerlifting', 'bulking', 'shredded', 'fitspo', 'gymmotivation',
    'gymcoach', 'fitnessmodel', 'bodybuilder', 'trainhard', 'homeworkout',
    'calisthenics', 'aesthetics', 'liftingweights', 'fitnessgirl', 'fitnessguy',
  ],
  nutrition: [
    'nutritioncoach', 'mealprep', 'cleaneating', 'macros', 'weightloss',
    'healthyfood', 'dietitian', 'proteinrich', 'healthyeating', 'fitfood',
    'eatclean', 'iifym', 'caloriecounting', 'nutritiontips', 'sportnutrition',
    'healthylifestyle', 'musclediet', 'bulkingdiet', 'cuttingdiet', 'nutritionadvice',
  ],
  wellness: [
    'wellnesscoach', 'mindset', 'personaldevelopment', 'selfimprovement',
    'motivation', 'lifecoach', 'mindfulness', 'positivity', 'growthmindset',
    'successmindset', 'selfcare', 'wellbeing', 'healthymind', 'dailymotivation',
  ],
  general: [
    'fitnesscoach', 'personaltrainer', 'gymlife', 'workout', 'healthylifestyle',
    'fitnessmotivation', 'bodybuilding', 'strengthtraining', 'nutritioncoach', 'mealprep',
    'gains', 'crossfit', 'physique', 'fitspo', 'gymrat',
    'hiit', 'weightlifting', 'fitlife', 'gymmotivation', 'cleaneating',
  ],
};

// Number of hashtags per Apify call
const HASHTAGS_PER_BATCH = 5;

// After this many consecutive attempts yielding 0 novel handles → niche is exhausted
const MAX_CONSEC_ZEROS = 4;

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

const INSTAGRAM_HASHTAG_SCRAPER = 'apify~instagram-hashtag-scraper';
const INSTAGRAM_PROFILE_SCRAPER = 'apify~instagram-profile-scraper';

// ── Engine ─────────────────────────────────────────────────────────────────────

export class InstagramSearchEngine {
  private isRunning = false;
  private userId: string | null = null;

  public stop() {
    this.isRunning = false;
  }

  // ── Hashtag rotation ─────────────────────────────────────────────────────────

  /** Detect which niche pool to use based on the user's base hashtags */
  private detectNichePool(baseHashtags: string[]): string[] {
    const joined = baseHashtags.join(' ').toLowerCase();
    if (/nutrition|diet|meal|macro|calori/.test(joined)) return HASHTAG_POOLS.nutrition;
    if (/wellness|mindset|lifecoach|personal.?dev/.test(joined)) return HASHTAG_POOLS.wellness;
    if (/fitness|gym|workout|training|bodybuilding|strength/.test(joined)) return HASHTAG_POOLS.fitness;
    return HASHTAG_POOLS.general;
  }

  /**
   * Returns a distinct batch of hashtags for each attempt:
   *   attempt 1 → user-provided base hashtags
   *   attempt 2+ → slide a window through the niche pool
   *
   * The first element of baseHashtags is added as an anchor to each rotation
   * batch so Apify stays in the right content universe.
   */
  private getHashtagBatch(baseHashtags: string[], attempt: number, nichePool: string[]): string[] {
    if (attempt === 1) return baseHashtags.slice(0, HASHTAGS_PER_BATCH);

    const totalWindows = Math.ceil(nichePool.length / HASHTAGS_PER_BATCH);
    const windowIdx = (attempt - 2) % totalWindows;
    const start = windowIdx * HASHTAGS_PER_BATCH;
    const batch = nichePool.slice(start, start + HASHTAGS_PER_BATCH);

    // Pad if last window is short
    if (batch.length < HASHTAGS_PER_BATCH && nichePool.length >= HASHTAGS_PER_BATCH) {
      batch.push(...nichePool.slice(0, HASHTAGS_PER_BATCH - batch.length));
    }

    // Anchor: inject first user hashtag unless it's already there
    const anchor = baseHashtags[0]?.replace(/^#/, '');
    if (anchor && !batch.includes(anchor)) {
      batch.splice(0, 1, anchor);
    }

    return batch;
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

      await this.runSearchLoop(config, existingIgHandles, existingEmails, onLog, onComplete);
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
  ): Promise<void> {
    const icpFilters = config.icpFilters;
    const minFollowers = icpFilters?.minFollowers ?? 0;
    const maxFollowers = icpFilters?.maxFollowers ?? 99_000_000;
    const targetRegions = icpFilters?.regions ?? [];
    const targetContentTypes = icpFilters?.contentTypes ?? [];
    const targetCount = Math.max(1, config.maxResults);
    const baseHashtags = this.parseHashtagsFromQuery(config.query);
    const nichePool = this.detectNichePool(baseHashtags);

    // MAX_RETRIES scales with target size — never gives up too early
    const MAX_RETRIES = Math.min(100, Math.max(30, Math.ceil(targetCount / 5) * 6));

    onLog('[IG] Base hashtags: #' + baseHashtags.join(', #'));
    onLog('[IG] Niche pool: ' + nichePool.length + ' hashtag variants cargados para este nicho');
    onLog('[IG] 🎯 Objetivo: ' + targetCount + ' creadores | Máx intentos: ' + MAX_RETRIES);
    onLog('[IG] Followers: ' + (minFollowers > 0 ? this.formatFollowers(minFollowers) : '0') + ' – ' + (maxFollowers < 99_000_000 ? this.formatFollowers(maxFollowers) : '∞'));
    console.log('[InstagramEngine] START — target:', targetCount, '| maxRetries:', MAX_RETRIES, '| hashtags:', baseHashtags);
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

    while (accepted.length < targetCount && this.isRunning && attempt < MAX_RETRIES) {
      attempt++;
      const needed = targetCount - accepted.length;
      const hashtagBatch = this.getHashtagBatch(baseHashtags, attempt, nichePool);
      // Over-fetch: request many more posts than needed to absorb filter losses
      const postFetchLimit = Math.min(needed * 25, 500);

      onLog('');
      onLog('━━━ ATTEMPT ' + attempt + '/' + MAX_RETRIES + ' ━━━  ' +
        needed + ' lead(s) still needed | #' + hashtagBatch.join(', #'));

      // ── STEP 1: Hashtag posts → novel handles ─────────────────────────────────
      onLog('📸 STEP 1/4 — Scraping up to ' + postFetchLimit + ' posts...');
      let posts: unknown[];
      try {
        posts = await this.callApifyActor(INSTAGRAM_HASHTAG_SCRAPER, {
          hashtags: hashtagBatch.map(h => h.replace(/^#/, '')),
          resultsLimit: postFetchLimit,
          proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
        }, onLog);
      } catch (e: unknown) {
        onLog('[STEP 1] Scraper error: ' + (e instanceof Error ? e.message : String(e)));
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) {
          onLog('[ENGINE] ' + consecutiveZeros + ' consecutive failures — aborting.');
          break;
        }
        continue;
      }

      if (!posts.length) {
        onLog('📸 No posts returned for: #' + hashtagBatch.join(', #'));
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) {
          onLog('[ENGINE] ' + MAX_CONSEC_ZEROS + ' empty rounds — niche exhausted. Stopping.');
          break;
        }
        continue;
      }

      // Filter to handles we've never seen in this session or in the DB
      const rawHandles = (posts as Record<string, unknown>[])
        .map(p => (((p.ownerUsername ?? (p.owner as Record<string, unknown>)?.username ?? p.username) as string) || '').toLowerCase().trim())
        .filter(h => h && !seenHandles.has(h));
      const novelHandles = [...new Set(rawHandles)].slice(0, 60);

      onLog('📸 STEP 1/4 ✓ — ' + posts.length + ' posts → ' + novelHandles.length + ' handles nuevos (sin ver aún)');
      console.log('[InstagramEngine] Attempt', attempt, '| novel handles:', novelHandles.length, '/', rawHandles.length + novelHandles.length, 'raw (', posts.length, 'posts)');

      if (!novelHandles.length) {
        onLog('⚠ Todos los handles de #' + hashtagBatch.join(', #') + ' ya fueron procesados — rotando hashtags...');
        console.warn('[InstagramEngine] Attempt', attempt, '— 0 novel handles. All seen. Rotating.');
        consecutiveZeros++;
        if (consecutiveZeros >= MAX_CONSEC_ZEROS) {
          onLog('[ENGINE] ' + MAX_CONSEC_ZEROS + ' rondas sin handles nuevos — nicho agotado. Deteniendo.');
          break;
        }
        continue;
      }

      // Mark ALL novel handles as seen immediately (prevents parallel re-processing)
      for (const h of novelHandles) seenHandles.add(h);
      consecutiveZeros = 0; // reset — fresh handles found

      // ── STEP 2: Full profile scrape ──────────────────────────────────────────
      onLog('👤 STEP 2/4 — Fetching ' + novelHandles.length + ' full profiles...');
      let profiles: unknown[];
      try {
        profiles = await this.callApifyActor(INSTAGRAM_PROFILE_SCRAPER, {
          usernames: novelHandles,
        }, onLog);
      } catch (e: unknown) {
        onLog('👤 STEP 2/4 ✗ Profile scraper error: ' + (e instanceof Error ? e.message : String(e)));
        // Don't count as zero — we did get handles, scraper just failed temporarily
        continue;
      }
      onLog('👤 STEP 2/4 ✓ — ' + profiles.length + ' profiles received');

      // ── STEP 3: Hard ICP filter ──────────────────────────────────────────────
      onLog('🔍 STEP 3/4 — Aplicando filtros ICP duros (' + profiles.length + ' perfiles)...');
      const hardFiltered = icpEvaluator.applyHardFilter(profiles as RawApifyProfile[], onLog);
      onLog('[HARD FILTER] Embudo: ' + profiles.length + ' descargados → ' + hardFiltered.length +
        ' pasaron (followers ✓, sin marca ✓, keyword fitness ✓)');
      console.log('[InstagramEngine] Attempt', attempt, '| hard filter:', profiles.length, '→', hardFiltered.length);

      if (!hardFiltered.length) {
        onLog('⚠ Ningún perfil pasó el hard filter en este batch. Rotando hashtags...');
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

        // Region filter — skip only when location data is present AND contradicts filter
        if (targetRegions.length > 0) {
          const locationStr = [p.country, p.city, p.region, p.countryCode, p.locationName]
            .map(v => ((v as string) || '').toLowerCase())
            .join(' ');
          if (locationStr.trim()) {
            const matchesRegion = targetRegions.some(r => {
              const patterns = REGION_MAP[r] ?? [r.toLowerCase()];
              return patterns.some(pat => locationStr.includes(pat));
            });
            if (!matchesRegion) {
              onLog('[ICP] 🌍 @' + handle + ' — "' + (p.country || p.city || '') + '" ∉ [' + targetRegions.join(', ') + ']');
              continue;
            }
          }
          // No location data → allow through (can't confirm but can't reject)
        }

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

        candidates.push({
          id: 'ig-' + handle + '-' + Date.now(),
          source: 'instagram',
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
            instagram: 'https://instagram.com/' + handle,
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
        onLog('⚠ Ningún candidato pasó los filtros ICP en este batch. Rotando hashtags...');
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
        onLog('⚠ Todos los candidatos ya existen en la BD. Rotando hashtags...');
        continue;
      }

      // ── STEP 3b: AI Soft Filter — verifica que son creadores de fitness físico ─
      onLog('🤖 STEP 3b — Filtro IA para ' + dbDeduped.length + ' candidatos (verificando ICP fitness)...');
      const softFiltered = await icpEvaluator.applySoftFilter(dbDeduped, onLog);
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

      // Only take as many as we still need
      const slotsRemaining = targetCount - accepted.length;
      const toProcess = toEvaluate.slice(0, slotsRemaining);

      // ── STEP 4: Email discovery ───────────────────────────────────────────────
      onLog('📧 STEP 4/4 — Email discovery for ' + toProcess.length + ' verified creators...');
      await Promise.all(toProcess.map(async (lead) => {
        if (!this.isRunning) return;
        const discovered = await emailDiscoveryService.discoverEmail(
          lead.decisionMaker?.email || '',
          lead.website || '',
          lead.ig_handle || '',
          onLog,
        );
        if (discovered && lead.decisionMaker) lead.decisionMaker.email = discovered;
      }));
      const withEmail = toProcess.filter(l => l.decisionMaker?.email).length;
      onLog('📧 STEP 4/4 ✓ — ' + withEmail + '/' + toProcess.length + ' tienen email tras discovery' +
        (withEmail < toProcess.length ? ' (' + (toProcess.length - withEmail) + ' sin email — se incluyen igual)' : ''));
      console.log('[InstagramEngine] Attempt', attempt, '| with email:', withEmail, '/', toProcess.length);

      // ── AI analysis + finalize ────────────────────────────────────────────────
      onLog('✍ Generando análisis IA para ' + toProcess.length + ' creadores...');
      const analyzed = (await Promise.all(toProcess.map(async (lead) => {
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
      }))).filter((l): l is Lead => l !== null);

      // Accept all analyzed leads — email is nice-to-have, not a gate
      for (const lead of analyzed) {
        accepted.push(lead);
        // Register in existingIgHandles so future dedup passes are aware
        if (lead.ig_handle) existingIgHandles.add(lead.ig_handle);
        const emailStr = lead.decisionMaker?.email ? '📧 ' + lead.decisionMaker.email : '(sin email)';
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
      onLog('[ENGINE] ⚠ Max attempts (' + MAX_RETRIES + ') reached. Found ' + accepted.length + '/' + targetCount +
        '. Try broader hashtags or relax ICP filters.');
    }

    onComplete(accepted);
  }

  // ── Hashtag query parser ──────────────────────────────────────────────────────

  private parseHashtagsFromQuery(query: string): string[] {
    const defaults = (PROJECT_CONFIG.flownextConfig?.targetHashtags || [
      '#fitnesscoach', '#personaldevelopment', '#mindset', '#gymlife', '#workout',
    ]).map(h => h.replace(/^#/, ''));

    if (!query) return defaults.slice(0, 5);

    const explicit = query.match(/#[a-zA-Z0-9_]+/g);
    if (explicit && explicit.length > 0) return explicit.map(h => h.replace(/^#/, '')).slice(0, 10);

    const lower = query.toLowerCase();
    const tags: string[] = [];
    if (/fitness|gym|workout|training/.test(lower)) tags.push('fitnesscoach', 'gymlife', 'workout');
    if (/yoga|wellness|mindfulness/.test(lower)) tags.push('yoga', 'wellness', 'mindfulness');
    if (/personal.?dev|mindset|selfimprovement|motivation/.test(lower)) tags.push('personaldevelopment', 'mindset', 'selfimprovement');
    if (/nutrition|diet|health/.test(lower)) tags.push('nutrition', 'healthylifestyle');
    if (/business|entrepreneur/.test(lower)) tags.push('entrepreneur', 'businesscoach');
    return tags.length > 0 ? tags.slice(0, 8) : defaults.slice(0, 5);
  }
}

export const instagramSearchEngine = new InstagramSearchEngine();
