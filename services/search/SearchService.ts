import { Lead, SearchConfigState } from '../../lib/types';
import { deduplicationService } from '../deduplication/DeduplicationService';

export type LogCallback = (message: string) => void;
export type ResultCallback = (leads: Lead[]) => void;

// Apify Actor IDs
// Apify Actor IDs
const GOOGLE_MAPS_SCRAPER = 'nwua9Gu5YrADL7ZDj';
const CONTACT_SCRAPER = 'vdrmO1lXCkhbPjE9j';
const GOOGLE_SEARCH_SCRAPER = 'nFJndFXA5zjCTuudP'; // ID for apify/google-search-scraper

export class SearchService {
    private isRunning = false;
    private apiKey: string = '';
    private userId: string | null = null; // For deduplication

    public stop() {
        this.isRunning = false;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SMART QUERY INTERPRETER
    // ═══════════════════════════════════════════════════════════════════════════
    private async interpretQuery(userQuery: string, platform: 'gmail' | 'linkedin' | 'instagram'): Promise<{
        searchQuery: string;
        industry: string;
        targetRoles: string[];
        location: string;
    }> {
        try {
            console.log('[INTERPRET] 📡 Llamando /api/openai...');
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 300000); // 300 sec timeout (uncapped)

            // Llamar a nuestra API route privada en lugar de OpenAI directamente
            const response = await fetch('/api/openai', {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: `Eres un experto en prospección B2B. Interpreta la búsqueda para encontrar DUEÑOS y DECISORES.
Responde SOLO con JSON:
{
  "searchQuery": "término optimizado",
  "industry": "sector detectado",
  "targetRoles": ["CEO", "Fundador", etc],
  "location": "ubicación o España"
}`
                        },
                        { role: 'user', content: `Búsqueda: "${userQuery}"` }
                    ],
                    temperature: 0.3,
                    max_tokens: 150
                })
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                const err = await response.text();
                console.error(`[INTERPRET] HTTP ${response.status}:`, err.substring(0, 300));
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            const match = data.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/);
            if (match) {
                console.log('[INTERPRET] ✅ Query interpretada exitosamente');
                return JSON.parse(match[0]);
            }
        } catch (e: any) {
            console.error('[INTERPRET] Error:', e.message);
        }

        console.log('[INTERPRET] ⚠️ Fallback: usando query as-is');
        return { searchQuery: userQuery, industry: userQuery, targetRoles: ['CEO', 'Fundador', 'Propietario'], location: 'España' };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ADVANCED FILTERS PROCESSOR
    // ═══════════════════════════════════════════════════════════════════════════
    private buildQueryWithAdvancedFilters(baseQuery: string, filters?: any): string {
        if (!filters || !Object.keys(filters).length) {
            return baseQuery;
        }

        const parts = [baseQuery];

        // Add locations to query
        if (filters.locations && filters.locations.length > 0) {
            parts.push(`(${filters.locations.map((loc: string) => `"${loc}"`).join(' OR ')})`);
        }

        // Add job titles to query
        if (filters.jobTitles && filters.jobTitles.length > 0) {
            parts.push(`(${filters.jobTitles.map((job: string) => `"${job}"`).join(' OR ')})`);
        }

        // Add industries to query
        if (filters.industries && filters.industries.length > 0) {
            parts.push(`(${filters.industries.map((ind: string) => `"${ind}"`).join(' OR ')})`);
        }

        // Add keywords to query
        if (filters.keywords && filters.keywords.length > 0) {
            parts.push(`(${filters.keywords.map((key: string) => `"${key}"`).join(' OR ')})`);
        }

        return parts.join(' AND ');
    }

    /**
     * Check if a lead matches advanced filter criteria
     */
    private leadMatchesFilters(lead: Lead, filters?: any): boolean {
        if (!filters) return true;

        try {
            // Check locations
            if (filters.locations && filters.locations.length > 0) {
                const leadLocation = (lead.location || '').toLowerCase();
                const matchesLocation = filters.locations.some((loc: string) =>
                    leadLocation.includes(loc.toLowerCase())
                );
                if (!matchesLocation) return false;
            }

            // Check company sizes (if available in lead data)
            if (filters.companySizes && filters.companySizes.length > 0) {
                // Company size usually comes from summary/analysis
                const summary = (lead.aiAnalysis?.summary || '').toLowerCase();
                const matchesSize = filters.companySizes.some((size: string) => {
                    if (size === 'startup') return summary.includes('1-50') || summary.includes('pequeña');
                    if (size === 'small') return summary.includes('1-100') || summary.includes('pequeña');
                    if (size === 'medium') return summary.includes('100-1000') || summary.includes('mediana');
                    if (size === 'large') return summary.includes('1000+') || summary.includes('grande');
                    return summary.includes(size);
                });
                if (!matchesSize && filters.companySizes.length > 0) return false;
            }

            return true;
        } catch (e) {
            return true; // If filtering fails, keep the lead
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEEP RESEARCH - Google Search for company/owner info
    // ═══════════════════════════════════════════════════════════════════════════
    private async deepResearchLead(lead: Lead, onLog: LogCallback): Promise<string> {
        if (!this.isRunning) return '';

        const searchQueries = [];

        // Research company
        if (lead.companyName && lead.companyName !== 'Sin Nombre') {
            searchQueries.push(`"${lead.companyName}" empresa valores misión`);
        }

        // Research owner if we have a name
        if (lead.decisionMaker?.name) {
            searchQueries.push(`"${lead.decisionMaker.name}" ${lead.companyName} entrevista`);
            searchQueries.push(`"${lead.decisionMaker.name}" linkedin`);
        }

        // Research from website
        if (lead.website) {
            searchQueries.push(`site:${lead.website} "sobre nosotros" OR "quiénes somos" OR "about"`);
        }

        if (searchQueries.length === 0) return '';

        try {
            const searchInput = {
                queries: searchQueries.join('\n'),
                maxPagesPerQuery: 1,
                resultsPerPage: 5,
                languageCode: 'es',
                countryCode: 'es',
            };

            const results = await this.callApifyActor(GOOGLE_SEARCH_SCRAPER, searchInput, (msg) => { }); // Silent

            let researchData = '';
            for (const result of results) {
                if (result.organicResults) {
                    for (const organic of result.organicResults.slice(0, 3)) {
                        researchData += `\n- ${organic.title}: ${organic.description || ''}`;
                    }
                }
            }

            return researchData;
        } catch (e) {
            return '';
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ULTRA-COMPLETE AI ANALYSIS - Psychological + Business + Bottleneck
    // ═══════════════════════════════════════════════════════════════════════════
    private async generateUltraAnalysis(lead: Lead, researchData: string): Promise<{
        fullAnalysis: string;
        psychologicalProfile: string;
        businessMoment: string;
        salesAngle: string;
        personalizedMessage: string;
        bottleneck: string;
    }> {
        // Siempre intentar llamar /api/openai (no depender de this.openaiKey)
        const context = `
═══ DATOS DEL LEAD ═══
Empresa: ${lead.companyName}
Web: ${lead.website || 'No disponible'}
Ubicación: ${lead.location || 'España'}
Decisor: ${lead.decisionMaker?.name || 'No identificado'}
Cargo: ${lead.decisionMaker?.role || 'Propietario'}
Email: ${lead.decisionMaker?.email || 'No disponible'}
LinkedIn: ${lead.decisionMaker?.linkedin || 'No disponible'}
Resumen inicial: ${lead.aiAnalysis?.summary || ''}

═══ INVESTIGACIÓN ADICIONAL ═══
${researchData || 'Sin datos adicionales'}
        `.trim();

        const MAX_RETRIES = 2;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await fetch('/api/openai', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        messages: [
                            {
                                role: 'system',
                                content: `Eres un experto en de prospección B2B. Tu trabajo es analizar leads para enviarles cold outreach.
PÚBLICO OBJETIVO: Emprendedores digitales, Infoproductores, Coaches High Ticket, Consultores online (SEO, Nutrición, etc.) y Dueños de Comunidades. Tienen negocios 100% online rentables, pero están saturados por el trabajo manual de prospección, DMs y gestión de leads.
OBJETIVO: Vender el siguiente paso (agendar llamada rápida o enviar un vídeo Loom/Miro de demostración). NUNCA vender el servicio en el primer impacto.
TONO (REGLA DE ORO): Directo, pragmático, de igual a igual. Cero humo. Nada de cumplidos vacíos. Lenguaje de negocios digitales.

FRONTERA DE CONTEXTO: Analiza el perfil del creador/consultor y el tipo de servicio o comunidad que ofrece. Redacta una línea de apertura que conecte su nicho específico (ej. consultoría SEO, coaching de nutrición, comunidad de inversores) con el cuello de botella de escalar operaciones online sin quemarse respondiendo mensajes manuales. No repitas su titular. Demuestra que entiendes cómo funciona su modelo de negocio digital.
Variables a ingerir para la personalización: Años en el puesto/empresa, sector específico, hitos recientes.

DEBES generar exactamente este JSON (sin markdown, solo JSON puro):
{
  "psychologicalProfile": "Describe su perfil en 2 frases (Ej: 'Visionario y directo. Valora la innovación...')",
  "businessMoment": "Deduce en qué fase está la empresa (Ej: 'Expansión agresiva', 'Consolidación', 'Buscando eficiencia')",
  "salesAngle": "El argumento ÚNICO para venderle a ESTA persona hoy.",
  "bottleneck": "Una frase BRUTAL y específica sobre su mayor freno o cuello de botella detectado.",
  "personalizedMessage": "El mensaje final aplicando todas las reglas anteriores."
}

IMPORTANTE: Responde SOLO con JSON válido.`
                            },
                            {
                                role: 'user',
                                content: `Analiza este lead (Intento ${attempt}):\n\n${context}`
                            }
                        ],
                        temperature: 0.7,
                        max_tokens: 1000
                    })
                });

                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || '';
                const jsonMatch = content.match(/\{[\s\S]*\}/);

                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    return {
                        fullAnalysis: `🧠 PERFIL: ${parsed.psychologicalProfile}\n🏢 MOMENTO: ${parsed.businessMoment}\n💡 ÁNGULO: ${parsed.salesAngle}`,
                        psychologicalProfile: parsed.psychologicalProfile || 'No detectado',
                        businessMoment: parsed.businessMoment || 'No detectado',
                        salesAngle: parsed.salesAngle || 'Genérico',
                        personalizedMessage: parsed.personalizedMessage || `Hola ${lead.decisionMaker?.name || 'equipo'}, me gustaría contactar con vosotros.`,
                        bottleneck: parsed.bottleneck || 'Oportunidad de mejora detectada'
                    };
                }
            } catch (e) {
                console.error(`Attempt ${attempt} failed:`, e);
                if (attempt === MAX_RETRIES) break;
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }

        // Fallback genérico decente (sin "Sin API Key")
        return {
            fullAnalysis: `${lead.companyName}: Negocio online/Consultoría activa en ${lead.location || 'Internet'}. Decisor saturado por gestión manual de leads.`,
            psychologicalProfile: `${lead.decisionMaker?.role || 'Emprendedor'} digital. Valora su tiempo y busca escalar operaciones sin quemarse.`,
            businessMoment: 'Buscando escalar sin caos manual',
            salesAngle: 'Automatización de prospección y gestión de DMs',
            personalizedMessage: `Hola ${lead.decisionMaker?.name || 'equipo'}, veo que estar respondiendo DMs manualmente frena tu capacidad de escalar. Te propongo un vídeo de Loom de 2 min mostrando cómo solucionarlo.`,
            bottleneck: 'Saturación por prospección y contestación manual de mensajes'
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GENERATE TWO MESSAGES FOR MARCOS (Message A & B)
    // ═══════════════════════════════════════════════════════════════════════════
    private async generateOneMessage(lead: Lead): Promise<{
        messageA: string;
    }> {
        console.log('[MESSAGE] Generando 1 mensaje (solo producto)...');

        try {
            console.log('[MESSAGE] 📡 Llamando /api/openai...');

            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort();
                console.error('[MESSAGE] TIMEOUT (300s)');
            }, 300000); // 300 sec timeout (uncapped)

            const response = await fetch('/api/openai', {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: `Escribe un extracto de mensaje corto B2B outreach alineado con:
PÚBLICO: Emprendedores digitales, Infoproductores, Coaches High Ticket, Consultores online y Dueños de Comunidades.
DOLOR: Saturados por el trabajo manual de prospección, DMs y gestión de leads.
EL OBJETIVO NO ES VENDER, es empujar a ver un Loom/Miro o agendar llamada rápida.
TONO: Directo, pragmático, de igual a igual. Cero humo. Nada de cumplidos vacíos. Lenguaje de negocios digitales.

CONTEXTO (FRONTERA): Analiza el perfil del creador/consultor y el tipo de servicio o comunidad que ofrece. Redacta una línea de apertura que conecte su nicho específico (ej. consultoría SEO, coaching de nutrición, comunidad de inversores) con el cuello de botella de escalar operaciones online sin quemarse respondiendo mensajes manuales. No repitas su titular. Demuestra que entiendes cómo funciona su modelo de negocio digital.

Responde SOLO con JSON: {"messageA": "..."}`
                        },
                        {
                            role: 'user',
                            content: `Empresa: ${lead.companyName}
Responsable: ${lead.decisionMaker?.name}
Cargo: ${lead.decisionMaker?.role}

Genera el mensaje.`
                        }
                    ],
                    temperature: 0.6,
                    max_tokens: 150
                })
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                const err = await response.text();
                console.error('[MESSAGE] HTTP error:', response.status);
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || '';

            if (!content) {
                console.error('[MESSAGE] Empty response');
                throw new Error('Empty response');
            }

            const jsonMatch = content.match(/\{[\s\S]*\}/);

            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                console.log('[MESSAGE] ✅ Mensaje generado');
                return {
                    messageA: parsed.messageA || `Hola ${lead.decisionMaker?.name}, me gustaría hablar sobre automatización.`
                };
            }
        } catch (e: any) {
            console.error('[MESSAGE] Error:', e.message);
        }

        // Fallback
        console.log('[MESSAGE] ⚠️ Fallback message');
        return {
            messageA: `Hola ${lead.decisionMaker?.name || 'equipo'}, veo que gestionáis ${lead.companyName}. Tengo una solución para automatizar vuestros procesos.`
        };
    }

    private async callApifyActor(actorId: string, input: any, onLog: LogCallback): Promise<any[]> {
        // Use local proxy to avoid CORS
        const baseUrl = '/api/apify';
        const startUrl = `${baseUrl}/acts/${actorId}/runs?token=${this.apiKey}`;

        onLog(`[APIFY] 📡 Lanzando actor ${actorId.substring(0, 8)}...`);
        console.log('[APIFY] POST a:', startUrl.substring(0, 100));

        // STAGE 1: Iniciar actor con timeout
        let startResponse: Response;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort();
                console.error('[APIFY] TIMEOUT en POST /runs (300s)');
            }, 300000); // 300 sec timeout (uncapped)

            startResponse = await fetch(startUrl, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input)
            });
            clearTimeout(timeoutId);
        } catch (networkError: any) {
            console.error('[APIFY] Network error en POST /runs:', networkError.message);
            throw new Error(`Network error llamando Apify (¿proxy /api/apify funciona?): ${networkError.message}`);
        }

        if (!startResponse.ok) {
            const err = await startResponse.text();
            console.error(`[APIFY] HTTP ${startResponse.status}:`, err.substring(0, 300));
            onLog(`[APIFY] ❌ HTTP ${startResponse.status} al lanzar actor`);
            throw new Error(`Error actor ${actorId}: HTTP ${startResponse.status}`);
        }

        let startData: any;
        try {
            startData = await startResponse.json();
        } catch (e: any) {
            console.error('[APIFY] Error parsing JSON response:', e);
            throw new Error('Apify: Invalid JSON response');
        }

        const runId = startData.data?.id;
        const defaultDatasetId = startData.data?.defaultDatasetId;

        if (!runId || !defaultDatasetId) {
            console.error('[APIFY] Missing runId/defaultDatasetId:', { runId, defaultDatasetId });
            throw new Error('Apify: Response missing runId or defaultDatasetId');
        }

        onLog(`[APIFY] ✅ Actor iniciado (${runId.substring(0, 8)})`);
        console.log('[APIFY] Run started. Waiting for completion...');

        // STAGE 2: Poll status con timeout MAX 2 minutos
        let isFinished = false;
        let pollCount = 0;
        const MAX_POLLS = 600; // 600 * 5s = 3000s (uncapped)

        while (!isFinished && this.isRunning && pollCount < MAX_POLLS) {
            await new Promise(r => setTimeout(r, 5000));
            pollCount++;

            try {
                const statusUrl = `${baseUrl}/acts/${actorId}/runs/${runId}?token=${this.apiKey}`;
                const statusRes = await fetch(statusUrl);

                if (!statusRes.ok) {
                    console.error(`[APIFY] Status fetch HTTP ${statusRes.status}`);
                    onLog(`[APIFY] ⚠️ Error obtener status (HTTP ${statusRes.status})`);
                    continue;
                }

                const statusData = await statusRes.json();
                const status = statusData.data?.status;

                if (!status) {
                    console.error('[APIFY] Missing status in response:', statusData);
                    continue;
                }

                if (pollCount % 3 === 1) {
                    console.log(`[APIFY] Poll ${pollCount}/${MAX_POLLS}: ${status}`);
                    onLog(`[APIFY] Estado: ${status} (${pollCount * 5}s)`);
                }

                if (status === 'SUCCEEDED') {
                    isFinished = true;
                    console.log('[APIFY] ✅ SUCCEEDED after', pollCount * 5, 'seconds');
                } else if (status === 'FAILED' || status === 'ABORTED') {
                    console.error('[APIFY] Actor failed/aborted:', status);
                    throw new Error(`Actor ${status}`);
                }
            } catch (pollError: any) {
                console.error('[APIFY] Polling error:', pollError?.message);
                if (pollError.message?.includes('FAILED') || pollError.message?.includes('ABORTED')) {
                    throw pollError;
                }
            }
        }

        if (!isFinished) {
            console.error('[APIFY] TIMEOUT after', MAX_POLLS * 5, 'seconds');
            throw new Error(`Apify timeout: No completó en ${MAX_POLLS * 5}s`);
        }

        if (!this.isRunning) {
            console.log('[APIFY] Search stopped by user');
            return [];
        }

        // STAGE 3: Get dataset
        console.log('[APIFY] Fetching dataset:', defaultDatasetId);
        onLog(`[APIFY] 📥 Descargando dataset...`);

        try {
            const itemsUrl = `${baseUrl}/datasets/${defaultDatasetId}/items?token=${this.apiKey}`;
            const itemsRes = await fetch(itemsUrl);

            if (!itemsRes.ok) {
                console.error(`[APIFY] Dataset HTTP ${itemsRes.status}`);
                throw new Error(`Dataset HTTP ${itemsRes.status}`);
            }

            const items = await itemsRes.json();

            if (!Array.isArray(items)) {
                console.error('[APIFY] Items not array:', typeof items, 'keys:', Object.keys(items || {}).slice(0, 5));
                throw new Error('Dataset response not array');
            }

            console.log('[APIFY] ✅ Got', items.length, 'items');
            onLog(`[APIFY] ✅ Dataset: ${items.length} items`);

            return items;
        } catch (datasetError: any) {
            console.error('[APIFY] Dataset error:', datasetError);
            throw datasetError;
        }
    }

    public async startSearch(
        config: SearchConfigState,
        onLog: LogCallback,
        onComplete: ResultCallback,
        userId?: string | null
    ) {
        this.isRunning = true;
        this.userId = userId || null;

        try {
            this.apiKey = import.meta.env.VITE_APIFY_API_TOKEN || '';

            onLog(`[INIT] 🔑 API Key: ${this.apiKey ? '✅ presente (' + this.apiKey.substring(0, 10) + '...)' : '❌ FALTA'}`);
            onLog(`[INIT] 🧠 OpenAI: ✅ API route /api/openai disponible`);
            onLog(`[INIT] 👤 UserId: ${this.userId || 'no autenticado'}`);
            onLog(`[INIT] 🔎 Source: ${config.source} | Query: "${config.query}" | Max: ${config.maxResults}`);

            if (!this.apiKey) throw new Error("Falta VITE_APIFY_API_TOKEN en .env — configúrala en Vercel → Settings → Environment Variables");

            // ═══════════════════════════════════════════════════════════════════════════
            // FASE 1: Pre-Flight - Descargar leads existentes del usuario
            // ═══════════════════════════════════════════════════════════════════════════
            onLog(`[DEDUP] 🔍 Iniciando verificación anti-duplicados...`);
            const { existingWebsites, existingCompanyNames, existingEmails, existingLinkedinUrls } =
                await deduplicationService.fetchExistingLeads(this.userId);
            onLog(`[DEDUP] ✅ Pre-flight: ${existingWebsites.size} dominios, ${existingCompanyNames.size} empresas en historial`);

            onLog(`[IA] 🧠 Interpretando: "${config.query}"...`);
            const interpreted = await this.interpretQuery(config.query, config.source);
            onLog(`[IA] ✅ Industria: ${interpreted.industry} | Roles: ${interpreted.targetRoles.join(', ')} | Zona: ${interpreted.location}`);

            if (config.source === 'linkedin') {
                onLog(`[LINKEDIN] 🚀 Iniciando búsqueda LinkedIn...`);
                await this.searchLinkedIn(
                    config,
                    interpreted,
                    existingWebsites,
                    existingCompanyNames,
                    existingEmails,
                    existingLinkedinUrls,
                    onLog,
                    onComplete
                );
            } else {
                onLog(`[GMAIL] 🚀 Iniciando búsqueda Gmail/Maps...`);
                await this.searchGmail(
                    config,
                    interpreted,
                    existingWebsites,
                    existingCompanyNames,
                    existingEmails,
                    existingLinkedinUrls,
                    onLog,
                    onComplete
                );
            }

        } catch (error: any) {
            console.error('[SearchService] FATAL ERROR:', error);
            onLog(`[ERROR] ❌ ${error.message}`);
            onLog(`[ERROR] 📋 Stack: ${error.stack?.split('\n').slice(0, 3).join(' → ') || 'no stack'}`);
            onComplete([]);
        } finally {
            this.isRunning = false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════════════════
    // GMAIL SEARCH - SMART LOOP WITH PAGINATION
    // ═══════════════════════════════════════════════════════════════════════════
    private async searchGmail(
        config: SearchConfigState,
        interpreted: { searchQuery: string; industry: string; targetRoles: string[]; location: string },
        existingWebsites: Set<string>,
        existingCompanyNames: Set<string>,
        existingEmails: Set<string>,
        existingLinkedinUrls: Set<string>,
        onLog: LogCallback,
        onComplete: ResultCallback
    ) {
        console.log('[GMAIL] 🚀 searchGmail iniciado');
        onLog(`[GMAIL] 🚀 Iniciando búsqueda Gmail...`);

        // Check Hard Limit
        let targetCount = config.maxResults;
        if (!targetCount || targetCount < 1) targetCount = 1;
        // if (targetCount > 20) targetCount = 20; // Removed limit

        let query = `${interpreted.searchQuery} ${interpreted.location}`;

        // Apply advanced filters to query if available
        if (config.advancedFilters) {
            query = this.buildQueryWithAdvancedFilters(query, config.advancedFilters);
            onLog(`[FILTERS] ✅ Filtros avanzados aplicados a la búsqueda`);
        }

        onLog(`[GMAIL] 🗺️ Buscando: "${query}" (Smart Loop x4)...`);
        console.log('[GMAIL] Query:', query);

        const validLeads: Lead[] = [];
        let attempts = 0;
        const MAX_ATTEMPTS = 10;
        let totalScannedPreviously = 0;

        // ═══════════════════════════════════════════════════════════════════════════
        // SMART LOOP: Keep iterating until target reached or no more results
        // ═══════════════════════════════════════════════════════════════════════════
        while (validLeads.length < targetCount && this.isRunning && attempts < MAX_ATTEMPTS) {
            attempts++;
            const needed = targetCount - validLeads.length;
            const fetchAmount = needed * 4; // Smart multiplier x4

            onLog(`[ATTEMPT ${attempts}] 🔄 Búsqueda: ${fetchAmount} candidatos (faltantes: ${needed})...`);

            // STAGE 1: Google Maps scraping with pagination
            const totalMapsToScan = fetchAmount + totalScannedPreviously;

            const mapsResults = await this.callApifyActor(GOOGLE_MAPS_SCRAPER, {
                searchStringsArray: [query],
                maxCrawledPlacesPerSearch: Math.min(totalMapsToScan, 1000),
                language: 'es',
                includeWebsiteEmail: true,
                scrapeContacts: true,
                maxImages: 0,
                maxReviews: 0,
            }, onLog);

            onLog(`[DEBUG] 🔧 Apify retornó ${mapsResults.length} items (esperábamos ~${fetchAmount})...`);

            if (mapsResults.length === 0) {
                onLog(`[ATTEMPT ${attempts}] ⚠️ No se encontraron más resultados en Maps.`);
                break; // No more results
            }

            onLog(`[DEBUG] 🗺️ Maps devolvió ${mapsResults.length} resultados...`);

            // Analyze what Apify returned
            const withWebsiteRaw = mapsResults.filter((r: any) => r.website).length;
            const withEmailRaw = mapsResults.filter((r: any) => r.email || r.emails?.length).length;
            onLog(`[DEBUG] 📊 ${withWebsiteRaw} con website, ${withEmailRaw} con email interno...`);

            // Update pagination tracker
            totalScannedPreviously += mapsResults.length;

            // Convert to leads
            let allLeads: Lead[] = mapsResults.map((item: any, index: number) => {
                // Extract website - try multiple field names
                let website = '';
                if (item.website) {
                    website = item.website.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');
                } else if (item.websiteUrl) {
                    website = item.websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');
                }

                // Extract email - try multiple field names
                let email = '';
                if (item.email) {
                    email = item.email;
                } else if (item.emails && Array.isArray(item.emails) && item.emails.length > 0) {
                    email = item.emails[0];
                }

                return {
                    id: String(item.placeId || `lead-${Date.now()}-${attempts}-${index}`),
                    source: 'gmail' as const,
                    companyName: item.title || item.name || 'Sin Nombre',
                    website: website,
                    location: item.address || item.fullAddress || '',
                    decisionMaker: {
                        name: '',
                        role: 'Propietario',
                        email: email,
                        phone: item.phone || (item.phones?.[0]) || '',
                        linkedin: '',
                        facebook: item.facebook || '',
                        instagram: item.instagram || '',
                    },
                    aiAnalysis: {
                        summary: `${item.categoryName || interpreted.industry} - ${item.reviewsCount || 0} reseñas (${item.totalScore || 'N/A'}⭐)`,
                        painPoints: [],
                        generatedIcebreaker: '',
                        fullMessage: '',
                        fullAnalysis: '',
                        psychologicalProfile: '',
                        businessMoment: '',
                        salesAngle: ''
                    },
                    status: 'scraped' as const
                };
            });

            // Filter deduplication from existing leads (catch new ones)
            const newCandidates = allLeads.filter(lead => {
                const cleanWeb = lead.website?.replace('www.', '').toLowerCase();
                const cleanName = lead.companyName.toLowerCase();

                // Check if already in validLeads from this session
                const isSessionDuplicate = validLeads.some(v =>
                    v.website === lead.website || v.companyName === lead.companyName
                );

                return !isSessionDuplicate;
            });

            const withWebsite = newCandidates.filter(l => l.website && l.website.length > 0).length;
            const withEmail = newCandidates.filter(l => l.decisionMaker?.email).length;
            onLog(`[ATTEMPT ${attempts}] 📊 Candidatos: ${newCandidates.length} total (${withWebsite} con website, ${withEmail} con email)`);

            if (newCandidates.length === 0) {
                onLog(`[ATTEMPT ${attempts}] ⚠️ Todos los candidatos ya procesados.`);
                break;
            }

            onLog(`[ATTEMPT ${attempts}] ✨ ${newCandidates.length} candidatos únicos.`);
            allLeads = newCandidates;

            // STAGE 2: Aggressive Contact Enrichment
            const needEmail = allLeads.filter(l => !l.decisionMaker?.email && l.website);
            const alreadyHasEmail = allLeads.filter(l => l.decisionMaker?.email);

            onLog(`[ATTEMPT ${attempts}] ℹ️ ${alreadyHasEmail.length} con email / ${needEmail.length} necesitan scraping...`);

            if (needEmail.length > 0 && this.isRunning) {
                const BATCH_SIZE = 10;
                const batches = Math.ceil(needEmail.length / BATCH_SIZE);

                for (let i = 0; i < batches && this.isRunning; i++) {
                    const start = i * BATCH_SIZE;
                    const end = start + BATCH_SIZE;
                    const batch = needEmail.slice(start, end);

                    try {
                        const contactResults = await this.callApifyActor(CONTACT_SCRAPER, {
                            startUrls: batch.map(l => ({ url: `https://${l.website}` })),
                            maxRequestsPerWebsite: 3,
                            sameDomainOnly: true,
                            maxCrawlingDepth: 1,
                        }, (msg) => { });

                        for (const contact of contactResults) {
                            const contactUrl = contact.url || '';
                            const match = batch.find(l => {
                                if (!l.website) return false;
                                return contactUrl.includes(l.website.replace('www.', ''));
                            });

                            if (match && contact.emails?.length) {
                                const validEmails = contact.emails.filter((e: string) =>
                                    !e.includes('sentry') && !e.includes('noreply') && !e.includes('wix') && e.includes('@')
                                );

                                if (validEmails.length > 0) {
                                    match.decisionMaker.email = validEmails[0];
                                    onLog(`[GMAIL] 📧 Email: ${validEmails[0]}`);
                                }
                            }
                        }
                    } catch (e: any) {
                        onLog(`[GMAIL] ⚠️ Lote ${i + 1} falló: ${e.message}`);
                    }
                }
            }

            // Filter leads with email (but allow leads without email as fallback)
            const leadsWithEmail = allLeads.filter(l => l.decisionMaker?.email);
            const slotsRemaining = targetCount - validLeads.length;

            // Use leads with email, but if not enough, add leads without email
            let finalCandidates = leadsWithEmail.slice(0, slotsRemaining);

            if (finalCandidates.length < slotsRemaining && leadsWithEmail.length < allLeads.length) {
                const leadsWithoutEmail = allLeads.filter(l => !l.decisionMaker?.email);
                const slotsStillNeeded = slotsRemaining - finalCandidates.length;
                finalCandidates = finalCandidates.concat(leadsWithoutEmail.slice(0, slotsStillNeeded));
                onLog(`[ATTEMPT ${attempts}] ℹ️ Agregando ${leadsWithoutEmail.slice(0, slotsStillNeeded).length} leads sin email como fallback...`);
            }

            if (finalCandidates.length === 0) {
                onLog(`[ATTEMPT ${attempts}] ⚠️ No hay candidatos disponibles después del scraping.`);
                break; // Exit loop instead of continuing forever
            }

            onLog(`[ATTEMPT ${attempts}] 📊 ${leadsWithEmail.length} con email, ${finalCandidates.length - leadsWithEmail.length} sin email.`);

            // ═══════════════════════════════════════════════════════════════════
            // DEDUPLICACIÓN GLOBAL: Filtrar contra el historial del usuario
            // ═══════════════════════════════════════════════════════════════════
            onLog(`[DEDUP] 🎯 Filtrando ${finalCandidates.length} candidatos contra historial global...`);
            const deduplicatedCandidates = deduplicationService.filterUniqueCandidates(
                finalCandidates,
                existingWebsites,
                existingCompanyNames,
                existingEmails,
                existingLinkedinUrls
            );

            if (deduplicatedCandidates.length < finalCandidates.length) {
                onLog(
                    `[DEDUP] ⚠️ ${finalCandidates.length - deduplicatedCandidates.length} candidatos rechazados (ya en historial). ` +
                    `Quedaron ${deduplicatedCandidates.length} nuevos.`
                );
            }

            if (deduplicatedCandidates.length === 0) {
                onLog(`[ATTEMPT ${attempts}] ℹ️ Todos los candidatos de este intento fueron rechazados por deduplicación.`);
                continue; // Try next attempt to find fresh leads
            }

            // Add successful leads to collection (only those that passed global dedup)
            const leadsToAdd = deduplicatedCandidates;

            for (const lead of leadsToAdd) {
                validLeads.push(lead);
                onLog(`[SUCCESS] ✅ Lead ${validLeads.length}/${targetCount}: ${lead.companyName}`);
            }
        } // End Smart Loop

        onLog(`[GMAIL] 📊 Búsqueda completada: ${validLeads.length}/${targetCount} en ${attempts} intentos...`);

        // STAGE 3: Quick AI analysis
        if (this.isRunning) {
            const leadsToAnalyze = validLeads.slice(0, targetCount);

            for (let i = 0; i < leadsToAnalyze.length && this.isRunning; i++) {
                const lead = leadsToAnalyze[i];
                lead.aiAnalysis.generatedIcebreaker = `Hola, he visto vuestra web ${lead.website}...`;
                lead.status = 'ready';

                if (leadsToAnalyze.length <= 20) {
                    try {
                        const research = await this.deepResearchLead(lead, (m) => { });
                        const analysis = await this.generateUltraAnalysis(lead, research);
                        lead.aiAnalysis.fullAnalysis = analysis.fullAnalysis;
                        lead.aiAnalysis.psychologicalProfile = analysis.psychologicalProfile;
                        lead.aiAnalysis.businessMoment = analysis.businessMoment;
                        lead.aiAnalysis.salesAngle = analysis.salesAngle;
                        lead.aiAnalysis.fullMessage = analysis.personalizedMessage;

                        // Generate Message A (Product-focused)
                        const messages = await this.generateOneMessage(lead);
                        lead.messageA = messages.messageA;
                    } catch (e) {
                        lead.aiAnalysis.fullMessage = `Contacto disponible en ${lead.website}`;
                        // Fallback message
                        lead.messageA = `Hola ${lead.decisionMaker?.name || 'equipo'}, quisiera hablar sobre automatización.`;
                    }
                }
            }
        }

        onLog(`[GMAIL] 🏁 FINALIZADO: ${validLeads.length} leads listos`);
        onComplete(validLeads);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LINKEDIN SEARCH - SMART LOOP WITH PAGINATION
    // ═══════════════════════════════════════════════════════════════════════════
    private async searchLinkedIn(
        config: SearchConfigState,
        interpreted: { searchQuery: string; industry: string; targetRoles: string[]; location: string },
        existingWebsites: Set<string>,
        existingCompanyNames: Set<string>,
        existingEmails: Set<string>,
        existingLinkedinUrls: Set<string>,
        onLog: LogCallback,
        onComplete: ResultCallback
    ) {
        console.log('[LINKEDIN] 🚀 searchLinkedIn iniciado');
        onLog(`[LINKEDIN] 🚀 Iniciando búsqueda LinkedIn...`);

        // Check Hard Limit
        let targetCount = config.maxResults;
        if (!targetCount || targetCount < 1) targetCount = 1;
        // if (targetCount > 20) targetCount = 20; // Removed limit

        const validLeads: Lead[] = [];
        let attempts = 0;
        const MAX_ATTEMPTS = 10;
        let currentPage = 1;

        onLog(`[LINKEDIN] 🕵️‍♂️ Target: ${targetCount} leads`);
        console.log('[LINKEDIN] Target count:', targetCount);

        // ═══════════════════════════════════════════════════════════════════════════
        // SMART LOOP: Paginate through results
        // ═══════════════════════════════════════════════════════════════════════════
        while (validLeads.length < targetCount && this.isRunning && attempts < MAX_ATTEMPTS) {
            attempts++;
            const needed = targetCount - validLeads.length;
            const resultsToFetch = needed * 4; // x4 multiplier

            onLog(`[LINKEDIN-ATTEMPT ${attempts}] 🔄 Página ${currentPage}: ${resultsToFetch} resultados...`);

            // Rely solely on the user configuration
            let activeQuery = config.query;
            if (config.advancedFilters) {
                activeQuery = this.buildQueryWithAdvancedFilters(activeQuery, config.advancedFilters);
            }
            activeQuery = `site:linkedin.com/in ${activeQuery}`;

            try {
                const searchResults = await this.callApifyActor(GOOGLE_SEARCH_SCRAPER, {
                    queries: activeQuery,
                    maxPagesPerQuery: currentPage, // Paginate
                    resultsPerPage: resultsToFetch,
                    languageCode: 'es',
                    countryCode: 'es',
                }, onLog);

                let allResults: any[] = [];
                for (const result of searchResults) {
                    if (result.organicResults) allResults = allResults.concat(result.organicResults);
                }

                if (allResults.length === 0) {
                    onLog(`[LINKEDIN-ATTEMPT ${attempts}] ⚠️ No hay más resultados en página ${currentPage}.`);
                    break;
                }

                const linkedInProfiles = allResults.filter((r: any) => r.url?.includes('linkedin.com/in/'));
                onLog(`[DEBUG] 👤 Perfiles encontrados: ${linkedInProfiles.length}`);

                if (linkedInProfiles.length === 0) {
                    onLog(`[LINKEDIN-ATTEMPT ${attempts}] ⚠️ Sin perfiles en esta página.`);
                    break;
                }

                // Transform raw profiles into provisional Leads
                const provisionalCandidates: Lead[] = [];
                for (let i = 0; i < linkedInProfiles.length; i++) {
                    const profile = linkedInProfiles[i];
                    const titleParts = (profile.title || '').split(' - ');
                    const name = titleParts[0]?.replace(' | LinkedIn', '').trim() || 'Usuario LinkedIn';
                    const role = this.extractRole(profile.title) || 'Decisor';
                    const company = this.extractCompany(profile.title) || 'Empresa Desconocida';

                    provisionalCandidates.push({
                        id: `linkedin-${Date.now()}-${i}`,
                        source: 'linkedin',
                        companyName: company,
                        website: '',
                        location: interpreted.location,
                        decisionMaker: {
                            name,
                            role,
                            email: '',
                            phone: '',
                            linkedin: profile.url
                        },
                        aiAnalysis: {
                            summary: '',
                            fullAnalysis: '',
                            psychologicalProfile: '',
                            businessMoment: '',
                            salesAngle: '',
                            fullMessage: '',
                            generatedIcebreaker: '',
                            painPoints: []
                        },
                        isNPLPotential: false,
                        status: 'scraped'
                    });
                }

                // ═══════════════════════════════════════════════════════════════════════════
                // DEDUPLICATION: Filter against current session & global history BEFORE analysis
                // ═══════════════════════════════════════════════════════════════════════════
                const sessionUnique = provisionalCandidates.filter(candidate =>
                    !validLeads.some(dl => dl.companyName === candidate.companyName || dl.decisionMaker?.linkedin === candidate.decisionMaker?.linkedin)
                );

                let globalUnique: Lead[] = [];
                if (sessionUnique.length > 0) {
                    onLog(`[DEDUP] 🎯 Filtrando ${sessionUnique.length} candidatos LinkedIn contra historial global...`);
                    globalUnique = deduplicationService.filterUniqueCandidates(
                        sessionUnique,
                        existingWebsites,
                        existingCompanyNames,
                        existingEmails,
                        existingLinkedinUrls
                    );

                    if (globalUnique.length < sessionUnique.length) {
                        onLog(
                            `[DEDUP] ⚠️ ${sessionUnique.length - globalUnique.length} duplicados descartados. ` +
                            `Quedan ${globalUnique.length} nuevos por procesar.`
                        );
                    }
                }

                if (globalUnique.length === 0) {
                    onLog(`[LINKEDIN-ATTEMPT ${attempts}] ℹ️ Todos los candidatos de esta página ya existen en historial.`);
                    currentPage++;
                    continue;
                }

                // Slice the results exactly to what we need
                const remainingSlots = targetCount - validLeads.length;
                const candidatesToProcess = globalUnique.slice(0, remainingSlots);

                onLog(`[INFO] Procesando ${candidatesToProcess.length} leads únicos (saltando el resto para respetar target: ${targetCount}).`);

                const POSTS_SCRAPER = 'LQQIXN9Othf8f7R5n';

                // Process AI only for the needed unique profiles
                for (let i = 0; i < candidatesToProcess.length && this.isRunning; i++) {
                    if (validLeads.length >= targetCount) break;

                    const candidate = candidatesToProcess[i];
                    onLog(`[RESEARCH] 🧠 Analizando: ${candidate.decisionMaker?.name}...`);

                    let recentPostsText = "";
                    try {
                        const postsData = await this.callApifyActor(POSTS_SCRAPER, {
                            username: candidate.decisionMaker?.linkedin,
                            limit: 3
                        }, () => { });

                        if (postsData && postsData.length > 0) {
                            recentPostsText = postsData.map((p: any) => `${p.text?.substring(0, 150)}...`).join('\n');
                        }
                    } catch (e) {
                        // Silent - posts are optional
                    }

                    const researchDossier = `PERFIL: ${candidate.decisionMaker?.name}\nHeadline: ${candidate.decisionMaker?.role} en ${candidate.companyName}\nReciente: ${recentPostsText || "N/A"}`;

                    try {
                        const analysis = await this.generateUltraAnalysis({
                            companyName: candidate.companyName,
                            decisionMaker: { name: candidate.decisionMaker?.name, role: candidate.decisionMaker?.role, linkedin: candidate.decisionMaker?.linkedin }
                        } as Lead, researchDossier);

                        // Generate Message A (Product-focused)
                        const messages = await this.generateOneMessage({
                            companyName: candidate.companyName,
                            decisionMaker: { name: candidate.decisionMaker?.name, role: candidate.decisionMaker?.role, linkedin: candidate.decisionMaker?.linkedin }
                        } as Lead);

                        candidate.aiAnalysis = {
                            summary: `Psicología: ${analysis.bottleneck}`,
                            fullAnalysis: analysis.fullAnalysis,
                            psychologicalProfile: analysis.psychologicalProfile,
                            businessMoment: analysis.businessMoment,
                            salesAngle: analysis.salesAngle,
                            fullMessage: analysis.personalizedMessage,
                            generatedIcebreaker: analysis.bottleneck,
                            painPoints: []
                        };
                        candidate.messageA = messages.messageA;
                        candidate.status = 'ready';

                        validLeads.push(candidate);
                        onLog(`[SUCCESS] ✅ Lead ${validLeads.length}/${targetCount}: ${candidate.companyName}`);

                    } catch (e) {
                        onLog(`[RESEARCH] ⚠️ Análisis fallido para ${candidate.decisionMaker?.name}`);
                    }
                }

                currentPage++;

            } catch (error: any) {
                onLog(`[LINKEDIN-ATTEMPT ${attempts}] ❌ Error: ${error.message}`);
                break;
            }
        } // End Smart Loop

        onLog(`[LINKEDIN] 🏁 Búsqueda completada: ${validLeads.length}/${targetCount} en ${attempts} intentos`);
        onComplete(validLeads);
    }

    private extractCompany(text: string): string {
        // Heuristic: "CEO en [Empresa]" or "CEO at [Company]"
        const atMatch = text.match(/\b(en|at|@)\s+([^|\-.,]+)/i);
        if (atMatch && atMatch[2]) return atMatch[2].trim();
        return '';
    }

    private extractRole(text: string): string {
        const lower = text.toLowerCase();
        if (lower.includes('ceo')) return 'CEO';
        if (lower.includes('founder') || lower.includes('fundador')) return 'Fundador';
        if (lower.includes('owner') || lower.includes('propietario')) return 'Propietario';
        if (lower.includes('director')) return 'Director';
        return '';
    }
}

export const searchService = new SearchService();
