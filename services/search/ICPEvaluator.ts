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
  'golfer', 'rugbyplayer', 'surfer', 'kitesurfer', 'skateboarder', 'snowboarder',
  // Combat / contact sports — reject unless gym override present
  'wrestling', 'wrestler', 'lucha libre', 'mma', 'ufc', 'boxing', 'boxer',
  'fighter', 'martial arts', 'jiujitsu', 'judo', 'karate'
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
  // Elite athletes and modeling agencies
  'pro athlete', 'professional athlete', 'championship', 'competitor',
  'medalist', 'olympian', 'actor', 'actress', 'model agency',
  // UGC creators — paid ad content for brands, NOT the organic clipper/editor archetype
  'ugc creator', 'user generated content', 'content for brands', 'brand deals',
  'sponsored content creator', 'paid partnerships only',
  // Music / audio / dance niches — these accounts use "dm for promo" language just like our ICP
  // but they're promoting music/audio/dance content, NOT motivation/hustle/fitness.
  // @foreva.safia bio: "Dancer | Dm for promo/collabs" → 'dancer' catches it.
  // @cath7rsis bio: "scenepacks on instagram / dm for sound promos" → 'scenepack'+'sound promo'.
  'dancer', 'dancing', 'choreograph',
  'scenepack', 'scenepacks',
  'sound promo', 'sound promotion', 'music promo', 'music promotion',
  'anime edit', 'anime edits',
];

// Handle-only anti-ICP substrings — checked against the USERNAME only, not bio.
// These are too risky to match in full bio text (e.g. "record" could appear in "track record")
// but are highly reliable niche signals when present in a TikTok handle.
// @spinningtherecord: handle contains "record" → music/vinyl DJ page, NOT our ICP.
const ANTI_ICP_HANDLE_KEYWORDS = [
  'record',    // "spinningtherecord", "vinylrecords", "therecordshop" — music/vinyl
  'vinyl',     // vinyl DJ/music pages
  'djset',     // DJ sets
  'djpage',    // DJ page
  'musicpage', // music page
  'dancepage', // dance page
  'dancelife', // dance lifestyle page
];

// Tier-1: explicit creator-economy signals — pass ALONE (high precision).
// Any account with ONE of these in bio/name/handle is a valid candidate.
const FACELESS_CLIPPER_TIER1_KEYWORDS = [
  'clipper', 'editor', 'edits', 'editing',
  'dm for promo', 'dm for promos', 'dm for collab', 'dm for rates',
  'payhip', 'gumroad',
  'skool', 'wop', 'smma',
  'clipping', 'daily clips',
  '💸', '💰', '🤑',
];

