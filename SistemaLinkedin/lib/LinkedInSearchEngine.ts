
import { Candidate, SearchFilterCriteria } from '../../types/database';
import { calculateFlutterDeveloperScore } from '../../lib/scoring';
import { deduplicationService } from '../../lib/deduplication';
import { SearchService } from '../../lib/search';
import { normalizeLinkedInUrl } from '../../lib/normalization';
import { UnbreakableExecutor, initializeUnbreakableMarker } from '../../lib/UnbreakableExecution';
import { isLikelySpanishSpeaker } from './spanishLanguageFilter';
import { CandidateService, CampaignService } from '../../lib/services';

export type LogCallback = (message: string) => void;

// Apify Actor IDs
const GOOGLE_SEARCH_SCRAPER = 'nFJndFXA5zjCTuudP';

/**
 * LinkedInSearchEngine: Specialized search engine for LinkedIn profiles
 * Handles the LinkedIn Radar methodology with optimized queries and AI analysis
 */
export class LinkedInSearchEngine {
    // UNBREAKABLE EXECUTION MODE
    private isRunning = false;
    private userIntentedStop = false;

    private apiKey = '';
    private openaiKey = '';
    private abortController: AbortController | null = null;
    private unbreakableExecutor: UnbreakableExecutor | null = null;

    // Campaign-level context for AI messages
    private _roleKeyword = '';
    private _icpDescription = '';

    constructor() {
        initializeUnbreakableMarker();
    }

    public stop() {
        this.userIntentedStop = true;
        this.isRunning = false;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        if (this.unbreakableExecutor) {
            this.unbreakableExecutor.stop('User clicked stop button');
        }
    }

    public async startSearch(
        query: string,
        maxResults: number,
        options: {
            language: string;
            maxAge: number;
            filters?: SearchFilterCriteria;
            scoreThreshold?: number;
            campaignId?: string;
            roleKeyword?: string;
            icpDescription?: string;
        },
        onLog: LogCallback,
        onComplete: (candidates: Candidate[]) => void
    ) {
        this.isRunning = true;
        this.userIntentedStop = false;
        this.abortController = new AbortController();
        this.apiKey = import.meta.env.VITE_APIFY_API_KEY || '';
        this.openaiKey = import.meta.env.VITE_OPENAI_API_KEY || '';
        this._roleKeyword = options.roleKeyword || '';
        this._icpDescription = options.icpDescription || '';

        // BUG FIX: Emit diagnostic logs immediately so the UI shows something right away
        onLog(`[LINKEDIN] 🚀 Motor de búsqueda iniciado.`);
        onLog(`[LINKEDIN] 🔑 Modo: ${this.apiKey ? 'Apify (APIs externas activas)' : '⚡ Rápido (sin API key — usando datos locales)'}`);
        if (!this.apiKey) {
            onLog(`[LINKEDIN] ℹ️ Para activar búsqueda real configura VITE_APIFY_API_KEY en .env`);
        }
        onLog(`[LINKEDIN] 🎯 Objetivo: ${maxResults} candidatos para "${query}"`);

        const campaignId = options.campaignId || `campaign_${Date.now()}`;
        this.unbreakableExecutor = new UnbreakableExecutor(campaignId);

        try {
            this.unbreakableExecutor.run(
                async () => {
                    await this.executeCoreSearch(
                        query,
                        maxResults,
                        options,
                        onLog,
                        onComplete
                    );
                },
                (state) => {
                    onLog(`[EXECUTOR] Estado: ${state}`);
                }
            ).catch((err) => {
                if (!this.userIntentedStop) {
                    onLog(`[ERROR] ❌ Error crítico en el motor: ${err.message}`);
                    console.error('[LINKEDIN] startSearch executor error:', err);
                }
                this.isRunning = false;
                // BUG FIX: always call onComplete so DetailView can reset its searching state
                onComplete([]);
            });
        } catch (err: any) {
            onLog(`[ERROR] ❌ ${err.message}`);
            console.error('[LINKEDIN] startSearch sync error:', err);
            this.isRunning = false;
            onComplete([]);
        }
    }

    /**
     * Saves accepted candidates to Supabase and links them to the campaign.
     * Logs every step through onLog so errors are visible in the UI log panel.
     */
    private async saveCandidatesToDatabase(
        candidates: Candidate[],
        campaignId: string | undefined,
        onLog: LogCallback
    ): Promise<Candidate[]> {
        if (candidates.length === 0) return [];
        if (!campaignId) {
            onLog(`[LINKEDIN] ⚠️ Sin campaignId — saltando guardado en BD.`);
            return [];
        }

        onLog(`[LINKEDIN] 💾 Iniciando guardado de ${candidates.length} candidatos en Supabase...`);
        const savedCandidates: Candidate[] = [];

        for (const candidate of candidates) {
            try {
                const saved = await CandidateService.create(candidate);
                await CampaignService.addCandidateToCampaign(campaignId, saved.id);
                savedCandidates.push(saved);
            } catch (err: any) {
                console.error('[LINKEDIN] Error guardando candidato:', candidate.full_name, err);
                onLog(`[LINKEDIN] ❌ Error guardando "${candidate.full_name}": ${err.message}`);
            }
        }

        if (savedCandidates.length > 0) {
            onLog(`[LINKEDIN] ✅ Guardado exitoso: ${savedCandidates.length}/${candidates.length} candidatos en Supabase.`);
        } else {
            onLog(`[LINKEDIN] ❌ Ningún candidato pudo guardarse — revisa los errores anteriores.`);
        }

        return savedCandidates;
    }

