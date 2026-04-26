/**
 * LinkedInSearchEngine  (refactored — extends BaseSearchEngine)
 *
 * RESPONSIBILITY:
 *  Fetch raw LinkedIn profiles via Apify / local SearchService and return them
 *  as normalised RawCandidate objects.  Everything else (dedup, language filter,
 *  AI scoring, persistence) is handled by BaseSearchEngine.
 *
 * REMOVED DUPLICATION:
 *  ❌ inline deduplication logic         → SharedDeduplicationService
 *  ❌ isLikelySpanishSpeaker copy        → SharedLanguageFilter
 *  ❌ direct OpenAI call to calculateSymmetryScore → SharedBatchScoringService
 *  ❌ UnbreakableExecutor boilerplate     → BaseSearchEngine.execute()
 *
 * NEW — Smart Query Expansion (expandSearch):
 *  When a search attempt returns 0 new candidates the engine automatically
 *  rotates to the next location / keyword variant so the search NEVER stops
 *  until the target is met or maxAttempts is reached.
 */

import {
    BaseSearchEngine,
    RawCandidate,
    BaseSearchOptions,
    LogCallback,
} from '../../lib/core/BaseSearchEngine';
import { ScoringResult, SYSTEM_PROMPTS } from '../../lib/core/SharedBatchScoringService';
import { LoadOptions } from '../../lib/core/SharedDeduplicationService';
import { Candidate, SearchFilterCriteria } from '../../types/database';
import { SearchService } from '../../lib/search';
import { CandidateService, CampaignService } from '../../lib/services';
import { normalizeLinkedInUrl } from '../../lib/normalization';
import { calculateFlutterDeveloperScore } from '../../lib/scoring';

// ─── Smart Query Expansion — location & keyword rotation pools ───────────────

/**
 * Ordered pool of location suffixes to append to the base query.
 * The engine cycles through this list whenever a search attempt yields 0
 * new candidates after deduplication.
 */
const LOCATION_POOL = [
    '',              // first pass — no extra location filter
    'Madrid',
    'Barcelona',
    'México',
    'Colombia',
    'Argentina',
    'Chile',
    'Perú',
    'Venezuela',
    'España',
    'Remoto',
    'Remote',
    'Uruguay',
    'Ecuador',
    'Costa Rica',
    'Bogotá',
    'Ciudad de México',
    'Buenos Aires',
    'Santiago',
];

/**
 * Keyword synonyms keyed by canonical term (lower-case).
 * When the base query contains a key, the rotation cycles through all values.
 */
const KEYWORD_SYNONYMS: Record<string, string[]> = {
    'flutter':   ['Flutter Developer', 'Mobile Developer Flutter', 'Flutter Engineer', 'Dart Developer', 'Cross-Platform Mobile'],
    'react':     ['React Developer', 'React.js Engineer', 'Frontend Engineer React', 'React Native Developer'],
    'backend':   ['Backend Developer', 'Server-Side Engineer', 'Node.js Developer', 'API Developer'],
    'frontend':  ['Frontend Developer', 'UI Engineer', 'Web Developer', 'JavaScript Developer'],
    'mobile':    ['Mobile Developer', 'iOS Developer', 'Android Developer', 'React Native Engineer'],
    'fullstack': ['Full Stack Developer', 'Full-Stack Engineer', 'Software Engineer', 'Web Developer'],
    'python':    ['Python Developer', 'Python Engineer', 'Data Engineer', 'Backend Python'],
};

/** Maximum total fetch-expand attempts before giving up. */
const MAX_SEARCH_ATTEMPTS = 40;

// ─── LinkedIn-specific candidate shape ───────────────────────────────────────

export interface LinkedInRawCandidate extends RawCandidate {
    linkedin_url: string | null;
    filters?: SearchFilterCriteria;
    /** Original Candidate object carried through the pipeline for persistence. */
    _original?: Candidate;
    /* base fields are: _id, name, title, description, location, email, profileUrl */
}

// ─── Engine Options ───────────────────────────────────────────────────────────