// Tier-2: generic signals — require THREE or more present to pass.
// Raising the bar from 2 to 3 prevents generic fitness/lifestyle influencers from
// passing on "mindset + motivation" alone (2 hits no longer sufficient).
const FACELESS_CLIPPER_TIER2_KEYWORDS = [
  'mindset', 'motivation', 'wealth', 'hustle', 'grind',
  'entrepreneur', 'entrepreneurship', 'clips', 'clip',
  'money', 'discipline', 'hardwork', 'noexcuses', 'neversettle',
  'nodaysoff', 'grindset', 'bestversion', 'selfimprovement',
  'wifimoney', 'passiveincome', 'financialfreedom', 'makemoney', 'onlinebusiness',
  'hormozi', 'gadzhi', 'tate', 'goggins',
  'moneymindset', 'dailymotivation',
  // Fitness faceless slideshow signals — present in video caption hashtags.
  // The Hashtag Discovery loop enriches empty bios with these caption terms so they
  // fire in the hard filter. Combined with motivation/discipline/gains → easily ≥3 hits.
  'gymmotivation', 'gymtok', 'gymlife', 'fitspo', 'gymrat',
  'physique', 'gains', 'fitness', 'gym',
  // Re-added at TIER2 (not TIER1): safe now UGC terms are in ANTI_ICP_BIO_KEYWORDS
  'slideshow', 'carousel',
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

      // Follower range — TikTok faceless/clipper accounts scale much higher than Instagram personal brands
      const maxFollowers = icpType === 'faceless_clipper' ? 1_000_000 : HARD_FILTER_MAX_FOLLOWERS;
      if (followers < HARD_FILTER_MIN_FOLLOWERS) {
        onLog(`[HARD FILTER] ↓ @${handle} skip: ${followers.toLocaleString()} < min ${HARD_FILTER_MIN_FOLLOWERS.toLocaleString()} followers`);
        rejections.followerLow++;
        continue;
      }
      if (followers > maxFollowers) {
        onLog(`[HARD FILTER] ↑ @${handle} skip: ${followers.toLocaleString()} > max ${maxFollowers.toLocaleString()} followers`);
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

      // Anti-ICP bio keyword check — rejects physical businesses, corporate accounts, music/dance.
      // Applies to BOTH icpTypes: these profiles are never valid targets regardless of ICP.
      const antiIcpKw = ANTI_ICP_BIO_KEYWORDS.find(kw => fullText.includes(kw));
      if (antiIcpKw) {
        onLog(`[HARD FILTER] 🚫 @${handle} skip: Anti-ICP keyword "${antiIcpKw}" detected in bio/name`);
        rejections.antiIcp++;
        continue;
      }

      // Handle-only anti-ICP check — catches music/vinyl/DJ pages whose bios look like ICP
      // (they use "dm for promo" + Gmail but are promoting music, not motivation/hustle).
      // Checked against HANDLE ONLY to avoid false positives on bio text.
      const antiHandleKw = ANTI_ICP_HANDLE_KEYWORDS.find(kw => handle.includes(kw));
      if (antiHandleKw) {
        onLog(`[HARD FILTER] 🎵 @${handle} skip: music/audio handle signal "${antiHandleKw}" in username`);
        rejections.antiIcp++;
        continue;
      }

      // Non-gym / combat sport check — applies to BOTH icpTypes, no override.
      // Presence of cycling/mma/agency/etc. causes rejection regardless of
      // any accompanying gym/fitness keywords.
      const nonGymSport = NON_GYM_SPORT_KEYWORDS.find(kw => fullText.includes(kw));
      if (nonGymSport) {
        onLog(`[HARD FILTER] 🚴 @${handle} skip: non-gym/combat sport "${nonGymSport}" detected`);
        rejections.nonGymSport++;
        continue;
      }

      if (icpType === 'faceless_clipper') {
        // Tiered signal check:
        //   Tier-1 hit (explicit creator-economy signal) → pass alone
        //   Tier-2 hits ≥ 2 (generic signals, e.g. "gym" + "motivation") → pass together
        //   Everything else → reject (prevents e.g. "gym" or "discipline" alone from passing)
        const tier1Hit = FACELESS_CLIPPER_TIER1_KEYWORDS.some(kw => fullText.includes(kw));
        const tier2Hits = FACELESS_CLIPPER_TIER2_KEYWORDS.filter(kw => fullText.includes(kw));
        const hasClipperSignal = tier1Hit || tier2Hits.length >= 3;
        if (!hasClipperSignal) {
          onLog(`[HARD FILTER] 🚫 @${handle} skip: insufficient ICP signal (tier-1: none, tier-2: ${tier2Hits.length}/3 needed)`);
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
   * Snippet ICP scorer — runs synchronously on Google Search snippet + title text,
   * BEFORE paying for the TikTok profile scraper.
   *
   * Returns a score indicating how much ICP signal is present:
   *   3 = Tier-1 hit (explicit creator-economy term) → very likely ICP
   *   2 = Tier-2 hits ≥ 2 (e.g. "mindset" + "clips")  → probably ICP
   *   1 = Tier-2 hits = 1 (weak signal)               → uncertain
   *   0 = no signal                                    → likely non-ICP
   *
   * Called with the lowercase snippet+title string to avoid re-lowercasing inside.
   * Uses FACELESS_CLIPPER_TIER1/TIER2 constants — no duplication with applyHardFilter.
   */
  public scoreSnippetIcp(text: string): number {
    const tier1Hit = FACELESS_CLIPPER_TIER1_KEYWORDS.some(kw => text.includes(kw));
    if (tier1Hit) return 3;
    const tier2Hits = FACELESS_CLIPPER_TIER2_KEYWORDS.filter(kw => text.includes(kw));
    if (tier2Hits.length >= 3) return 2;
    if (tier2Hits.length === 1) return 1;
    return 0;
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

    const FACELESS_CLIPPER_SYSTEM_PROMPT = `You are a talent scout for a creator outreach agency. Your job is to decide whether each profile belongs to one of the TARGET CREATOR ARCHETYPES below. We target English-speaking markets (US, CA, UK, AU).

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

3. MONEY / WEALTH FACELESS ACCOUNT
   - Emoji-heavy name (💸, 🤑, 💰), minimal or no bio
   - Handle may contain: money, wealth, finance, hustle
   - Accept if username + name context clearly signal money/finance/hustle niche in English

4. CAROUSEL / SLIDESHOW CREATOR AT SCALE
   - Posts TikTok carousels/slideshows in high volume (100s–1000s of videos per month)
   - Content: motivational quote slides, mindset/wealth sequences, self-improvement tip lists
   - This is the PRIMARY target archetype: high-volume content factory
   - Business model: content factory looking for scalable revenue streams
   - Signals: many videos, "slideshow" or "carousel" in bio, high like-to-follower ratio

5. ENTREPRENEUR BEGINNER / DIGITAL HUSTLE
   - Obsessed with making money online, follows Hormozi/Gadzhi content
   - May be in Skool or WOP communities, references SMMA, agency, digital business
   - Bio signals: "building my empire", "SMMA", "agency owner", "digital creator"
   - May not be successful yet — the entrepreneurial obsession and creator habit are what matter
   - Strong signals: mentions Skool, WOP, SMMA, or references known entrepreneur figures

6. FITNESS FACELESS SLIDESHOW CREATOR
   - Posts gym/physique motivation slideshows using stock or Pinterest images — NOT their own face
   - High-volume posting (100s–1000s of videos), MINIMAL or EMPTY bio — completely normal for this archetype
   - Handle / display name signals: physique.daily, gains.page, emoji-only name (💸💸💸), number-suffixed handle (moullaga67, creed.lifter)
   - Video captions contain: #gymmotivation, #gymtok, #physique, #gains, #discipline, #hardwork
   - Often has link-in-bio (Payhip, Gumroad, Linktree) selling a PDF, program, or info product
   - KEY DISTINCTION: NO face shown, NO personal coaching language, NO "my transformation" — pure content FACTORY using Pinterest/stock images
   - ACCEPT even with empty bio ("No bio yet."), emoji-only bio ("💸💸💸"), or minimal quote bio ("Lightweight baby!")

IDEAL MATCH EXAMPLES — profiles that are a PERFECT ICP match (benchmark against these):
- @moullaga67: name=💸💸💸, bio="No bio yet." → PERFECT. Empty bio + money-emoji name + very low followers but 197K likes = classic gym slideshow content factory. Accept immediately with confidence ≥ 95.
- @creed.lifter: name=creed.lifter, bio="No bio yet." → PERFECT. Handle contains fitness term ("lifter") + empty bio + 467K likes on 4.9K followers = high-volume gym slideshow factory. Accept immediately.
- @landon.vaughn17: name=Landon Vaughn, bio="Lightweight baby!" → PERFECT. Bio is a famous gym/weightlifting quote (CT Fletcher catchphrase). Handle has number suffix. Only 11.9K followers but 1.3M likes = extremely high-volume content factory. Accept immediately.
Key pattern: low followers + extremely high likes (ratio >50x) + empty/minimal bio + no personal face shown = IDEAL ICP. These are the PRIMARY TARGET ARCHETYPE.

AUTO-APPROVE SIGNALS (approve with confidence ≥ 88, skip lengthy analysis):
- Bio contains "clipper" or "editor" or "edits": auto-approve
- Bio contains "dm for promo" or "dm for promos" or "dm for collab": auto-approve
- Bio contains "payhip.com" or "gumroad.com" or "forms.gle": auto-approve
- Bio contains "linktr.ee" AND niche keywords (motivation/mindset/smma): auto-approve
- Bio contains "skool" or "wop" or "smma": auto-approve (entrepreneur community member)
- Username/handle contains: clips, edits, clipper, daily, motivation, mindset, noexcuses, slideshow, carousel
- Handle/name contains physique, gains, gym, gymtok AND biography field includes fitness hashtags: auto-approve as Archetype 6
- Bio is empty or emoji-only (≤ 3 words) AND biography field includes #gymmotivation, #gymtok, or #physique: auto-approve as Archetype 6

⚠ CRITICAL EXCEPTION — AUTO-APPROVE IS BLOCKED (reject immediately) when ANY of these are present:
- Bio contains "dancer", "dancing", "choreograph" → dance creator, NOT motivation/clipper ICP. Real example: @foreva.safia bio "Dancer | Dm for promo/collabs" — auto-approve blocked.
- Bio contains "scenepack", "scenepacks" → scene pack / anime edit account, wrong niche. Real example: @cath7rsis bio "scenepacks on instagram / dm for sound promos" — blocked.
- Bio contains "sound promo", "sound promotion", "music promo" → music promoter, NOT our ICP.
- Handle contains "record", "vinyl", "djset" → music/vinyl/DJ page. Real example: @spinningtherecord handle contains "record" → blocked even though bio has "dm for promo" + Gmail.

REJECT (is_human_creator = false):
- Large official brand accounts, media companies, entertainment studios
- Accounts with zero relevance to motivation, mindset, wealth, or entrepreneurship
- Spam or bot accounts with gibberish bios
- Pure personal lifestyle (selfies, travel, food, pets) with NO hustle/motivation/business angle
- Traditional life coaches, therapists, HR consultants with no digital/business angle
- Professional athletes, fighters, wrestlers, or sports competitors
- Accounts posting primarily in a non-English language (Spanish, Portuguese, French, etc.)
- UGC creators, "content for brands" creators, "content for hire" creators: these are paid ad video producers, NOT the organic faceless clipper/editor archetype we want. Reject them.

CRITICAL ANTI-ICP (reject immediately, anti_icp: true):
- UGC creators, user-generated content creators, "content for brands" accounts, brand-deal-focused accounts. These produce paid ad content for companies. We want organic clippers and editors, not commercial content producers. Reject immediately.
- Personal fitness FACE creators: accounts posting their OWN workout videos, OWN body transformation ("my physique progress"), or with personal coaching bios ("Certified PT", "1-on-1 coaching", "DM for coaching"). These are personal brands — reject immediately.
- NOTE: FITNESS FACELESS SLIDESHOW CREATORS (Archetype 6) are VALID TARGETS. Empty bio + fitness hashtags in video captions + high-volume slideshows = ACCEPT. When uncertain between "personal fitness brand" vs "fitness faceless factory", prefer ACCEPT.
- Music promoters, DJ accounts, vinyl/record pages, sound promoters: bio has "dm for sound promos", "music promo", or handle contains "record"/"vinyl"/"djset". They use "dm for promo" language but are in the MUSIC niche — NOT our ICP. Reject immediately.
- Dance creators, choreographers: bio says "dancer", "dancing", "choreograph". "Dm for promo/collabs" does NOT save them — wrong niche entirely. Reject immediately.
- Scene pack / aesthetic edit accounts: bio says "scenepacks", "anime edits", "aesthetic edits". Entertainment editors who promote sounds/music, not motivation/hustle content factories. Reject immediately.
- Local physical businesses: restaurants, cafes, acai, bakeries, physical retail
- Corporate/HR consulting, therapists, spiritual coaches (no wealth/business angle)
- Accounts posting primarily in a non-English language

Reply ONLY with a valid JSON array matching the input order:
[ { "username": "user1", "is_human_creator": true, "confidence": 91, "anti_icp": false, "reason": "Clipper/editor with DM-for-promo signal, EN-speaking" }, ... ]`;

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
          if (usernameMatch && passes === true && result.confidence >= 80 && !isAntiIcp) {
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
    onLog(`[ICP SOFT] Total: ${totalVerified}/${leads.length} ICP verified (${leads.length - totalVerified} unverified → dropped by engine)`);

    return leads;
  }
}

export const icpEvaluator = new ICPEvaluator();
