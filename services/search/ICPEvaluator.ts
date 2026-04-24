import { Lead } from '../../lib/types';
import type { LogCallback } from './SearchService';

// ── Constants ─────────────────────────────────────────────────────────────────

export const HARD_FILTER_MIN_FOLLOWERS = 3_000;
export const HARD_FILTER_MAX_FOLLOWERS = 150_000;

const BRAND_KEYWORDS = [
  'official', 'store', 'shop', 'brand', 'supplements', 'apparel',
  'gym', 'club', 'agency'
];

// Non-gym sports: match in bio/username/name → reject UNLESS gym override also present
const NON_GYM_SPORT_KEYWORDS = [
  'cycling', 'cyclist', 'roadcycling', 'mtb', 'velodrome', 'bikerace', 'bikefitness',
  'marathon', 'runningclub', 'trailrunning', 'trailrun', 'ultramarathon',
  'triathlon', 'triathlete',
  'swimmer', 'openwater',
  'footballplayer', 'soccerplayer', 'basketballplayer', 'tennisplayer',
  'golfer', 'rugbyplayer', 'surfer', 'kitesurfer', 'skateboarder', 'snowboarder'
];

// If ANY of these are present alongside a NON_GYM_SPORT_KEYWORD, the profile is kept
const GYM_FITNESS_OVERRIDE_KEYWORDS = [
  'gym', 'fitness', 'workout', 'bodybuilding', 'strength', 'crossfit',
  'coach', 'trainer', 'hiit', 'weightlifting', 'lifting', 'physique', 'muscle'
];

const ICP_SOFT_FILTER_BATCH_SIZE = 10;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RawApifyProfile {
  username: string;
  fullName: string;
  biography: string;
  followersCount: number;
  [key: string]: unknown;
}

interface SoftFilterResult {
  username: string;
  is_human_creator: boolean;
  confidence: number;
  reason: string;
}

// ── ICPEvaluator ──────────────────────────────────────────────────────────────

export class ICPEvaluator {

  /**
   * Hard Filter — runs synchronously on raw Apify profiles.
   * Removes profiles that:
   *   - Have followers outside [HARD_FILTER_MIN_FOLLOWERS, HARD_FILTER_MAX_FOLLOWERS]
   *   - Have a fullName or username that contains a brand keyword
   */
  applyHardFilter(profiles: RawApifyProfile[], onLog: LogCallback): RawApifyProfile[] {
    const passed: RawApifyProfile[] = [];

    for (const profile of profiles) {
      const handle = (profile.username || '').toLowerCase().trim();
      const nameLower = (profile.fullName || '').toLowerCase();
      const bioLower = (profile.biography || '').toLowerCase();
      const fullText = `${bioLower} ${nameLower} ${handle}`;
      const followers = profile.followersCount || 0;

      // Follower range
      if (followers < HARD_FILTER_MIN_FOLLOWERS) {
        onLog(`[HARD FILTER] ↓ @${handle} skip: ${followers.toLocaleString()} < min ${HARD_FILTER_MIN_FOLLOWERS.toLocaleString()} followers`);
        continue;
      }
      if (followers > HARD_FILTER_MAX_FOLLOWERS) {
        onLog(`[HARD FILTER] ↑ @${handle} skip: ${followers.toLocaleString()} > max ${HARD_FILTER_MAX_FOLLOWERS.toLocaleString()} followers`);
        continue;
      }

      // Brand keyword check (fullName and username)
      const brandKeyword = BRAND_KEYWORDS.find(kw =>
        nameLower.includes(kw) || handle.includes(kw)
      );
      if (brandKeyword) {
        onLog(`[HARD FILTER] 🏷 @${handle} skip: "${brandKeyword}" brand keyword in name/username`);
        continue;
      }

      // Non-gym sport check: reject cycling, running, triathlon, etc.
      // unless they also show gym/fitness/coaching keywords (e.g. a cycling coach who also lifts)
      const nonGymSport = NON_GYM_SPORT_KEYWORDS.find(kw => fullText.includes(kw));
      if (nonGymSport) {
        const hasGymOverride = GYM_FITNESS_OVERRIDE_KEYWORDS.some(kw => fullText.includes(kw));
        if (!hasGymOverride) {
          onLog(`[HARD FILTER] 🚴 @${handle} skip: non-gym sport "${nonGymSport}" detected, no fitness override`);
          continue;
        }
      }

      passed.push(profile);
    }

    return passed;
  }

