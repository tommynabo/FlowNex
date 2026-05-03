import { Lead, SearchConfigState, AudienceTier } from '../../lib/types';
import { deduplicationService } from '../deduplication/DeduplicationService';
import { PROJECT_CONFIG } from '../../config/project';
import { icpEvaluator, RawApifyProfile } from './ICPEvaluator';
import { emailDiscoveryService } from './EmailDiscoveryService';
import { instagramSearchEngine } from './InstagramSearchEngine';

export type LogCallback = (message: string) => void;
export type ResultCallback = (leads: Lead[]) => void;

// Two-step scraping: hashtag posts → unique usernames → full profiles
const INSTAGRAM_HASHTAG_SCRAPER = 'apify~instagram-hashtag-scraper';
const INSTAGRAM_PROFILE_SCRAPER = 'apify~instagram-profile-scraper';

// Maps campaign region codes to patterns found in Apify's country/city/location fields
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

export class SearchService {
    private isRunning = false;
    private apiKey: string = '';
    private userId: string | null = null;

    public stop() {
        this.isRunning = false;
        // Also stop the Instagram engine if it's running
        instagramSearchEngine.stop();
    }

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
            'Email: ' + (lead.decisionMaker?.email || 'none')
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
                                content: 'You are an expert cold email copywriter for Instagram fitness/personal development creator outreach.\n' +
                                    'GOAL: Write a cold email pitching a VSL link. Personal, peer-to-peer, not mass blast.\n' +
                                    'TONE: Direct, confident, no fluff. English only. Under 120 words. No emojis in subject.\n' +
                                    'Rules: Reference their niche. CTA = watch VSL. Subject under 8 words.\n' +
                                    'Respond ONLY with this JSON (no markdown):\n' +
                                    '{"coldEmailSubject":"...","coldEmailBody":"...","vslPitch":"One-liner hook max 15 words","psychologicalProfile":"2-sentence assessment","engagementSignal":"inferred signal","salesAngle":"top reason they say yes","summary":"one sentence lead description"}'
                            },
                            {
                                role: 'user',
                                content: 'Analyze this creator and write outreach:\n' + ctx + '\nVSL Link: ' + vslLink
                            }
                        ],
                        temperature: 0.7,
                        max_tokens: 600
                    })
                });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const data = await response.json();
                const raw = data.choices?.[0]?.message?.content || '';
                const jsonMatch = raw.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const p = JSON.parse(jsonMatch[0]);
                    return {
                        coldEmailSubject: p.coldEmailSubject || ('Quick question about your ' + lead.niche + ' content'),
                        coldEmailBody: p.coldEmailBody || this.fallbackEmailBody(lead, vslLink),
                        vslPitch: p.vslPitch || ('Scale your ' + lead.niche + ' brand without more hours'),
                        psychologicalProfile: p.psychologicalProfile || 'Ambitious creator focused on growth.',
                        engagementSignal: p.engagementSignal || 'Active niche audience.',
                        salesAngle: p.salesAngle || 'Monetization opportunity.',
                        summary: p.summary || (lead.niche + ' creator with ' + followerStr + ' followers.')
                    };
                }
            } catch (e) {
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
            summary: lead.niche + ' creator with ' + followerStr + ' followers.'
        };
    }

    private fallbackEmailBody(lead: Lead, vslLink: string): string {
        const name = lead.decisionMaker?.name?.split(' ')[0] || 'there';
        return 'Hey ' + name + ',\n\n' +
            'Love what you are building in the ' + (lead.niche || 'fitness') + ' space.\n\n' +
            'I have been working with creators your size on something that quietly adds 5-6 figures without extra content output.\n\n' +
            'Short 4-min video: ' + vslLink + '\n\n' +
            'Worth a watch if you are thinking about scaling.';
    }

    private async callApifyActor(actorId: string, input: any, onLog: LogCallback): Promise<any[]> {
        // Use the /api/apify proxy (configured in vite.config.ts and vercel.json)
        const baseUrl = '/api/apify';
        const startUrl = baseUrl + '/acts/' + actorId + '/runs?token=' + this.apiKey;
        onLog('[APIFY] Launching ' + actorId.split('/').pop() + '...');

        let startResponse: Response;
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 300_000);
            startResponse = await fetch(startUrl, {
                method: 'POST', signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input)
            });
            clearTimeout(tid);
        } catch (e: any) { throw new Error('Network error: ' + e.message); }

        if (!startResponse.ok) {
            let errBody = '';
            try { errBody = await startResponse.text(); } catch (_) {}
            const errSnippet = errBody.substring(0, 300);
            onLog('[APIFY] ❌ HTTP ' + startResponse.status + ' launching ' + actorId.split('~').pop());
            onLog('[APIFY] Error body: ' + (errSnippet || '(empty)'));
            console.error('[APIFY] Full error body:', errBody);
            throw new Error('Actor error HTTP ' + startResponse.status + ': ' + errSnippet);
        }

        const startData = await startResponse.json();
        const runId = startData.data?.id;
        const datasetId = startData.data?.defaultDatasetId;
        if (!runId || !datasetId) throw new Error('Apify: missing runId or datasetId');
        onLog('[APIFY] Started run ' + runId.substring(0, 8));

        let done = false; let polls = 0;
        while (!done && this.isRunning && polls < 600) {
            await new Promise(r => setTimeout(r, 5000)); polls++;
            try {
                const s = await fetch(baseUrl + '/acts/' + actorId + '/runs/' + runId + '?token=' + this.apiKey);
                if (!s.ok) continue;
                const sd = await s.json();
                const status = sd.data?.status;
                if (polls % 3 === 1) onLog('[APIFY] ' + status + ' (' + (polls * 5) + 's)');
                if (status === 'SUCCEEDED') done = true;
                else if (status === 'FAILED' || status === 'ABORTED') throw new Error('Actor ' + status);
            } catch (pe: any) {
                if (pe.message?.includes('FAILED') || pe.message?.includes('ABORTED')) throw pe;
            }
        }
        if (!done) throw new Error('Apify timeout');
        if (!this.isRunning) return [];

        onLog('[APIFY] Downloading dataset...');
        const r = await fetch(baseUrl + '/datasets/' + datasetId + '/items?token=' + this.apiKey);
        if (!r.ok) throw new Error('Dataset HTTP ' + r.status);
        const items = await r.json();
        if (!Array.isArray(items)) throw new Error('Dataset not array');
        onLog('[APIFY] ' + items.length + ' profiles retrieved');
        return items;
    }

    public async startSearch(
        config: SearchConfigState,
        onLog: LogCallback,
        onComplete: ResultCallback,
        userId?: string | null,
        onLeadFound?: (lead: Lead) => void,
    ) {
        this.isRunning = true;
        this.userId = userId || null;
        try {
            // Instagram searches are handled by InstagramSearchEngine
            // which implements the "keep going until N" loop with hashtag rotation
            if (config.source === 'instagram') {
                await instagramSearchEngine.startSearch(config, onLog, onComplete, userId, onLeadFound);
                return;
            }

            this.apiKey = import.meta.env.VITE_APIFY_API_TOKEN || '';
            onLog('[INIT] Apify key: ' + (this.apiKey ? 'present (' + this.apiKey.substring(0, 12) + '...)' : 'MISSING'));
            onLog('[INIT] AI: /api/openai available');
            onLog('[INIT] UserId: ' + (this.userId || 'not authenticated'));
            onLog('[INIT] Source: ' + config.source + ' | Query: "' + config.query + '" | Max: ' + config.maxResults);
            if (!this.apiKey) throw new Error('Missing VITE_APIFY_API_TOKEN');

            onLog('[DEDUP] Loading existing leads...');
            const { existingIgHandles, existingEmails } = await deduplicationService.fetchExistingLeads(this.userId);
            onLog('[DEDUP] Pre-flight: ' + existingIgHandles.size + ' IG handles, ' + existingEmails.size + ' emails');

            await this.searchInstagram(config, existingIgHandles, existingEmails, onLog, onComplete);
        } catch (error: any) {
            console.error('[SearchService] FATAL:', error);
            onLog('[ERROR] ' + error.message);
            onComplete([]);
        } finally { this.isRunning = false; }
    }

    private async searchInstagram(
        config: SearchConfigState,
        existingIgHandles: Set<string>,
        existingEmails: Set<string>,
        onLog: LogCallback,
        onComplete: ResultCallback
    ) {
        const icpFilters = config.icpFilters;
        const minFollowers = icpFilters?.minFollowers ?? 0;
        const maxFollowers = icpFilters?.maxFollowers ?? 99_000_000;
        const targetRegions = icpFilters?.regions ?? [];
        const targetContentTypes = icpFilters?.contentTypes ?? [];
        const targetCount = Math.max(1, config.maxResults);
        const hashtags = this.parseHashtagsFromQuery(config.query);

        onLog('[IG] Hashtags to search: ' + hashtags.join(', '));
        onLog('[IG] Target: ' + targetCount + ' creators');
        if (minFollowers > 0 || maxFollowers < 99_000_000)
            onLog('[ICP] Follower range: ' + this.formatFollowers(minFollowers) + ' – ' + this.formatFollowers(maxFollowers));
        if (targetRegions.length > 0)
            onLog('[ICP] Regions: ' + targetRegions.join(', '));
        if (targetContentTypes.length > 0)
            onLog('[ICP] Content types: ' + targetContentTypes.join(', '));

        const validLeads: Lead[] = [];
        let attempts = 0;
        const processedHandles = new Set<string>();

        while (validLeads.length < targetCount && this.isRunning && attempts < 6) {
            attempts++;
            const needed = targetCount - validLeads.length;
            // Fetch enough posts to find good profiles (ICP filters reduce final count)
            const postFetchLimit = Math.min(needed * 20, 300);
            onLog('━━━ CICLO ' + attempts + ' ━━━  Buscando ' + needed + ' lead(s) más...');
            onLog('📸 PASO 1/4 — Scrapeando ' + postFetchLimit + ' posts de hashtags...');

            // ── STEP 1: Get posts from hashtags ──────────────────────────────────
            let posts: any[];
            try {
                posts = await this.callApifyActor(INSTAGRAM_HASHTAG_SCRAPER, {
                    hashtags: hashtags.map(h => h.replace(/^#/, '')), // actor expects no #
                    resultsLimit: postFetchLimit,
                    proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
                }, onLog);
            } catch (e: any) {
                onLog('[ATTEMPT ' + attempts + '] Hashtag scraper error: ' + e.message);
                break;
            }

            if (!posts.length) {
                onLog('📸 PASO 1/4 — Sin posts devueltos por el hashtag scraper.');
                break;
            }

            // Extract unique usernames not yet processed or in DB
            const rawHandles = posts
                .map(p => (p.ownerUsername || p.owner?.username || p.username || '').toLowerCase().trim())
                .filter(h => h && !processedHandles.has(h) && !existingIgHandles.has(h));
            const uniqueHandles = [...new Set(rawHandles)].slice(0, 50);

            onLog('📸 PASO 1/4 ✓ — ' + posts.length + ' posts → ' + uniqueHandles.length + ' handles únicos nuevos');

            if (!uniqueHandles.length) {
                onLog('⚠ Todos los handles ya procesados. Deteniendo ciclo.');
                break;
            }

            // ── STEP 2: Scrape full profiles for those handles ───────────────────
            onLog('👤 PASO 2/4 — Descargando ' + uniqueHandles.length + ' perfiles completos de Instagram...');
            let profiles: any[];
            try {
                profiles = await this.callApifyActor(INSTAGRAM_PROFILE_SCRAPER, {
                    usernames: uniqueHandles
                }, onLog);
            } catch (e: any) {
                onLog('👤 PASO 2/4 ✗ Error en profile scraper: ' + e.message);
                break;
            }

            onLog('👤 PASO 2/4 ✓ — ' + profiles.length + ' perfiles recibidos');
            onLog('🔍 PASO 3/4 — Aplicando filtros ICP...');

            // ── STEP 2b: Hard Filter — follower range + brand keywords ────────────
            const hardFiltered = icpEvaluator.applyHardFilter(profiles as RawApifyProfile[], onLog);
            onLog('[HARD FILTER] ' + profiles.length + ' → ' + hardFiltered.length + ' perfiles tras filtro de followers/marca/fitness');

            // ── STEP 3: Apply ICP filters & build candidates ─────────────────────
            const candidates: Lead[] = [];
            for (const profile of hardFiltered) {
                if (!this.isRunning) break;
                const handle = (profile.username || '').toLowerCase().trim();
                if (!handle || processedHandles.has(handle)) continue;
                processedHandles.add(handle);

                const followers = profile.followersCount || profile.followers || 0;
                const bio = profile.biography || profile.bio || '';
                const fullName = profile.fullName || profile.name || '';
                // Stage 1 email: bio regex first, then Apify native business/public email fields
                const emailFromBio = this.extractEmailFromBio(bio);
                const emailFromApify = (profile.publicEmail as string || profile.businessEmail as string || profile.email as string || profile.contactEmail as string || '').toLowerCase().trim();
                const email = emailFromBio || emailFromApify;
                const website = (profile.externalUrl as string || profile.website as string || '').trim();
                const niche = this.detectNiche(bio, handle, fullName);
                const region = profile.country || profile.city || '';

                // ICP: follower range
                if (followers < minFollowers) {
                    onLog('[ICP] ↓ @' + handle + ' skip: ' + this.formatFollowers(followers) + ' < min ' + this.formatFollowers(minFollowers));
                    continue;
                }
                if (followers > maxFollowers) {
                    onLog('[ICP] ↑ @' + handle + ' skip: ' + this.formatFollowers(followers) + ' > max ' + this.formatFollowers(maxFollowers));
                    continue;
                }

                // ICP: region filter — only reject if location is known AND contradicts the filter
                if (targetRegions.length > 0) {
                    const locationFields = [
                        profile.country, profile.city, profile.region,
                        profile.countryCode, profile.locationName
                    ].map(v => (v as string || '').toLowerCase()).join(' ');

                    if (locationFields.trim()) {
                        // We have location data — check if it matches any target region
                        const matchesRegion = targetRegions.some(r => {
                            const patterns = REGION_MAP[r] ?? [r.toLowerCase()];
                            return patterns.some(p => locationFields.includes(p));
                        });
                        if (!matchesRegion) {
                            onLog('[ICP] 🌍 @' + handle + ' skip: location "' + (profile.country || profile.city || '') + '" not in [' + targetRegions.join(', ') + ']');
                            continue;
                        }
                    }
                    // No location data — allow through (can’t confirm but can’t reject)
                }

                // ICP: content type filter
                if (targetContentTypes.length > 0) {
                    const matchesContent = targetContentTypes.some(ct =>
                        niche.toLowerCase().includes(ct.toLowerCase()) ||
                        ct.toLowerCase().includes(niche.split(' ')[0].toLowerCase())
                    );
                    if (!matchesContent) {
                        onLog('[ICP] 🏷 @' + handle + ' skip: niche "' + niche + '" not in [' + targetContentTypes.join(', ') + ']');
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
                    location: region,
                    website,
                    decisionMaker: {
                        name: fullName || ('@' + handle),
                        role: 'Content Creator',
                        email,
                        instagram: 'https://instagram.com/' + handle
                    },
                    aiAnalysis: {
                        summary: bio, painPoints: [], generatedIcebreaker: '',
                        coldEmailSubject: '', coldEmailBody: '', vslPitch: '',
                        fullAnalysis: '', psychologicalProfile: '', engagementSignal: '', salesAngle: ''
                    },
                    vsl_sent_status: 'pending',
                    email_status: 'pending',
                    status: 'scraped'
                });
            }

            const uniqueCandidates = deduplicationService.filterUniqueCandidates(candidates, existingIgHandles, existingEmails);
            const deduped = candidates.length - uniqueCandidates.length;
            if (deduped > 0) onLog('[DEDUP] ' + deduped + ' duplicates discarded.');

            const withEmail = uniqueCandidates.filter(l => l.decisionMaker?.email);
            const withoutEmail = uniqueCandidates.filter(l => !l.decisionMaker?.email);
            const slotsRemaining = targetCount - validLeads.length;
            const toProcess = [
                ...withEmail.slice(0, slotsRemaining),
                ...(withEmail.length < slotsRemaining ? withoutEmail.slice(0, slotsRemaining - withEmail.length) : [])
            ];

            onLog('🔍 PASO 3/4 ✓ — ' + withEmail.length + ' con email, ' + withoutEmail.length + ' sin email. Procesando ' + toProcess.length + ' candidatos.');
            if (!toProcess.length) { onLog('⚠ Todos ya en historial. Siguiente ciclo...'); continue; }

            // ── STEP 4b: Soft Filter — AI human creator evaluation ────────────────
            const softFiltered = await icpEvaluator.applySoftFilter(toProcess, onLog);

            // ── STEP 4c: Email Discovery — 3-stage pipeline for leads missing email ─
            onLog('📧 PASO 4/4 — Descubrimiento de email (3 etapas) para ' + softFiltered.length + ' candidatos...');
            await Promise.all(softFiltered.map(async (lead) => {
                if (!this.isRunning) return;
                const currentEmail = lead.decisionMaker?.email || '';
                const discoveredEmail = await emailDiscoveryService.discoverEmail(
                    currentEmail,
                    lead.website || '',
                    lead.ig_handle || '',
                    onLog
                );
                if (discoveredEmail && lead.decisionMaker) {
                    lead.decisionMaker.email = discoveredEmail;
                }
            }));
            const withEmailAfterDiscovery = softFiltered.filter(l => l.decisionMaker?.email).length;
            onLog('📧 PASO 4/4 ✓ — ' + withEmailAfterDiscovery + '/' + softFiltered.length + ' leads tienen email');

            onLog('🤖 Generando análisis IA para ' + softFiltered.length + ' creadores...');
            const analyzed = (await Promise.all(softFiltered.map(async (lead) => {
                if (!this.isRunning) return null;
                try {
                    const a = await this.generateCreatorAnalysis(lead);
                    lead.aiAnalysis = {
                        summary: a.summary, painPoints: [],
                        generatedIcebreaker: a.vslPitch,
                        coldEmailSubject: a.coldEmailSubject, coldEmailBody: a.coldEmailBody,
                        vslPitch: a.vslPitch, fullAnalysis: a.psychologicalProfile + ' | ' + a.engagementSignal,
                        psychologicalProfile: a.psychologicalProfile,
                        engagementSignal: a.engagementSignal, salesAngle: a.salesAngle
                    };
                    lead.status = 'ready';
                    return lead;
                } catch {
                    lead.aiAnalysis.summary = lead.niche + ' creator — ' + this.formatFollowers(lead.follower_count || 0) + ' followers';
                    lead.status = 'ready';
                    return lead;
                }
            }))).filter(Boolean) as Lead[];

            for (const lead of analyzed) {
                if (!lead.decisionMaker?.email) {
                    onLog('[SKIP] @' + lead.ig_handle + ' → sin email encontrado, descartado');
                    continue;
                }
                validLeads.push(lead);
                onLog('[✓] ' + validLeads.length + '/' + targetCount + ': @' + lead.ig_handle +
                    ' (' + this.formatFollowers(lead.follower_count || 0) + ' | ' + lead.niche + ') 📧 ' + lead.decisionMaker.email);
                if (validLeads.length >= targetCount) break;
            }
        }

        onLog('[IG] Complete: ' + validLeads.length + '/' + targetCount + ' creators found');
        await this.sendLeadsToInstantly(validLeads, onLog, config.instantlyCampaignId);
        onComplete(validLeads);
    }

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
                    // Lead already exists in the campaign — not an error
                    skipped++;
                    onLog('[INSTANTLY] ℹ Ya en campaña: ' + email);
                } else {
                    failed++;
                    const err = await response.json().catch(() => ({})) as { error?: string };
                    onLog('[INSTANTLY] ❌ Error ' + response.status + ' para ' + email + ': ' + (err.error || 'unknown'));
                }
            } catch (e: any) {
                failed++;
                onLog('[INSTANTLY] ❌ Error de red para ' + email + ': ' + e.message);
            }
        }

        onLog('[INSTANTLY] 📊 ' + sent + ' enviados' + (skipped ? ', ' + skipped + ' ya existían' : '') + (failed ? ', ' + failed + ' errores' : ''));
    }

    private parseHashtagsFromQuery(query: string): string[] {
        const defaults = PROJECT_CONFIG.flownextConfig?.targetHashtags || [
            '#fitnesscoach', '#personaldevelopment', '#mindset', '#gymlife', '#workout'
        ];
        if (!query) return defaults.slice(0, 5);
        const explicit = query.match(/#[a-zA-Z0-9_]+/g);
        if (explicit && explicit.length > 0) return explicit.slice(0, 10);
        const lower = query.toLowerCase();
        const tags: string[] = [];
        if (/fitness|gym|workout|training/.test(lower)) tags.push('#fitnesscoach', '#gymlife', '#workout');
        if (/yoga|wellness|mindfulness/.test(lower)) tags.push('#yoga', '#wellness', '#mindfulness');
        if (/personal.?dev|mindset|selfimprovement|motivation/.test(lower)) tags.push('#personaldevelopment', '#mindset', '#selfimprovement');
        if (/nutrition|diet|health/.test(lower)) tags.push('#nutrition', '#healthylifestyle');
        if (/business|entrepreneur/.test(lower)) tags.push('#entrepreneur', '#businesscoach');
        return tags.length > 0 ? tags.slice(0, 8) : defaults.slice(0, 5);
    }
}

export const searchService = new SearchService();