    /** Fetch existing candidates with a hard timeout so Supabase latency never hangs the search */
    private async fetchDeduplicationDataSafe(onLog: LogCallback): Promise<{ existingEmails: Set<string>; existingLinkedin: Set<string> }> {
        onLog(`[DEDUP] 🔍 Cargando base de datos para evitar duplicados...`);
        try {
            const result = await Promise.race([
                deduplicationService.fetchExistingCandidates(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('DEDUP_TIMEOUT')), 15000)
                )
            ]);
            onLog(`[DEDUP] ✅ ${result.existingEmails.size} emails y ${result.existingLinkedin.size} perfiles conocidos ignorados.`);
            return result;
        } catch (err: any) {
            if (err.message === 'DEDUP_TIMEOUT') {
                onLog(`[DEDUP] ⚠️ Timeout (15s) cargando duplicados — continuando sin deduplicación.`);
            } else {
                onLog(`[DEDUP] ⚠️ Error cargando duplicados: ${err.message} — continuando.`);
                console.error('[LINKEDIN] fetchDeduplicationDataSafe error:', err);
            }
            return { existingEmails: new Set(), existingLinkedin: new Set() };
        }
    }

    private async executeCoreSearch(
        query: string,
        maxResults: number,
        options: any,
        onLog: LogCallback,
        onComplete: (candidates: Candidate[]) => void
    ): Promise<void> {
        // OPTIMIZED: Use fast fallback for demo/production without API keys
        if (!this.apiKey || !this.openaiKey) {
            onLog("🚀 Iniciando búsqueda en modo RÁPIDO (Sin APIs externas)...");
            // BUG FIX: must await so executeCoreSearch doesn't return before the search finishes
            await this.startFastSearch(query, maxResults, options, onLog, onComplete);
            return;
        }

        try {
            const { existingEmails, existingLinkedin } = await this.fetchDeduplicationDataSafe(onLog);

            const uniqueCandidates = await this.searchLinkedIn(
                query,
                maxResults,
                options,
                onLog,
                existingEmails,
                existingLinkedin
            );

            const savedCandidates = await this.saveCandidatesToDatabase(uniqueCandidates, options.campaignId, onLog);
            onLog(`[FIN] ✅ ${savedCandidates.length} candidatos guardados en base de datos.`);
            onComplete(savedCandidates);

        } catch (error: any) {
            onLog(`[ERROR] ❌ ${error.message}`);
            onComplete([]);
        }
    }

    private async startFastSearch(
        query: string,
        maxResults: number,
        options: {
            language: string;
            maxAge: number;
            filters?: SearchFilterCriteria;
            scoreThreshold?: number;
            campaignId?: string;
        },
        onLog: LogCallback,
        onComplete: (candidates: Candidate[]) => void
    ) {
        try {
            // BUG FIX: use the safe version with 15s timeout (same as slow path)
            const { existingEmails, existingLinkedin } = await this.fetchDeduplicationDataSafe(onLog);

            const acceptedCandidates: Candidate[] = [];
            // Scale retries based on target: at least 30, up to 100 for large searches
            const MAX_RETRIES = Math.min(100, Math.max(30, Math.ceil(maxResults / 5)));
            // Allow more consecutive dup attempts before early-exit for larger targets
            const MAX_CONSEC_DUPS = maxResults > 50 ? 5 : 3;
            let attempt = 0;
            const seenProfileNames: string[] = [];
            let consecutiveDupAttempts = 0; // EARLY EXIT

            while (acceptedCandidates.length < maxResults && attempt < MAX_RETRIES && this.isRunning) {
                attempt++;
                const currentQuery = this.getQueryVariation(query, attempt, seenProfileNames);
                onLog(`[SEARCH] 🎯 Intento ${attempt}/${MAX_RETRIES}: Buscando con "${currentQuery}"...`);

                const startTime = performance.now();
                const rawCandidates = await SearchService.searchCandidates(currentQuery, maxResults * 4);
                const duration = performance.now() - startTime;

                onLog(`[SEARCH] ✅ ${rawCandidates.length} candidatos encontrados en ${Math.round(duration / 1000)}s`);

                onLog(`[DEDUP] 🧹 Filtrando duplicados...`);
                const uniqueCandidates = rawCandidates.filter(c => {
                    if (deduplicationService.isDuplicate(c, existingEmails, existingLinkedin)) return false;
                    if (acceptedCandidates.some(ac => ac.email === c.email || ac.linkedin_url === c.linkedin_url)) return false;
                    return true;
                });

                if (uniqueCandidates.length === 0) {
                    consecutiveDupAttempts++;
                    if (consecutiveDupAttempts >= MAX_CONSEC_DUPS) {
                        onLog(`[EARLY-EXIT] 🛑 ${MAX_CONSEC_DUPS} intentos consecutivos con 100% duplicados. El nicho actual está agotado.`);
                        break;
                    }
                    onLog(`[DEDUP] ⚠️ No candidatos nuevos (${consecutiveDupAttempts}/${MAX_CONSEC_DUPS} consecutivos). Reintentando...`);
                    continue;
                }

                // Reset del contador al encontrar candidatos nuevos
                consecutiveDupAttempts = 0;

                // ═══ SPANISH LANGUAGE FILTER (Fast Search path) ═══
                let languageFiltered = uniqueCandidates;
                if (options.language === 'Spanish') {
                    const beforeCount = languageFiltered.length;
                    languageFiltered = uniqueCandidates.filter(c => {
                        const result = isLikelySpanishSpeaker(
                            c.full_name,
                            c.job_title,
                            c.ai_analysis || null,
                            c.location
                        );
                        if (!result.isSpanish) {
                            onLog(`[LANG-FILTER] ❌ ${c.full_name} no parece hispanohablante (conf: ${result.confidence})`);
                        }
                        return result.isSpanish;
                    });
                    if (beforeCount !== languageFiltered.length) {
                        onLog(`[LANG-FILTER] 🌐 ${beforeCount - languageFiltered.length} candidatos filtrados por idioma español`);
                    }
                }

                onLog(`[ANALYSIS] 🧠 Generando análisis personalizado (${languageFiltered.length} candidatos)...`);

                const analyzedCandidates = await Promise.all(
                    languageFiltered.map(c => this.enrichCandidateWithAnalysis(c))
                );

                let scoredCandidates = analyzedCandidates;
                if (options.filters) {
                    onLog(`[SCORING] 📊 Aplicando filtro Flutter Developer...`);

                    scoredCandidates = analyzedCandidates
                        .map(candidate => {
                            const scoring = calculateFlutterDeveloperScore(candidate, options.filters!);
                            return {
                                ...candidate,
                                symmetry_score: scoring.breakdown.normalized,
                                score_breakdown: scoring.breakdown
                            };
                        })
                        .filter(c => c.symmetry_score >= (options.scoreThreshold || 70))
                        .sort((a, b) => (b.symmetry_score || 0) - (a.symmetry_score || 0));

                    onLog(`[SCORING] ✅ ${scoredCandidates.length} candidatos cumplen threshold de ${options.scoreThreshold || 70}/100`);
                }

                const candidatesToAdd = scoredCandidates.slice(0, Math.max(0, maxResults - acceptedCandidates.length));
                acceptedCandidates.push(...candidatesToAdd);

                onLog(`[PROGRESS] 📊 ${acceptedCandidates.length}/${maxResults} candidatos encontrados`);

                if (acceptedCandidates.length >= maxResults) {
                    onLog(`[SUCCESS] 🎉 Meta alcanzada en intento ${attempt}`);
                    break;
                }
            }

            if (acceptedCandidates.length === 0) {
                onLog(`[WARNING] ⚠️ No se encontraron candidatos nuevos después de ${attempt} intentos`);
            } else if (acceptedCandidates.length < maxResults) {
                onLog(`[INFO] ℹ️ Se encontraron ${acceptedCandidates.length}/${maxResults} candidatos (menos que el objetivo)`);
            }

            const finalCandidatesFast = acceptedCandidates.slice(0, maxResults);
            const savedCandidatesFast = await this.saveCandidatesToDatabase(finalCandidatesFast, options.campaignId, onLog);
            onLog(`[FIN] ✅ ${savedCandidatesFast.length} candidatos procesados y guardados.`);
            onComplete(savedCandidatesFast);

        } catch (error: any) {
            onLog(`[ERROR] ❌ ${error.message}`);
            onComplete([]);
        }
    }

    private isPMRole(role: string): boolean {
        const lower = role.toLowerCase();
        return /\bproduct\s*manager\b|\bproduct\s*owner\b|\b\bpm\b/.test(lower) ||
               lower.includes('product manager') || lower.includes('product owner');
    }

    private getQueryVariation(baseQuery: string, attempt: number, seenNames: string[]): string {
        // Attempt 1: always use the exact campaign query unmodified
        if (attempt === 1) return baseQuery;

        // ─── Extract campaign role from baseQuery ──────────────────────────────
        // Prefer the first quoted phrase; fall back to the first 3 words
        const quotedRoles = [...baseQuery.matchAll(/"([^"]+)"/g)].map(m => m[1]);
        const campaignRole = quotedRoles[0] || baseQuery.replace(/site:\S+/g, '').trim().split(/\s+/).slice(0, 3).join(' ');

        // ─── Name exclusions: max 3 to avoid Google query bloat ─────────────
        const exclusions = seenNames
            .slice(-3)
            .map(name => {
                const parts = name.replace(/[^a-zA-ZÀ-ÿ\s]/g, '').trim().split(/\s+/);
                return parts[0] && parts[0].length > 2 ? `-"${parts[0]}"` : '';
            })
            .filter(Boolean)
            .join(' ');

        const cities = [
            '"Madrid"', '"Barcelona"', '"Valencia"', '"Sevilla"',
            '"Ciudad de México"', '"Monterrey"', '"Guadalajara"',
            '"Bogotá"', '"Medellín"', '"Buenos Aires"', '"Córdoba"',
            '"Santiago"', '"Lima"', '"Quito"', '"Montevideo"',
        ];

        const idx = attempt - 2; // attempt 1 already consumed above
        const city = cities[idx % cities.length];

        let variation: string;

        if (this.isPMRole(campaignRole)) {
            // ─── PM ROLE: queries focused on B2C / mobile / consumer experience ─────
            // Level 1 (attempts 2-5): exact role + mobile consumer signal + city (priority: mobile consumer first)
            if (attempt <= 5) {
                const b2cSignals = [
                    '("iOS app" OR "Android app" OR "consumer mobile")',
                    '("mobile app" OR "consumer app" OR "B2C mobile")',
                    '("app móvil" OR "consumer product" OR "mobile consumer")',
                    '("React Native" OR "Flutter" OR "consumer app")',
                ];
                const signal = b2cSignals[(attempt - 2) % b2cSignals.length];
                variation = `"Product Manager" ${signal} ${city}`;
            }
            // Level 2 (attempts 6-10): broader PM terms with consumer/startup signals
            else if (attempt <= 10) {
                const broadSignals = [
                    '("mobile" OR "app" OR "consumer")',
                    '("startup" OR "scale-up" OR "growth")',
                    '("B2C" OR "fintech" OR "healthtech" OR "edtech")',
                    '("product" OR "UX" OR "usuarios")',
                    '("retención" OR "engagement" OR "onboarding")',
                ];
                const signal = broadSignals[(attempt - 6) % broadSignals.length];
                variation = `("Product Manager" OR "PM") ${signal} ${city}`;
            }
            // Level 3 (attempts 11+): maximum breadth — any PM with app/consumer signal
            else {
                const keywords = ['mobile app', 'consumer product', 'B2C', 'growth product'];
                const kw = keywords[(attempt - 11) % keywords.length];
                variation = `product manager "${kw}" ${city}`;
            }
        } else {
            // ─── RELAXATION LEVEL 1 (attempts 2-5): exact campaign role + rotating city ─
            // Wide funnel: bring volume, let Scoring AI reject the non-fits
            if (attempt <= 5) {
                variation = `"${campaignRole}" ${city}`;
            }
            // ─── RELAXATION LEVEL 2 (attempts 6-10): drop strict role quotes ──────────
            // More Google results because phrase-exact-match is removed
            else if (attempt <= 10) {
                const lastWord = campaignRole.split(' ').filter(w => w.length > 3).pop() || campaignRole;
                variation = `(${campaignRole} OR "${lastWord} Developer" OR "${lastWord} Engineer") ${city}`;
            }
            // ─── RELAXATION LEVEL 3 (attempts 11+): keyword only, maximum breadth ──────
            else {
                const keyword = campaignRole.split(' ').filter(w => w.length > 3).pop() || campaignRole;
                variation = `${keyword} developer ${city}`;
            }
        }

        if (exclusions) {
            const finalQuery = `${variation} ${exclusions}`;
            return finalQuery.length > 250 ? variation : finalQuery;
        }

        return variation;
    }

    private async enrichCandidateWithAnalysis(candidate: Candidate): Promise<Candidate> {
        if (candidate.ai_analysis) return candidate;

        const analysis = await this.generateAIAnalysis({
            name: candidate.full_name,
            company: candidate.current_company,
            role: candidate.job_title,
            snippet: `${candidate.job_title} at ${candidate.current_company}`,
            query: '',
            maxAge: 30,
            roleKeyword: this._roleKeyword,
            icpDescription: this._icpDescription,
        });

        return {
            ...candidate,
            ai_analysis: JSON.stringify(analysis),
            symmetry_score: analysis.symmetry_score
        };
    }

    private async fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const userSignal = this.abortController?.signal;
        if (userSignal) {
            if (userSignal.aborted) {
                clearTimeout(timeoutId);
                throw new Error('CANCELLED');
            }
            userSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            return res;
        } catch (err: any) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                if (userSignal?.aborted) throw new Error('CANCELLED');
                throw new Error(`TIMEOUT after ${timeoutMs / 1000}s`);
            }
            throw err;
        }
    }

    private async callApifyActor(actorId: string, input: any, onLog: LogCallback): Promise<any[]> {
        if (!this.apiKey) {
            throw new Error("Falta API Key de Apify configuration");
        }

        onLog(`[APIFY] 🚀 Ejecutando actor ${actorId}...`);

        let startRes: Response;
        try {
            onLog(`[APIFY] 📡 Enviando petición a Apify...`);
            startRes = await this.fetchWithTimeout(
                `https://api.apify.com/v2/acts/${actorId}/runs?token=${this.apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(input)
                },
                30000
            );
        } catch (err: any) {
            if (err.message === 'CANCELLED') {
                onLog(`[APIFY] ⏹️ Búsqueda cancelada por el usuario`);
                return [];
            }
            onLog(`[APIFY] ⚠️ Error conectando con Apify: ${err.message}`);
            throw err;
        }

        if (!startRes.ok) {
            const errText = await startRes.text();
            onLog(`[APIFY] ❌ Error de Apify (HTTP ${startRes.status}): ${errText.substring(0, 200)}`);
            throw new Error(`Apify Error ${startRes.status}: ${errText.substring(0, 100)}`);
        }

        const runData = await startRes.json();
        const runId = runData.data?.id;
        const datasetId = runData.data?.defaultDatasetId;

        if (!runId || !datasetId) {
            onLog(`[APIFY] ❌ Respuesta inesperada: ${JSON.stringify(runData).substring(0, 200)}`);
            throw new Error('Apify no devolvió runId/datasetId');
        }

        onLog(`[APIFY] ✅ Actor iniciado (run: ${runId.substring(0, 8)}...) Esperando resultados...`);

        let finished = false;
        let checks = 0;
        let lastStatus = '';

        while (!finished && this.isRunning && checks < 30) {
            await new Promise(r => setTimeout(r, 5000));
            if (!this.isRunning) break;
            checks++;

            try {
                const statusRes = await this.fetchWithTimeout(
                    `https://api.apify.com/v2/acts/${actorId}/runs/${runId}?token=${this.apiKey}`,
                    {},
                    15000
                );
                const statusData = await statusRes.json();
                const status = statusData.data?.status;

                if (status !== lastStatus) {
                    onLog(`[APIFY] Estado: ${status} (${checks * 5}s)`);
                    lastStatus = status;
                }

                if (status === 'SUCCEEDED') finished = true;
                else if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
                    throw new Error(`Actor falló: ${status}`);
                }
            } catch (err: any) {
                if (err.message === 'CANCELLED') {
                    onLog(`[APIFY] ⏹️ Búsqueda cancelada`);
                    return [];
                }
                if (err.message.includes('TIMEOUT')) {
                    onLog(`[APIFY] ⚠️ Polling timeout en check ${checks}, reintentando...`);
                    continue;
                }
                onLog(`[APIFY] ⚠️ Error polling: ${err.message}`);
            }
        }

        if (!this.isRunning) {
            onLog(`[APIFY] ⏹️ Búsqueda cancelada por el usuario`);
            try {
                await fetch(`https://api.apify.com/v2/acts/${actorId}/runs/${runId}/abort?token=${this.apiKey}`, { method: 'POST' });
                onLog(`[APIFY] 🛑 Actor abortado en Apify`);
            } catch (e) { /* ignore */ }
            return [];
        }

        if (!finished) {
            onLog(`[APIFY] ⚠️ Timeout tras ${checks * 5}s: Intentando obtener resultados parciales...`);
        }

        try {
            onLog(`[APIFY] 📥 Descargando resultados...`);
            const itemsRes = await this.fetchWithTimeout(
                `https://api.apify.com/v2/datasets/${datasetId}/items?token=${this.apiKey}`,
                {},
                30000
            );
            const items = await itemsRes.json();
            onLog(`[APIFY] ✅ ${Array.isArray(items) ? items.length : 0} resultados descargados`);
            return items;
        } catch (err: any) {
            if (err.message === 'CANCELLED') return [];
            onLog(`[APIFY] ❌ Error descargando resultados: ${err.message}`);
            return [];
        }
    }

    private async searchLinkedIn(
        query: string,
        maxResults: number,
        options: { language: string; maxAge: number; scoreThreshold?: number },
        onLog: LogCallback,
        existingEmails: Set<string>,
        existingLinkedin: Set<string>
    ): Promise<Candidate[]> {
        const acceptedCandidates: Candidate[] = [];
        // Scale retries based on target: at least 30, up to 100 for large searches
        const MAX_RETRIES = Math.min(100, Math.max(30, Math.ceil(maxResults / 5)));
        // Allow more consecutive dup attempts before early-exit for larger targets
        const MAX_CONSEC_DUPS = maxResults > 50 ? 5 : 3;
        let attempt = 0;
        const seenProfileNames: string[] = [];
        const seenUrls = new Set<string>();
        let consecutiveDupAttempts = 0; // EARLY EXIT: cuenta intentos consecutivos 100% duplicados
        let zeroApifyAttempts = 0;      // ANTI-LOOP: abort if Apify returns 0 profiles repeatedly
        const MAX_ZERO_APIFY = 5;       // max consecutive zero-result Apify calls before aborting

        const startTime = performance.now();

        while (acceptedCandidates.length < maxResults && attempt < MAX_RETRIES && this.isRunning) {
            attempt++;
            const currentQuery = this.getQueryVariation(query, attempt, seenProfileNames);
            const remaining = maxResults - acceptedCandidates.length;
            onLog(`[LINKEDIN] 🎯 Intento ${attempt}/${MAX_RETRIES}: Necesito ${remaining} más...`);
            onLog(`[LINKEDIN] 🔎 Query: ${currentQuery.substring(0, 120)}${currentQuery.length > 120 ? '...' : ''}`);

            try {
                const siteOperator = 'site:linkedin.com/in';
                const langKeywords = options.language === 'Spanish'
                    ? '(España OR México OR Colombia OR Argentina OR Chile OR Perú OR "habla española" OR Español)'
                    : '';

                // PAYLOAD SCALING: minimum 50 per call — one large fetch beats 5 small ones.
                // For larger targets scale up naturally, capped at 100 to keep response time predictable.
                const resultsPerPage = Math.max(50, Math.min(100, maxResults * 3));
                
                const searchInput = {
                    queries: `${siteOperator} ${currentQuery} ${langKeywords}`,
                    maxPagesPerQuery: 1,
                    resultsPerPage: resultsPerPage,
                    languageCode: options.language === 'Spanish' ? 'es' : 'en',
                    countryCode: options.language === 'Spanish' ? 'es' : 'us',
                };

                onLog(`[LINKEDIN] 📊 1 página × ${resultsPerPage} resultados (modo rápido ~8s)...`);
                const results = await this.callApifyActor(GOOGLE_SEARCH_SCRAPER, searchInput, onLog);

                let allResults: any[] = [];
                results.forEach(r => {
                    if (r.organicResults) allResults = allResults.concat(r.organicResults);
                });

                const profiles = allResults.filter((r: any) => r.url && r.url.includes('linkedin.com/in/'));

                profiles.forEach((p: any) => {
                    const name = (p.title || '').split('-')[0].replace(/[^a-zA-ZÀ-ÿ\s]/g, '').trim();
                    if (name && name.length > 2 && !seenProfileNames.includes(name)) {
                        seenProfileNames.push(name);
                    }
                });

                if (profiles.length === 0) {
                    zeroApifyAttempts++;
                    if (zeroApifyAttempts >= MAX_ZERO_APIFY) {
                        onLog(`[ABORT] 🛑 Apify devolvió 0 perfiles LinkedIn en ${MAX_ZERO_APIFY} intentos consecutivos.`);
                        onLog(`[ABORT] 💡 La query no produce resultados en Google. Prueba un rol o tecnología diferente en la campaña.`);
                        break;
                    }
                    onLog(`[LINKEDIN] ⚠️ 0 perfiles LinkedIn (${zeroApifyAttempts}/${MAX_ZERO_APIFY}). Relajando query...`);
                    continue;
                }
                // Apify returned results — reset the zero-result streak
                zeroApifyAttempts = 0;

                const newProfiles = profiles.filter((p: any) => {
                    const url = normalizeLinkedInUrl(p.url);
                    const normalizedForCheck = url.toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/$/, '').trim();

                    if (existingLinkedin.has(normalizedForCheck)) return false;
                    if (seenUrls.has(normalizedForCheck)) return false;

                    seenUrls.add(normalizedForCheck);
                    return true;
                });

                onLog(`[LINKEDIN] 📋 ${profiles.length} perfiles → ${newProfiles.length} nuevos (${profiles.length - newProfiles.length} duplicados descartados sin API)`);

                if (newProfiles.length === 0) {
                    consecutiveDupAttempts++;
                    if (consecutiveDupAttempts >= MAX_CONSEC_DUPS) {
                        onLog(`[EARLY-EXIT] 🛑 ${MAX_CONSEC_DUPS} intentos consecutivos con 100% duplicados. El nicho actual está agotado.`);
                        break;
                    }
                    onLog(`[LINKEDIN] ⚠️ Todos duplicados (${consecutiveDupAttempts}/${MAX_CONSEC_DUPS} consecutivos). Reintentando...`);
                    continue;
                }

                // Reset del contador al encontrar perfiles nuevos
                consecutiveDupAttempts = 0;

                const BATCH_SIZE = 8;
                let processedCount = 0;

                for (let i = 0; i < newProfiles.length && acceptedCandidates.length < maxResults; i += BATCH_SIZE) {
                    if (!this.isRunning) break;

                    const batch = newProfiles.slice(i, i + BATCH_SIZE);
                    onLog(`[BATCH] 🔄 Analizando ${batch.length} perfiles con IA...`);

                    const batchPromises = batch.map(async (p) => {
                        if (!this.isRunning) return null;

                        const name = p.title.split('-')[0].trim() || 'Candidato';
                        const role = p.title.split('-')[1]?.trim() || currentQuery;

                        // ═══ SPANISH LANGUAGE FILTER (pre-analysis) ═══
                        if (options.language === 'Spanish') {
                            // Extract potential location from Google snippet (often contains LinkedIn location)
                            const snippet = p.description || '';
                            const extractedLocation = snippet.match(/(?:^|·|–|-)\s*([^·–-]+(?:Spain|España|Madrid|Barcelona|México|Colombia|Argentina|Chile|Perú|Valencia|Sevilla|Bogotá|Lima|Santiago|Buenos Aires)[^·–-]*)/i)?.[1]?.trim() || null;
                            const langCheck = isLikelySpanishSpeaker(name, role, snippet, extractedLocation);
                            if (!langCheck.isSpanish) {
                                processedCount++;
                                onLog(`[LANG-FILTER] ❌ ${name} no parece hispanohablante (señales: ${langCheck.signals.length === 0 ? 'ninguna' : langCheck.signals.join(', ')})`);
                                return null;
                            }
                        }

                        const analysis = await this.generateAIAnalysis({
                            name,
                            company: 'Linkedin Search',
                            role,
                            snippet: p.description,
                            query: currentQuery,
                            maxAge: options.maxAge,
                            requireSpanish: options.language === 'Spanish',
                            roleKeyword: this._roleKeyword,
                            icpDescription: this._icpDescription,
                        });

                        processedCount++;

                        if (analysis.symmetry_score < (options.scoreThreshold || 70)) {
                            onLog(`[FILTER] 📉 ${name} (Score: ${analysis.symmetry_score}) < threshold ${options.scoreThreshold || 70} [${processedCount}/${newProfiles.length}]`);
                            return null;
                        }

                        const candidate: Candidate = {
                            id: crypto.randomUUID(),
                            full_name: name,
                            email: null,
                            linkedin_url: normalizeLinkedInUrl(p.url),
                            github_url: null,
                            avatar_url: p.pagemap?.cse_image?.[0]?.src || null,
                            job_title: role,
                            current_company: 'Ver Perfil',
                            location: options.language === 'Spanish' ? 'España/Latam' : 'Global',
                            experience_years: 0,
                            education: null,
                            skills: analysis.skills || [],
                            ai_analysis: JSON.stringify(analysis),
                            symmetry_score: analysis.symmetry_score,
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString()
                        };

                        if (acceptedCandidates.some(ac => ac.linkedin_url === candidate.linkedin_url)) {
                            return null;
                        }

                        onLog(`[MATCH] ✅ ${name} (Score: ${analysis.symmetry_score}) [${acceptedCandidates.length + 1}/${maxResults}]`);
                        return candidate;
                    });

                    const batchResults = (await Promise.all(batchPromises)).filter(c => c !== null) as Candidate[];

                    batchResults.forEach(c => {
                        if (c.email) existingEmails.add(c.email.toLowerCase().trim());
                        if (c.linkedin_url) {
                            const normalizedUrl = c.linkedin_url.toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/$/, '').trim();
                            existingLinkedin.add(normalizedUrl);
                        }
                    });

                    acceptedCandidates.push(...batchResults);

                    if (acceptedCandidates.length >= maxResults) {
                        const elapsed = Math.round((performance.now() - startTime) / 1000);
                        onLog(`[PROGRESS] 📊 ${acceptedCandidates.length}/${maxResults} - Meta alcanzada en ${elapsed}s`);
                        break;
                    }

                    onLog(`[PROGRESS] 📊 ${acceptedCandidates.length}/${maxResults} candidatos`);
                }

                if (acceptedCandidates.length >= maxResults) {
                    onLog(`[SUCCESS] 🎉 Meta alcanzada en intento ${attempt}`);
                    break;
                }

            } catch (error: any) {
                onLog(`[LINKEDIN] ⚠️ Error en intento ${attempt}: ${error.message}`);
            }
        }

        const totalTime = Math.round((performance.now() - startTime) / 1000);

        if (acceptedCandidates.length === 0) {
            onLog(`[WARNING] ⚠️ 0 candidatos tras ${attempt} intentos (${totalTime}s)`);
        } else if (acceptedCandidates.length < maxResults) {
            onLog(`[INFO] ℹ️ ${acceptedCandidates.length}/${maxResults} encontrados en ${totalTime}s`);
        }

        const finalCandidates = acceptedCandidates.slice(0, maxResults);
        onLog(`[LINKEDIN] ✅ ${finalCandidates.length} candidatos en ${totalTime}s`);

        return finalCandidates;
    }

    private async generateAIAnalysis(context: any): Promise<any> {
        if (!this.openaiKey) return {
            summary: "Análisis no disponible (Sin API Key)",
            psychological_profile: "N/A",
            business_moment: "Desconocido",
            sales_angle: "Genérico",
            bottleneck: "No detectado",
            outreach_message: `¡Hola ${context.name}! Nos encantaría conectar contigo. https://symmetry.club/roles/product-engineer`,
            icebreaker: `Hola ${context.name}, me encantaría conectar. Tenemos roles top para ti.`,
            followup_message: `Vimos tu perfil y creemos que eres exactamente lo que buscamos. ¿Podríamos charlar?`,
            skills: [],
            symmetry_score: 82
        };

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: this.isPMRole(context.roleKeyword || '')
                                ? `Eres un Talent Recruiter de ÉLITE para Symmetry (app de fitness/bienestar con +400k descargas/mes). Tu misión: encontrar Product Managers con experiencia en apps de consumo (B2C), especialmente mobile.

                            === PERFIL OBJETIVO — PRODUCT MANAGER MOBILE CONSUMER ===
                            Experiencia: 3-8 años en producto. Foco PRIORITARIO: apps móviles consumer (iOS/Android). Edad máxima: 30 años.
                            Entienden adquisición, activación, retención y engagement en productos con usuarios reales.

                            ═══ SISTEMA DE TIERS DE INDUSTRIA (ORDEN DE PRIORIDAD ESTRICTO) ═══
                            PASO 1: Clasifica al candidato en uno de estos 4 tiers. PASO 2: Aplica el score BASE del tier. PASO 3: Suma green flags sólo si el tier lo permite.

                            🥇 TIER 1 — MOBILE CONSUMER (BASE: 92) ← EL PERFIL IDEAL
                            Señales: apps iOS/Android publicadas, fitness app, gaming mobile, social app, healthtech mobile, consumer mobile, React Native o Flutter con usuarios reales, app en App Store / Play Store con descargas/reseñas.
                            DESDE 92, SUMA si:
                            - Métricas reales: MAU, DAU, descargas, retención, churn (+5 a +8)
                            - App publicada con volumen real (+50k usuarios o descargas) (+5)
                            - Growth, activación, retención, engagement como core del rol (+5)
                            - Startup o scale-up mobile con tracción real (+3)
                            - UX-driven, diseño de producto, experiencia del usuario final (+3)

                            🥈 TIER 2 — B2C SOFTWARE GENERAL (BASE: 85)
                            Señales: consumer web, marketplace B2C, plataforma digital consumer, B2C SaaS, fintech consumer, edtech consumer, healthtech web.
                            DESDE 85, SUMA sólo si tiene señales adicionales de mobile consumer o métricas reales de usuarios.

                            🥉 TIER 3 — B2B SOFTWARE (BASE: 58, máximo alcanzable: 65)
                            Señales: SaaS B2B, herramientas para empresas, dev tools, software de gestión B2B, internal tools, plataformas para negocios (no para usuarios finales consumidores).
                            Aunque tenga otras señales positivas, NO puede superar 65.

                            ❌ TIER 4 — ENTERPRISE (AUTO-FAIL: score < 30 SIN EXCEPCIÓN)
                            Señales: SAP, Salesforce, Oracle, software para grandes corporaciones, CRM enterprise, gobierno, banca corporativa, ERP, IT enterprise.
                            RECHAZO INMEDIATO — score < 30 aunque tenga cualquier otra característica positiva.

                            NO USES 75 como valor por defecto. Determina el tier primero, luego aplica el score BASE del tier correspondiente.

                            ✅ GREEN FLAGS (aplican SÓLO en Tier 1 y Tier 2, suman desde el BASE):
                            - App móvil consumer publicada con métricas reales (MAU, downloads, retención) (+8)
                            - Productos con usuarios finales reales y volumen medible (+5)
                            - Growth, activación, retención, engagement como background (+5)
                            - Startup o scale-up con tracción real de usuarios (+5)
                            - UX-driven, data-driven, enfoque en el usuario final (+3)

                            🚫 RED FLAGS — FUERZAN TIER INFERIOR:
                            - PM de SaaS B2B sin experiencia en producto consumer → forzar Tier 3 (58-65)
                            - Perfil corporativo/consultoría sin producto real → Tier 3 o Tier 4
                            - Technical PM / Engineering Manager sin foco en usuario → Tier 3 (55-62)
                            - Solo enterprise software → Tier 4, AUTO-FAIL (<30)

                            Analiza el perfil y devuelve ÚNICAMENTE JSON con este formato:
                            {
                                "psychological_profile": "Perfil psicológico en 1 frase",
                                "business_moment": "Momento actual en 1 frase",
                                "sales_angle": "Mejor acercamiento en 1 frase",
                                "bottleneck": "Principal dolor o cuello de botella",
                                "summary": "Resumen ejecutivo en 1 frase",
                                "outreach_message": "Mensaje personalizado (<280 chars) directo y creativo para primer contacto",
                                "followup_message": "Mensaje de seguimiento tras aceptar conexión (max 300 chars)",
                                "second_followup": "Mensaje de seguimiento (300-500 chars) si no hay respuesta inicial. Proporciona más valor e información",
                                "skills": ["Habilidad 1", "Habilidad 2"],
                                "symmetry_score": 85
                            }

                            IMPORTANTE:
                            - symmetry_score BASE depende del tier: Tier 1 = 92, Tier 2 = 85, Tier 3 = 58-65, Tier 4 = <30. NO uses 75 como default.
                            - Los mensajes deben ser personalizados para PMs de producto consumer/mobile.
                            - Menciona Symmetry como app de fitness/bienestar con tracción real.
                            - FILTRO EDAD OBLIGATORIO: Si el perfil sugiere que la persona tiene MÁS DE ${context.maxAge || 30} AÑOS (señales de inferencia: más de 8 años de experiencia profesional total, graduación universitaria antes de 2016, primera experiencia laboral antes de 2016-2017, menciona haber trabajado más de una década), RECHAZAR AUTOMÁTICAMENTE — score < 25 (AUTO-FAIL absoluto, sin excepción, independientemente de sus skills o tier de industria)
                            ${context.icpDescription ? `
                            === PERFIL BUSCADO (ICP) ===
                            ${context.icpDescription.slice(0, 800)}
                            Usa este perfil como referencia para evaluar la afinidad del candidato y personalizar los mensajes.
                            ` : ''}
                            ${context.requireSpanish ? `- FILTRO IDIOMA OBLIGATORIO: Si el nombre, ubicación o texto del perfil NO muestran señales claras de hablar español (nombre hispano, ubicación en España/Latinoamérica, texto en español), PENALIZAR SCORE severamente (poner <30)
                            - TODOS los mensajes DEBEN estar escritos en español` : ''}`
                                : `Eres un Tech Recruiter de ÉLITE para Symmetry (•400k descargas/mes). Tu misión: encontrar Product Engineers con impacto real en producción.

                            === PERFIL OBJETIVO ===
                            Experiencia: 3-8 años en producción. Stack core: React/Next.js, Node.js, TypeScript, APIs REST.
                            Full-stack end-to-end. Entienden producto, usuario Y negocio.

                            ═══ SISTEMA DE ANCLAJE DE PUNTUACIÓN (ANCHOR SYSTEM) ═══
                            REGLA BASE: Si el candidato menciona tecnologías clave del stack (React, Next.js, Node.js, TypeScript, Flutter, React Native) Y su perfil indica que habla español o está en España/Latinoamérica → su puntuación BASE es 85.
                            DESDE ESE 85, SUMA puntos (hasta 100) si:
                            - Menciona impacto real con métricas (usuarios, descargas, revenue)
                            - Proyectos en producción con usuarios reales
                            - Experiencia en startups o como founder/co-founder
                            - Ownership end-to-end de features o productos
                            - Usa IA en su flujo de trabajo (ChatGPT, Cursor, Copilot)
                            SOLO RESTA puntos (por debajo de 80) si el perfil es EXPLÍCITAMENTE:
                            - Junior sin experiencia en producción real
                            - Solo formación teórica/bootcamp sin apps en producción
                            - Consultor puramente técnico sin visión de producto o negocio
                            - Perfil sin señales de impacto o ownership
                            NO USES 75 como valor por defecto. Un perfil ambiguo que menciona el stack correcto vale 85.

                            ✅ GREEN FLAGS (suman desde el 85):
                            - Ownership de features/productos + métricas o impacto de negocio (+5 a +10)
                            - Construyó aplicaciones COMPLETAS (frontend + backend + deploy) (+5)
                            - Experiencia en startups, entornos ágiles o freelance (+5)
                            - Usa herramientas IA en su flujo de trabajo (+3)
                            - Mobile (React Native o Flutter) o infra cloud como bonus (+3)

                            🚫 RED FLAGS — BAJA SCORE (por debajo de 80):
                            - Solo formación teórica o bootcamp SIN proyectos en producción → 50-60
                            - Perfil puramente teórico sin evidencia de impacto → 55-65
                            - Sin apps funcionales usadas por usuarios reales → 60
                            - AUTO-FAIL (<40): No tiene stack relevante Y es puramente teórico

                            Analiza el perfil y devuelve ÚNICAMENTE JSON con este formato:
                            {
                                "psychological_profile": "Perfil psicológico en 1 frase",
                                "business_moment": "Momento actual en 1 frase",
                                "sales_angle": "Mejor acercamiento en 1 frase",
                                "bottleneck": "Principal dolor o cuello de botella",
                                "summary": "Resumen ejecutivo en 1 frase",
                                "outreach_message": "Mensaje personalizado (<280 chars) directo y creativo para primer contacto",
                                "followup_message": "Mensaje de seguimiento tras aceptar conexión (max 300 chars)",
                                "second_followup": "Mensaje de seguimiento (300-500 chars) si no hay respuesta inicial. Proporciona más valor e información",
                                "skills": ["Habilidad 1", "Habilidad 2"],
                                "symmetry_score": 85
                            }

                            IMPORTANTE:
                            - symmetry_score por defecto es 85, NO 75. Ajusta hacia arriba o abajo según las reglas anteriores.
                            - FOLLOWUP debe ser EXACTAMENTE el texto indicado sin añadir ni quitar nada, solo sustituir [Nombre] por el nombre real del candidato.
                            - SEGUNDO FOLLOWUP es para seguimiento después de X días sin respuesta, ofrece valor adicional
                            - Los 3 mensajes deben ser super personalizados basados en el perfil
                            - If snippet implies user is > ${context.maxAge || 40} years old, PENALIZE SCORE (<50)
                            ${context.icpDescription ? `
                            === PERFIL BUSCADO (ICP) ===
                            ${context.icpDescription.slice(0, 800)}
                            Usa este perfil como referencia para evaluar la afinidad del candidato y personalizar los mensajes.
                            ` : ''}
                            ${context.requireSpanish ? `- FILTRO IDIOMA OBLIGATORIO: Si el nombre, ubicación o texto del perfil NO muestran señales claras de hablar español (nombre hispano, ubicación en España/Latinoamérica, texto en español), PENALIZAR SCORE severamente (poner <30)
                            - TODOS los mensajes DEBEN estar escritos en español` : ''}`
                        },
                        { role: 'user', content: JSON.stringify(context) }
                    ],
                    temperature: 0.7,
                    max_tokens: 350
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`OpenAI Error: ${response.status}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content;

            const cleanContent = content?.replace(/```json/g, '').replace(/```/g, '').trim();

            const parsed = JSON.parse(cleanContent || '{}');

            if (this.isPMRole(context.roleKeyword || '')) {
                parsed.icebreaker = `Hola ${context.name.split(' ')[0]} — soy Mauro, cofundador de Symmetry (app de fitness con +400k descargas/mes). Vi tu experiencia en producto consumer y creo que hay fit. Me gustaría conectar.`;
                parsed.followup_message = `Gracias por aceptar ${context.name.split(' ')[0]}. Estamos escalando Symmetry — app de bienestar B2C con fuerte tracción mobile. Buscamos un PM con experiencia en consumer apps. ¿Te interesa que te cuente más?`;
                parsed.second_followup = parsed.second_followup || `${context.name}, creo que tu experiencia en producto consumer encaja muy bien con lo que estamos construyendo en Symmetry. ¿Tienes 15 min para una llamada rápida?`;
            } else {
                parsed.icebreaker = `Hola ${context.name.split(' ')[0]} — soy Mauro, fundador de Symmetry (una app de fitness con fuerte crecimiento) y vi tu experiencia como ${context.roleKeyword || 'product engineer'}. Me gustaría conectar.`;
                parsed.followup_message = `Gracias por aceptar ${context.name.split(' ')[0]}. Estamos escalando Symmetry, una app de salud y bienestar con mucha tracción (+400k descargas/mes) y equipo de producto pequeño. Buscamos product engineers. ¿Te interesa que te pase el brief técnico?`;
                parsed.second_followup = parsed.second_followup || `${context.name}, viendo tu trayectoria creemos que hay una gran alineación.`;
            }

            return parsed;
        } catch (e: any) {
            const isPM = this.isPMRole(context.roleKeyword || '');
            return {
                summary: "Análisis rápido disponible",
                psychological_profile: "Profesional activo",
                business_moment: "En demanda",
                sales_angle: isPM ? "PM con foco en consumer/mobile" : "Roles de alto impacto",
                bottleneck: "Oportunidades personalizadas",
                outreach_message: isPM
                    ? `¡Hola ${context.name}! Escalamos Symmetry (+400k descargas) y buscamos un PM con experiencia en consumer apps. ¿Conectamos?`
                    : `¡Hola ${context.name}! Tenemos roles de alto nivel. https://symmetry.club/roles/product-engineer`,
                icebreaker: isPM
                    ? `Hola ${context.name.split(' ')[0]} — soy Mauro, cofundador de Symmetry (app de fitness con +400k descargas/mes). Vi tu experiencia en producto consumer y creo que hay fit. Me gustaría conectar.`
                    : `Hola ${context.name.split(' ')[0]} — soy Mauro, fundador de Symmetry (una app de fitness con fuerte crecimiento) y vi tu experiencia como ${context.roleKeyword || 'product engineer'}. Me gustaría conectar.`,
                followup_message: isPM
                    ? `Gracias por aceptar ${context.name.split(' ')[0]}. Estamos escalando Symmetry — app de bienestar B2C con fuerte tracción mobile. Buscamos un PM con experiencia en consumer apps. ¿Te interesa que te cuente más?`
                    : `Gracias por aceptar ${context.name.split(' ')[0]}. Estamos escalando Symmetry, una app de salud y bienestar con mucha tracción (+400k descargas/mes) y equipo de producto pequeño. Buscamos product engineers. ¿Te interesa que te pase el brief técnico?`,
                second_followup: isPM
                    ? `${context.name}, creo que tu experiencia en producto consumer encaja muy bien con lo que estamos construyendo en Symmetry. ¿Tienes 15 min para una llamada rápida?`
                    : `${context.name}, viendo tu trayectoria creemos que hay una gran alineación. Te compartimos una oportunidad que podría ser perfect fit para ti.`,
                skills: context.skills || [],
                symmetry_score: isPM ? 85 : 82
            };
        }
    }
}

export const linkedInSearchEngine = new LinkedInSearchEngine();