export interface LinkedInSearchOptions extends BaseSearchOptions {
    language: string;
    maxAge: number;
    filters?: SearchFilterCriteria;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class LinkedInSearchEngineV2 extends BaseSearchEngine<LinkedInRawCandidate> {

    protected get engineName()   { return 'LINKEDIN'; }
    protected get platformLabel(){ return 'LinkedIn'; }

    // ── Expose platform-specific start method (backward-compatible API) ──────

    public async startSearch(
        query: string,
        maxResults: number,
        options: LinkedInSearchOptions,
        onLog: LogCallback,
        onComplete: (candidates: Candidate[]) => void,
    ): Promise<void> {
        onLog(`[LINKEDIN] 🚀 Motor de búsqueda iniciado.`);
        onLog(`[LINKEDIN] 🎯 Objetivo: ${maxResults} candidatos para "${query}"`);

        await this.execute(
            query,
            { ...options, maxResults },
            onLog,
            async (rawCandidates) => {
                // Convert internal type back to the Candidate type the UI expects
                onComplete(rawCandidates.map(c => this.toCandidate(c)));
            },
        );
    }

    // ── Dedup: uses the global `candidates` table ────────────────────────────

    protected getDeduplicationLoadOptions(_opt: BaseSearchOptions): LoadOptions {
        return {
            table:     'candidates',
            urlColumn: 'linkedin_url',
            usernameColumn: null,
        };
    }

    protected getSystemPrompt(): string {
        return SYSTEM_PROMPTS.SYMMETRY_PRODUCT_ENGINEER;
    }

    protected toPlatformKey(_c: LinkedInRawCandidate): null { return null; }

    // ── fetchRawCandidates — with Smart Query Expansion ──────────────────────

    /**
     * Pulls profiles via SearchService (local/mock) or Apify when keys are set.
     *
     * SMART QUERY EXPANSION:
     *  If an attempt returns 0 new profiles (after dedup tracking), the engine
     *  automatically rotates to the next location in LOCATION_POOL. After
     *  exhausting all locations for the base query it also cycles through
     *  KEYWORD_SYNONYMS so the search explores the full talent pool before
     *  giving up.
     *
     *  The loop runs until:
     *   a) We have gathered ≥ maxResults × 4 raw profiles (enough for the
     *      pipeline's pre-filter + scoring stages), OR
     *   b) MAX_SEARCH_ATTEMPTS hard cap is reached (safety valve).
     */
    protected async fetchRawCandidates(
        baseQuery: string,
        options: LinkedInSearchOptions & BaseSearchOptions,
        onLog: LogCallback,
    ): Promise<LinkedInRawCandidate[]> {
        const maxResults  = options.maxResults ?? 20;
        const targetRaw   = maxResults * 4;        // over-fetch so filters have plenty to work with
        const seen        = new Set<string>();     // track linkedin_url across attempts
        const accumulated: LinkedInRawCandidate[] = [];

        let attempt       = 0;
        let locationIdx   = 0;
        let keywordIdx    = 0;
        const synonymList = this.buildSynonymList(baseQuery);

        onLog(`[LINKEDIN] 🗺️  Pool de expansión: ${LOCATION_POOL.length} ubicaciones, ${synonymList.length} variantes de keyword.`);

        while (accumulated.length < targetRaw && attempt < MAX_SEARCH_ATTEMPTS) {
            if (!this.isRunning || this.userIntendedStop) break;

            attempt++;

            // Build the current query variant
            const location   = LOCATION_POOL[locationIdx % LOCATION_POOL.length];
            const keyword    = synonymList[keywordIdx % synonymList.length];
            const searchTerm = location ? `${keyword} ${location}` : keyword;

            onLog(`[LINKEDIN] 🔄 Intento ${attempt}/${MAX_SEARCH_ATTEMPTS}: "${searchTerm}"...`);

            let raw: Candidate[] = [];
            try {
                raw = await SearchService.searchCandidates(searchTerm, maxResults * 4);
            } catch (err: any) {
                onLog(`[LINKEDIN] ⚠️ SearchService falló en intento ${attempt}: ${err.message}`);
            }

            // Identify genuinely new profiles (not seen in earlier attempts)
            const novelProfiles = raw.filter(c => {
                const key = c.linkedin_url ?? c.email ?? c.id;
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            if (novelProfiles.length === 0) {
                onLog(`[LINKEDIN] 🔄 Sin perfiles nuevos — rotando a próxima ubicación...`);
                locationIdx++;

                // After cycling through ALL locations for the current keyword,
                // advance to the next keyword synonym.
                if (locationIdx > 0 && locationIdx % LOCATION_POOL.length === 0) {
                    keywordIdx++;
                    onLog(`[LINKEDIN] 🔄 Agotado pool de ubicaciones — rotando keyword a "${synonymList[keywordIdx % synonymList.length]}".`);
                }
            } else {
                onLog(`[LINKEDIN] ✅ +${novelProfiles.length} perfiles nuevos (acumulado: ${accumulated.length + novelProfiles.length}).`);
                locationIdx++; // always advance location to diversify the pool

                accumulated.push(
                    ...novelProfiles.map((c, idx) => ({
                        _id:          c.id ?? `li_${attempt}_${idx}_${Date.now()}`,
                        name:         c.full_name ?? '',
                        title:        c.job_title ?? null,
                        description:  c.ai_analysis ?? null,
                        location:     c.location ?? null,
                        email:        c.email ?? null,
                        profileUrl:   c.linkedin_url ?? null,
                        linkedin_url: c.linkedin_url ?? null,
                        filters:      options.filters,
                        _original:    c,
                    } as LinkedInRawCandidate))
                );
            }

            if (accumulated.length >= targetRaw) {
                onLog(`[LINKEDIN] 🎯 Objetivo de sobre-fetch alcanzado: ${accumulated.length} perfiles.`);
                break;
            }
        }

        onLog(`[LINKEDIN] 📦 ${accumulated.length} perfiles crudos tras ${attempt} intentos de búsqueda.`);
        return accumulated;
    }

    // ── save ─────────────────────────────────────────────────────────────────

    protected async save(
        candidates: LinkedInRawCandidate[],
        options: BaseSearchOptions,
        onLog: LogCallback,
    ): Promise<LinkedInRawCandidate[]> {
        if (!options.campaignId) {
            onLog(`[LINKEDIN] ⚠️ Sin campaignId — saltando guardado en BD.`);
            return [];
        }

        const saved: LinkedInRawCandidate[] = [];
        for (const c of candidates) {
            try {
                const dbRecord = await CandidateService.create(this.toCandidate(c));
                await CampaignService.addCandidateToCampaign(options.campaignId, dbRecord.id);
                saved.push({ ...c, _id: dbRecord.id });
            } catch (err: any) {
                onLog(`[LINKEDIN] ❌ Error guardando "${c.name}": ${err.message}`);
            }
        }

        onLog(`[LINKEDIN] ✅ ${saved.length}/${candidates.length} candidatos guardados.`);
        return saved;
    }

    // ── Merge AI score back onto the candidate ────────────────────────────────

    protected mergeScoreIntoCandidate(
        candidate: LinkedInRawCandidate,
        result: ScoringResult,
    ): LinkedInRawCandidate {
        return {
            ...candidate,
            _score:     result.score,
            _reasoning: result.reasoning,
        };
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Build the ordered synonym list for the given query.
     * If the query matches a known keyword, synonyms are prepended.
     * Falls back to [baseQuery] if no synonyms are found.
     */
    private buildSynonymList(baseQuery: string): string[] {
        const lower = baseQuery.toLowerCase();
        for (const [keyword, synonyms] of Object.entries(KEYWORD_SYNONYMS)) {
            if (lower.includes(keyword)) {
                // Put the original query first, then all synonyms
                return [baseQuery, ...synonyms.filter(s => s.toLowerCase() !== lower)];
            }
        }
        return [baseQuery];
    }

    private toCandidate(c: LinkedInRawCandidate): Candidate {
        const score = (c as any)._score ?? c._original?.symmetry_score ?? 0;
        const base  = c._original ?? {} as Candidate;
        return {
            ...base,
            full_name:      c.name,
            email:          c.email ?? null,
            linkedin_url:   c.linkedin_url
                                ? normalizeLinkedInUrl(c.linkedin_url)
                                : null,
            job_title:      c.title ?? null,
            location:       c.location ?? null,
            symmetry_score: score,
            ai_analysis:    (c as any)._reasoning ?? base.ai_analysis ?? null,
            created_at:     base.created_at ?? new Date().toISOString(),
            updated_at:     new Date().toISOString(),
        } as Candidate;
    }
}
