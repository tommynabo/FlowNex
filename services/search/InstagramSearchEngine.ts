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

// Location suffixes — rotate through US/Canada only (our target market)
const LOCATION_SUFFIXES = [
  'USA',
  'Canada',
  'United States',
  'California',
  'New York',
  'Texas',
  'Florida',
  'Ontario',
  'British Columbia',
  'American',
  'Canadian',
  'US',
];

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

// ── Engine ─────────────────────────────────────────────────────────────────────

export class InstagramSearchEngine {
  private isRunning = false;
  private userId: string | null = null;

  public stop() {
    this.isRunning = false;
  }

  // ── Keyword / query rotation ─────────────────────────────────────────────────

  /** Always returns the unified fitness-only keyword pool */
  private detectKeywordPool(_baseKeywords: string[]): string[][] {
    return KEYWORD_POOLS;
  }

  /**
   * Builds a Google Search query for a given attempt.
   *   attempt 1  → user's own keywords, no location
   *   attempt 2+ → rotate through keyword pool variants + location suffixes
   *
   * Result: `site:instagram.com "keyword1" "keyword2" Location`
   */
  private buildSearchQuery(
    baseKeywords: string[],
    attempt: number,
    keywordPool: string[][],
  ): string {
    let keywords: string[];
    let location: string;

    if (attempt === 1) {
      keywords = baseKeywords.slice(0, 2).map(k => k.includes('"') ? k : `"${k}"`);
      location = 'USA OR Canada';
    } else {
      const poolIdx = (attempt - 2) % keywordPool.length;
      const locIdx  = Math.floor((attempt - 2) / keywordPool.length) % LOCATION_SUFFIXES.length;
      keywords = keywordPool[poolIdx];
      location = LOCATION_SUFFIXES[locIdx];
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
    const targetCount = Math.max(1, config.maxResults);
    const baseKeywords = this.parseKeywordsFromQuery(config.query);
    const keywordPool  = this.detectKeywordPool(baseKeywords);

    // MAX_RETRIES scales with target size — always at least 15 so small targets (1-5) never give up early
    const MAX_RETRIES = Math.min(50, Math.max(15, targetCount * 3));

    onLog('[IG] Keywords base: ' + baseKeywords.join(', '));
    onLog('[IG] Keyword pool: ' + keywordPool.length + ' variantes de búsqueda (Google site:instagram.com)');
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

    // Handles to skip — Instagram system/non-user paths
    const SKIP_HANDLES = new Set(['p', 'reel', 'reels', 'explore', 'stories',
      'accounts', 'tv', 'direct', 'hashtag', 'tagged', 'about', 'directory']);

    while (accepted.length < targetCount && this.isRunning && attempt < MAX_RETRIES) {
      attempt++;
      const needed = targetCount - accepted.length;
      const searchQuery = this.buildSearchQuery(baseKeywords, attempt, keywordPool);

      onLog('');
      onLog('━━━ ATTEMPT ' + attempt + '/' + MAX_RETRIES + ' ━━━  ' +
        needed + ' lead(s) still needed');
      onLog('🔎 STEP 1/4 — Google Search: ' + searchQuery);

      // ── STEP 1: Google Search site:instagram.com → novel handles ────────────
      let searchResults: unknown[];
      try {
        searchResults = await this.callApifyActor(GOOGLE_SEARCH_SCRAPER, {
          queries: searchQuery,
          maxPagesPerQuery: 2,
          resultsPerPage: 10,
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
      const rawHandles = allOrganicResults
        .map(item => {
          const url = ((item.url as string) || (item.link as string) || '').toLowerCase();
          const match = url.match(/instagram\.com\/([^/?#\s]+)/);
          return match ? match[1].trim() : '';
        })
        .filter(h => h && !SKIP_HANDLES.has(h) && !seenHandles.has(h));
      const novelHandles = [...new Set(rawHandles)].slice(0, Math.min(30, needed * 4));

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

      const slotsRemaining = targetCount - accepted.length;
      // Try email discovery on ALL verified leads in the batch.
      const emailCandidates = toEvaluate.slice(0, Math.max(slotsRemaining * 8, toEvaluate.length));

      // ── STEP 4: Email discovery ───────────────────────────────────────────────
      onLog('📧 STEP 4/4 — Email discovery for ' + emailCandidates.length + ' verified creators...');
      await Promise.all(emailCandidates.map(async (lead) => {
        if (!this.isRunning) return;
        const discovered = await emailDiscoveryService.discoverEmail(
          lead.decisionMaker?.email || '',
          lead.website || '',
          lead.ig_handle || '',
          onLog,
        );
        if (discovered && lead.decisionMaker) lead.decisionMaker.email = discovered;
      }));
      const leadsWithEmail = emailCandidates.filter(l => l.decisionMaker?.email);
      const leadsNoEmail = emailCandidates.filter(l => !l.decisionMaker?.email);
      if (leadsNoEmail.length > 0) {
        onLog('📧 ' + leadsNoEmail.length + ' lead(s) sin email — se añaden al pipeline sin email (Instantly solo recibe los que sí tienen)');
      }
      // Accept ALL verified leads (with or without email) — sendLeadsToInstantly filters by email
      const toProcess = emailCandidates.slice(0, slotsRemaining);
      onLog('📧 STEP 4/4 ✓ — ' + leadsWithEmail.length + '/' + emailCandidates.length + ' tienen email | aceptando ' + toProcess.length + ' leads');
      console.log('[InstagramEngine] Attempt', attempt, '| with email:', leadsWithEmail.length, '/', emailCandidates.length);

      if (!emailCandidates.length) {
        onLog('⚠ Ningún candidato ICP verificado en este batch. Rotando query...');
        continue;
      }

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

        if (response.ok) {
          sent++;
          onLog('[INSTANTLY] ✅ ' + email + ' (@' + lead.ig_handle + ') añadido a campaña');
        } else if (response.status === 409) {
          skipped++;
          onLog('[INSTANTLY] ℹ Ya en campaña: ' + email);
        } else {
          failed++;
          const err = await response.json().catch(() => ({} as Record<string, unknown>)) as { error?: string };
          onLog('[INSTANTLY] ❌ Error ' + response.status + ' para ' + email + ': ' + (err.error || 'unknown'));
        }
      } catch (e: unknown) {
        failed++;
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
