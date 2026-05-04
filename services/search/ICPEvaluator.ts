import { Lead, ICPType } from '../../lib/types';
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

// Anti-ICP bio keywords — immediate rejection if ANY appears in bio/name/username.
// Fires BEFORE email discovery — maximum cost savings on obvious false positives.
// Targets: local physical businesses, food brands, and generic corporate coaches.
const ANTI_ICP_BIO_KEYWORDS = [
  'restaurant', 'cafe', 'coffee shop', 'food truck', 'bakery', 'catering',
  'acai', 'smoothie', 'juice bar', 'pizz', 'burger', 'sushi',
  'boutique', 'retail store', 'e-commerce store', 'physical products',
  'hr consulting', 'corporate leadership', 'corporate coach', 'corporate trainer',
  'dental', 'dentist', 'clinic', 'salon', 'spa', 'franchis',
  // Spanish-market physical business rejections
  'restaurante', 'cafetería', 'panadería', 'tienda física', 'local comercial',
  'inmobiliaria', 'peluquería', 'clínica', 'consulta médica', 'franquicia',
];

// Required keywords for faceless/clipper ICP — at least ONE must be present
// Checked against the combined fullText (bio + name + handle).
// Expanded to include Spanish-market signals based on ICP reference accounts:
//   @arys.fitness (mentalidad, entrenamiento), @brian09__ (mejor versión),
//   @bautibelloso (natty), @finesteditsz (clipper/editor), @moullaga67 (💸 handle)
const FACELESS_CLIPPER_REQUIRED_KEYWORDS = [
  // EN — content identity
  'mindset', 'motivation', 'wealth', 'hustle', 'grind', 'entrepreneur',
  'clips', 'clip', 'clipper', 'editor', 'edits', 'money', 'success',
  'discipline', 'selfimprovement', 'wifimoney', 'passiveincome',
  'financialfreedom', 'hormozi', 'gadzhi', 'tate', 'goggins',
  'daily', 'slideshow', 'mindsetcoach', 'businessmindset',
  'successmindset', 'gymmotivation', 'moneymindset', 'dailymotivation',
  'motivational', 'makemoney', 'onlinebusiness', 'entrepreneurship',
  'bodytransformation', 'transformation', 'gymtok', 'fitnessmotivation',
  'noexcuses', 'neversettle', 'hardwork', 'nodaysoff', 'grindset',
  'physique', 'gains', 'shredded', 'bulk', 'cutting', 'aesthetics',
  'natty', 'lifting', 'bestversion',
  // ES — Spanish-speaking market signals (Spain, Argentina, México, Colombia)
  'mentalidad', 'motivacion', 'motivación', 'disciplina', 'constancia',
  'emprendimiento', 'emprendedor', 'dinero', 'riqueza', 'exito', 'éxito',
  'mejorversion', 'sinexcusas', 'rutina', 'entrenamiento', 'transformacion',
  'libertadfinanciera', 'negocio', 'crecimiento', 'progreso', 'frases',
  // Handle-level signals common in faceless/clipper account usernames
  'daily', 'clips', 'edits', 'motivation', 'mindset', 'fitness', 'gym',
];

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
  applyHardFilter(profiles: RawApifyProfile[], onLog: LogCallback, icpType: ICPType = 'personal_brand'): RawApifyProfile[] {
    const passed: RawApifyProfile[] = [];
    const rejections = { followerLow: 0, followerHigh: 0, brand: 0, antiIcp: 0, noSignal: 0, mental: 0, nonGymSport: 0 };

    for (const profile of profiles) {
      const handle = (profile.username || '').toLowerCase().trim();
      const nameLower = (profile.fullName || '').toLowerCase();
      const bioLower = (profile.biography || '').toLowerCase();
      const fullText = `${bioLower} ${nameLower} ${handle}`;
      const followers = profile.followersCount || 0;

      // Follower range
      if (followers < HARD_FILTER_MIN_FOLLOWERS) {
        onLog(`[HARD FILTER] ↓ @${handle} skip: ${followers.toLocaleString()} < min ${HARD_FILTER_MIN_FOLLOWERS.toLocaleString()} followers`);
        rejections.followerLow++;
        continue;
      }
      if (followers > HARD_FILTER_MAX_FOLLOWERS) {
        onLog(`[HARD FILTER] ↑ @${handle} skip: ${followers.toLocaleString()} > max ${HARD_FILTER_MAX_FOLLOWERS.toLocaleString()} followers`);
        rejections.followerHigh++;
        continue;
      }

      // Brand keyword check (fullName and username)
      const brandKeyword = BRAND_KEYWORDS.find(kw =>
        nameLower.includes(kw) || handle.includes(kw)
      );
      if (brandKeyword) {
        onLog(`[HARD FILTER] 🏷 @${handle} skip: "${brandKeyword}" brand keyword in name/username`);
        rejections.brand++;
        continue;
      }

      // Anti-ICP bio keyword check — rejects physical businesses and corporate accounts
      // Applies to BOTH icpTypes: these profiles are never valid targets regardless of ICP.
      const antiIcpKw = ANTI_ICP_BIO_KEYWORDS.find(kw => fullText.includes(kw));
      if (antiIcpKw) {
        onLog(`[HARD FILTER] 🚫 @${handle} skip: Anti-ICP keyword "${antiIcpKw}" detected in bio/name`);
        rejections.antiIcp++;
        continue;
      }

      if (icpType === 'faceless_clipper') {
        // Positive signal check: at least ONE faceless/clipper keyword must appear
        // in the combined fullText (bio + name + handle). Accounts like @bautibelloso
        // (bio: "natty 🇦🇷") or @moullaga67 (name: "💸💸💸") pass via their handle or name.
        // Accounts with ZERO relevant signal (pure lifestyle, random personal accounts)
        // are filtered here before reaching the more expensive AI soft filter.
        const hasClipperSignal = FACELESS_CLIPPER_REQUIRED_KEYWORDS.some(kw => fullText.includes(kw));
        if (!hasClipperSignal) {
          onLog(`[HARD FILTER] 🚫 @${handle} skip: no faceless/clipper signal in bio/name/handle`);
          rejections.noSignal++;
          continue;
        }
      } else {
        // personal_brand: require physical fitness keyword
        const hasFitnessKeyword = FITNESS_REQUIRED_KEYWORDS.some(kw => fullText.includes(kw));
        if (!hasFitnessKeyword) {
          onLog(`[HARD FILTER] 🚫 @${handle} skip: no physical fitness keyword in bio/name`);
          rejections.noSignal++;
          continue;
        }

        // Mental/spiritual coach rejection
        const mentalKeyword = MENTAL_COACH_REJECT_KEYWORDS.find(kw => fullText.includes(kw));
        if (mentalKeyword) {
          onLog(`[HARD FILTER] 🧠 @${handle} skip: mental/spiritual keyword "${mentalKeyword}" found`);
          rejections.mental++;
          continue;
        }

        // Non-gym sport check
        const nonGymSport = NON_GYM_SPORT_KEYWORDS.find(kw => fullText.includes(kw));
        if (nonGymSport) {
          const hasGymOverride = GYM_FITNESS_OVERRIDE_KEYWORDS.some(kw => fullText.includes(kw));
          if (!hasGymOverride) {
            onLog(`[HARD FILTER] 🚴 @${handle} skip: non-gym sport "${nonGymSport}" detected, no fitness override`);
            rejections.nonGymSport++;
            continue;
          }
        }
      }

      passed.push(profile);
    }

    // Rejection summary — helps diagnose which criteria are killing the most profiles
    const rejected = profiles.length - passed.length;
    if (rejected > 0) {
      const parts: string[] = [];
      if (rejections.followerLow)  parts.push(`${rejections.followerLow} follower↓`);
      if (rejections.followerHigh) parts.push(`${rejections.followerHigh} follower↑`);
      if (rejections.brand)        parts.push(`${rejections.brand} brand`);
      if (rejections.antiIcp)      parts.push(`${rejections.antiIcp} anti-icp`);
      if (rejections.noSignal)     parts.push(`${rejections.noSignal} no-signal`);
      if (rejections.mental)       parts.push(`${rejections.mental} mental`);
      if (rejections.nonGymSport)  parts.push(`${rejections.nonGymSport} non-gym`);
      onLog(`[HARD FILTER] Summary: ${profiles.length} in → ${passed.length} passed, ${rejected} rejected (${parts.join(', ')})`);
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
  async applySoftFilter(leads: Lead[], onLog: LogCallback, icpType: ICPType = 'personal_brand'): Promise<Lead[]> {
    if (!leads.length) return [];

    onLog(`[ICP SOFT] Evaluating ${leads.length} profiles with AI (batches of ${ICP_SOFT_FILTER_BATCH_SIZE}, icpType: ${icpType})...`);

    const FITNESS_SYSTEM_PROMPT = `You are a talent scout for a fitness creator outreach agency targeting US/Canada Instagram accounts. Your job is to decide whether each profile belongs to a GYM/FITNESS CONTENT CREATOR — this includes both professional coaches AND everyday gym-goers who create content about the gym lifestyle.

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

CRITICAL REJECTION CRITERIA (ANTI-ICP): You MUST immediately reject (is_physical_fitness_creator: false, confidence: 95, anti_icp: true) if the account falls into ANY of these categories:
1. Local Physical Businesses: restaurants, cafes, retail stores, acai/smoothie/juice brands, food trucks, e-commerce selling physical products, food franchises.
2. Generic/Corporate Coaching: traditional life coaches (no fitness/wealth angle), HR consulting, generic corporate leadership consultants, therapists, spiritual coaches.
3. Standard Personal Diaries/Lifestyle: everyday people posting selfies, pets, daily life, standard activities WITHOUT a specific digital or fitness creator angle.
We ONLY want digital-first fitness creators or gym-lifestyle content creators who are individuals building an audience.

Reply ONLY with a valid JSON array matching the input order:
[ { "username": "user1", "is_physical_fitness_creator": true, "confidence": 93, "anti_icp": false, "reason": "Posts daily gym workout videos and lifting content, US-based" }, ... ]`;

    const FACELESS_CLIPPER_SYSTEM_PROMPT = `You are a talent scout for a creator outreach agency. Your job is to decide whether each profile belongs to one of the TARGET CREATOR ARCHETYPES below. We target BOTH English-speaking (US/CA/UK) AND Spanish-speaking (Spain, Argentina, México, Colombia) markets.

TARGET ARCHETYPES — pass if the profile clearly fits ANY of these:

1. CLIPPER / VIDEO EDITOR
   - Explicitly identifies as "clipper", "editor", "edits" in bio or name
   - Reposts or edits clips from figures like Hormozi, Tate, Goggins, Gadzhi, etc.
   - Example: bio "Inspiring clipper and editor / Dm for Promos" + payhip.com link
   - Strong approval signal: bio contains "dm for promos", "payhip", "gumroad", "edits"

2. FACELESS MOTIVATION / MINDSET PAGE
   - Posts motivation, discipline, mindset quotes — does NOT show a face
   - Name/handle often contains: noexcuses, daily, mindset, discipline, motivation
   - May have minimal or no bio — accept if handle/name signals motivation content
   - Example: @nofexcuses with name "NoExcusesClub" and bio "be the best version of yourself"

3. PHYSIQUE / NATTY / GYM PROGRESSION CREATOR
   - Young individuals posting gym progress, body transformation, natty journey
   - Bio often contains: weight/height stats, "natty", flag emoji, age — very minimal
   - Example: @bautibelloso bio "18 86kg 1.81cm 🇦🇷natty" — this is a PERFECT ICP match
   - Accept creators who show their physique and tag gym/fitness content

4. ES/LATAM FITNESS & LIFESTYLE CREATOR (Spanish-speaking market)
   - Creates content in Spanish about fitness, lifestyle, mentality, daily motivation
   - Bio signals: "mentalidad", "entrenamiento", "mejor versión", "disciplina", "estilo de vida"
   - Example: @arys.fitness "🇬🇶🇪🇸 Fitness. Estilo de vida. Mentalidad" + linktr.ee
   - Example: @brian09__ "Consigue tu mejor versión 1:1 conmigo" + forms.gle link

5. MONEY / WEALTH FACELESS ACCOUNT
   - Emoji-heavy name (💸, 🤑, 💰), minimal or no bio
   - Handle may contain: money, wealth, dinero, finance
   - Accept if username + name context clearly signal money/finance/hustle niche
   - Example: @moullaga67 with name "💸💸💸" and no bio — VALID if handle suggests finance

AUTO-APPROVE SIGNALS (approve with confidence ≥ 88, skip lengthy analysis):
- Bio contains "clipper" or "editor" or "edits": auto-approve
- Bio contains "dm for promos" or "dm for collab": auto-approve
- Bio contains "payhip.com" or "gumroad.com" or "forms.gle": auto-approve
- Bio contains "linktr.ee" AND niche keywords (fitness/motivation/mindset): auto-approve
- Username/handle contains: clips, edits, clipper, daily, motivation, mindset, noexcuses, natty, physique, mentalidad, disciplina, motivacion

REJECT (is_human_creator = false):
- Large official brand accounts, media companies, entertainment studios
- Accounts with zero relevance to motivation, mindset, wealth, gym, or entrepreneurship
- Spam or bot accounts with gibberish bios
- Pure personal lifestyle (selfies, travel, food, pets) with NO hustle/fitness/motivation angle
- Traditional life coaches, therapists, HR consultants with no digital/fitness angle

CRITICAL ANTI-ICP (reject immediately, anti_icp: true):
- Local physical businesses: restaurants, cafes, tiendas, acai, bakeries, physical retail
- Corporate/HR consulting, therapists, spiritual coaches (no wealth/fitness angle)

IMPORTANT LANGUAGE NOTE: Spanish-language profiles are FULLY VALID targets. Do not penalize accounts for being in Spanish. "natty", "mentalidad", "entrenamiento", "mejor versión", "disciplina" are strong ICP signals.

Reply ONLY with a valid JSON array matching the input order:
[ { "username": "user1", "is_human_creator": true, "confidence": 91, "anti_icp": false, "reason": "Physique/natty creator, bio shows stats and natty flag, Argentina" }, ... ]`;

    const SYSTEM_PROMPT = icpType === 'faceless_clipper' ? FACELESS_CLIPPER_SYSTEM_PROMPT : FITNESS_SYSTEM_PROMPT;

    // Chunk into batches
    const batches: Lead[][] = [];
    for (let i = 0; i < leads.length; i += ICP_SOFT_FILTER_BATCH_SIZE) {
      batches.push(leads.slice(i, i + ICP_SOFT_FILTER_BATCH_SIZE));
    }

    // Process all batches concurrently — each batch mutates a disjoint slice of leads,
    // so parallel execution is safe. OpenAI rate limits for gpt-4o-mini are generous
    // and ≤3 concurrent calls are well within quota.
    await Promise.all(batches.map(async (batch, batchIdx) => {
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
          const isAntiIcp = (result as any).anti_icp === true;
          if (usernameMatch && passes === true && result.confidence >= 70 && !isAntiIcp) {
            lead.icp_verified = true;
            verifiedCount++;
            onLog(`[ICP SOFT] ✓ @${lead.ig_handle} → ICP verified (${result.confidence}% confidence)`);
          } else {
            lead.icp_verified = false;
            if (isAntiIcp) {
              (lead as any).anti_icp = true;
              onLog(`[ICP SOFT] 🚫 @${lead.ig_handle} → ANTI-ICP detected: ${result.reason || 'no reason given'}`);
            } else {
              onLog(`[ICP SOFT] ✗ @${lead.ig_handle} → ${passes ? `Low confidence (${result.confidence}%)` : `Not ICP`}: ${result.reason || 'no reason given'}`);
            }
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
    }));

    const totalVerified = leads.filter(l => l.icp_verified).length;
    onLog(`[ICP SOFT] Total: ${totalVerified}/${leads.length} ICP verified (${leads.length - totalVerified} unverified but kept)`);

    return leads;
  }
}

export const icpEvaluator = new ICPEvaluator();