  /**
   * Soft Filter — AI evaluation via /api/openai.
   * Sends leads in batches of 10 to GPT-4o-mini to determine if each profile
   * belongs to a real individual creator or a brand/theme page.
   * Sets lead.icp_verified = true if is_human_creator: true AND confidence > 80.
   * On failure, marks batch leads as icp_verified = false (permissive fallback).
   * Returns ALL leads (verified and unverified).
   */
  async applySoftFilter(leads: Lead[], onLog: LogCallback): Promise<Lead[]> {
    if (!leads.length) return [];

    onLog(`[ICP SOFT] Evaluating ${leads.length} profiles with AI (batches of ${ICP_SOFT_FILTER_BATCH_SIZE})...`);

    const SYSTEM_PROMPT = `You are an expert Talent Scout for a creator agency. Your job is to analyze Instagram profile metadata and determine if the account belongs to an INDIVIDUAL HUMAN CREATOR or a COMPANY/THEME PAGE.

Criteria for HUMAN CREATOR (Pass):
- The name sounds like a real person.
- The bio talks in first person ('I', 'my journey', 'coach').
- They offer personal coaching or document their own life/fitness journey.

Criteria for COMPANY/THEME PAGE (Fail):
- The name sounds like a brand or business.
- It's a faceless motivation page.
- They sell physical products as their main identity.

Reply ONLY with a valid JSON array matching the input order. Format:
[ { "username": "user1", "is_human_creator": true, "confidence": 95, "reason": "Real name, bio mentions personal coaching" }, ... ]`;

    // Chunk into batches
    const batches: Lead[][] = [];
    for (let i = 0; i < leads.length; i += ICP_SOFT_FILTER_BATCH_SIZE) {
      batches.push(leads.slice(i, i + ICP_SOFT_FILTER_BATCH_SIZE));
    }

    // Process each batch sequentially to avoid hammering the API
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchLabel = `batch ${batchIdx + 1}/${batches.length}`;

      const profilesPayload = batch.map(lead => ({
        username: lead.ig_handle || '',
        fullName: lead.decisionMaker?.name || '',
        biography: lead.aiAnalysis?.summary || '',   // best bio we have at this point
        followersCount: lead.follower_count || 0
      }));

      try {
        const response = await fetch('/api/openai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify(profilesPayload) }
            ],
            temperature: 0.3,
            max_tokens: 1200
          })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array in AI response');

        const results: SoftFilterResult[] = JSON.parse(jsonMatch[0]);

        // Match results to leads — use order-based matching (guaranteed by prompt) with username cross-check
        let verifiedCount = 0;
        for (let i = 0; i < batch.length; i++) {
          const lead = batch[i];
          const result = results[i];

          if (!result) {
            lead.icp_verified = false;
            continue;
          }

          // Sanity cross-check: username should match (order-based is primary, this is a safety net)
          const usernameMatch =
            !result.username ||
            result.username.toLowerCase() === (lead.ig_handle || '').toLowerCase();

          if (usernameMatch && result.is_human_creator === true && result.confidence > 80) {
            lead.icp_verified = true;
            verifiedCount++;
            onLog(`[ICP SOFT] ✓ @${lead.ig_handle} → Human Creator (${result.confidence}% confidence)`);
          } else {
            lead.icp_verified = false;
            onLog(`[ICP SOFT] ✗ @${lead.ig_handle} → ${result.is_human_creator ? `Low confidence (${result.confidence}%)` : `Brand/Page`}: ${result.reason || 'no reason given'}`);
          }
        }

        onLog(`[ICP SOFT] ${batchLabel}: ${verifiedCount}/${batch.length} verified as human creators`);

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        onLog(`[ICP SOFT] ⚠ ${batchLabel} failed (${msg}) — marking as unverified`);
        // Permissive fallback: keep leads but mark unverified
        for (const lead of batch) {
          lead.icp_verified = false;
        }
      }
    }

    const totalVerified = leads.filter(l => l.icp_verified).length;
    onLog(`[ICP SOFT] Total: ${totalVerified}/${leads.length} ICP verified (${leads.length - totalVerified} unverified but kept)`);

    return leads;
  }
}

export const icpEvaluator = new ICPEvaluator();
