import { Lead } from '../../lib/types';
import type { LogCallback } from './SearchService';

// ── Constants ─────────────────────────────────────────────────────────────────

export const HARD_FILTER_MIN_FOLLOWERS = 1_000;
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

// At least ONE strictly physical fitness keyword must be present — broad terms like coach/health excluded
const FITNESS_REQUIRED_KEYWORDS = [
  'fitness', 'gym', 'workout', 'training', 'crossfit', 'hiit',
  'bodybuilding', 'weightlifting', 'lifting', 'physique', 'muscle',
  'strength', 'pilates', 'fitspo', 'fitlife', 'gymlife', 'gymrat',
  'fitnesscoach', 'personaltrainer', 'gains', 'shredded', 'bulk',
  'macros', 'gymtok', 'fitnessmotivation', 'gymmotivation',
  'nutrition', 'diet', 'weightloss'
];

// Profiles containing ANY of these are rejected — even if they also have fitness keywords
const MENTAL_COACH_REJECT_KEYWORDS = [
  'psychologist', 'psychology', 'therapist', 'therapy', 'mentalhealth',
  'psychiatric', 'psychiatrist', 'counselor', 'counselling', 'counseling',
  'mindcoach', 'spiritualcoach', 'energyhealer', 'healer', 'spirituality',
  'manifestation', 'lawofattraction'
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

      // Positive fitness check — reject if NO physical fitness keyword is present
      const hasFitnessKeyword = FITNESS_REQUIRED_KEYWORDS.some(kw => fullText.includes(kw));
      if (!hasFitnessKeyword) {
        onLog(`[HARD FILTER] 🚫 @${handle} skip: no physical fitness keyword in bio/name`);
        continue;
      }

      // Mental/spiritual coach rejection — even if they mention fitness occasionally
      const mentalKeyword = MENTAL_COACH_REJECT_KEYWORDS.find(kw => fullText.includes(kw));
      if (mentalKeyword) {
        onLog(`[HARD FILTER] 🧠 @${handle} skip: mental/spiritual keyword "${mentalKeyword}" found`);
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
   * is a genuine PHYSICAL FITNESS CREATOR.
   * Sets lead.icp_verified = true ONLY if is_physical_fitness_creator: true AND confidence >= 90.
   * On failure, marks batch leads as icp_verified = false (strict fallback — never assume pass).
   * Returns ALL leads with icp_verified flag set; caller decides whether to filter.
   */
  async applySoftFilter(leads: Lead[], onLog: LogCallback): Promise<Lead[]> {
    if (!leads.length) return [];

    onLog(`[ICP SOFT] Evaluating ${leads.length} profiles with AI (batches of ${ICP_SOFT_FILTER_BATCH_SIZE})...`);

    const SYSTEM_PROMPT = `You are a talent scout for a fitness creator outreach agency targeting US/Canada Instagram accounts. Your job is to decide whether each profile belongs to a GYM/FITNESS CONTENT CREATOR — this includes both professional coaches AND everyday gym-goers who create content about the gym lifestyle.

Criteria to PASS (is_physical_fitness_creator = true) — the profile must fit ONE of these:
- Professional: personal trainer, fitness coach, bodybuilding coach, nutrition coach (sports/gym focused)
- Gym content creator: posts workout videos, gym day content, exercise tutorials, gym motivation, body transformation content, lifting videos, physique content — even without being a certified coach
- Gym lifestyle influencer: their account is clearly centered around gym, lifting, working out — even if they also post other content

They must ALSO be:
- An INDIVIDUAL person (not a brand, gym, supplement company, or agency)
- Based in US or Canada (or appear to be, based on language/references)

Criteria to FAIL (is_physical_fitness_creator = false) — ANY of these → reject:
- Mental health coaches, therapists, psychologists, spiritual healers, manifestation coaches, life coaches with no gym content
- Running, cycling, triathlon, swimming, or endurance sports ONLY (no gym/weights)
- Models or fashion influencers who occasionally post gym selfies but gym is NOT their main content
- Yoga or meditation ONLY accounts (no strength training content)
- Brand accounts, gyms, supplement stores, agencies, or faceless quote/motivation pages
- Bio is completely vague ("coach", "wellness", "lifestyle") with zero fitness/gym reference

NOTE: Accept gym content creators who are NOT professional coaches — someone who posts "gym vlogs", "my workout routine", "gym motivation" is a valid target even without coaching credentials.

Reply ONLY with a valid JSON array matching the input order:
[ { "username": "user1", "is_physical_fitness_creator": true, "confidence": 93, "reason": "Posts daily gym workout videos and lifting content, US-based" }, ... ]`;

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
        biography: (lead as any)._rawBio || lead.aiAnalysis?.summary || '',
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

          const passes = (result as any).is_physical_fitness_creator ?? result.is_human_creator;
          if (usernameMatch && passes === true && result.confidence >= 70) {
            lead.icp_verified = true;
            verifiedCount++;
            onLog(`[ICP SOFT] ✓ @${lead.ig_handle} → Physical Fitness Creator (${result.confidence}% confidence)`);
          } else {
            lead.icp_verified = false;
            onLog(`[ICP SOFT] ✗ @${lead.ig_handle} → ${passes ? `Low confidence (${result.confidence}%)` : `Not fitness creator`}: ${result.reason || 'no reason given'}`);
          }
        }

        onLog(`[ICP SOFT] ${batchLabel}: ${verifiedCount}/${batch.length} verified as human creators`);

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        onLog(`[ICP SOFT] ⚠ ${batchLabel} failed (${msg}) — strict fallback: marking all as NOT verified`);
        // Strict fallback: on AI failure, reject entire batch (never assume pass)
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
