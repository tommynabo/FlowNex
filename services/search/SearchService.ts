import { Lead, SearchConfigState, AudienceTier } from '../../lib/types';
import { deduplicationService } from '../deduplication/DeduplicationService';
import { PROJECT_CONFIG } from '../../config/project';

export type LogCallback = (message: string) => void;
export type ResultCallback = (leads: Lead[]) => void;

const INSTAGRAM_PROFILE_SCRAPER = 'apify~instagram-profile-scraper';

export class SearchService {
    private isRunning = false;
    private apiKey: string = '';
    private userId: string | null = null;

    public stop() { this.isRunning = false; }

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
        return 'Health & Fitness';
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
        const baseUrl = 'https://api.apify.com/v2';
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
            await startResponse.text();
            onLog('[APIFY] HTTP ' + startResponse.status);
            throw new Error('Actor error HTTP ' + startResponse.status);
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
        userId?: string | null
    ) {
        this.isRunning = true;
        this.userId = userId || null;
        try {
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
        const targetCount = Math.max(1, config.maxResults);
        const hashtags = this.parseHashtagsFromQuery(config.query);
        onLog('[IG] Hashtags: ' + hashtags.join(', '));
        onLog('[IG] Target: ' + targetCount + ' creators');

        const validLeads: Lead[] = [];
        let attempts = 0;
        const processedHandles = new Set<string>();

        while (validLeads.length < targetCount && this.isRunning && attempts < 8) {
            attempts++;
            const needed = targetCount - validLeads.length;
            const fetchAmount = Math.min(needed * 6, 200);
            onLog('[ATTEMPT ' + attempts + '] Scraping ' + fetchAmount + ' profiles (need ' + needed + ' more)...');

            let rawProfiles: any[];
            try {
                rawProfiles = await this.callApifyActor(INSTAGRAM_PROFILE_SCRAPER, {
                    hashtags,
                    resultsLimit: fetchAmount,
                    resultsType: 'posts',
                    proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
                }, onLog);
            } catch (e: any) {
                onLog('[ATTEMPT ' + attempts + '] Scraper error: ' + e.message);
                break;
            }

            if (rawProfiles.length === 0) {
                onLog('[ATTEMPT ' + attempts + '] No profiles returned.');
                break;
            }

            const candidates: Lead[] = [];
            for (const profile of rawProfiles) {
                const handle = (profile.username || profile.ownerUsername || '').toLowerCase().trim();
                if (!handle || processedHandles.has(handle)) continue;
                processedHandles.add(handle);
                const bio = profile.biography || profile.bio || '';
                const email = this.extractEmailFromBio(bio);
                const followerCount = profile.followersCount || profile.followers || 0;
                const fullName = profile.fullName || profile.name || '';
                candidates.push({
                    id: 'ig-' + handle + '-' + Date.now(),
                    source: 'instagram',
                    ig_handle: handle,
                    follower_count: followerCount,
                    niche: this.detectNiche(bio, handle, fullName),
                    audience_tier: this.detectAudienceTier(followerCount),
                    location: profile.city || profile.country || '',
                    decisionMaker: {
                        name: fullName || ('@' + handle),
                        role: 'Content Creator',
                        email,
                        instagram: 'https://instagram.com/' + handle
                    },
                    aiAnalysis: {
                        summary: '', painPoints: [], generatedIcebreaker: '',
                        coldEmailSubject: '', coldEmailBody: '', vslPitch: '',
                        fullAnalysis: '', psychologicalProfile: '', engagementSignal: '', salesAngle: ''
                    },
                    vsl_sent_status: 'pending',
                    email_status: 'pending',
                    status: 'scraped'
                });
            }

            const uniqueCandidates = deduplicationService.filterUniqueCandidates(candidates, existingIgHandles, existingEmails);
            if (uniqueCandidates.length < candidates.length) {
                onLog('[DEDUP] ' + (candidates.length - uniqueCandidates.length) + ' duplicates discarded.');
            }

            const withEmail = uniqueCandidates.filter(l => l.decisionMaker?.email);
            const withoutEmail = uniqueCandidates.filter(l => !l.decisionMaker?.email);
            const slotsRemaining = targetCount - validLeads.length;
            const toProcess = [
                ...withEmail.slice(0, slotsRemaining),
                ...(withEmail.length < slotsRemaining ? withoutEmail.slice(0, slotsRemaining - withEmail.length) : [])
            ];

            onLog('[ATTEMPT ' + attempts + '] ' + withEmail.length + ' with email, ' + withoutEmail.length + ' without. Processing ' + toProcess.length + '.');
            if (toProcess.length === 0) {
                onLog('[ATTEMPT ' + attempts + '] All already in history.');
                continue;
            }

            onLog('[AI] Generating cold emails for ' + toProcess.length + ' creators...');
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
                        salesAngle: a.salesAngle
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
                validLeads.push(lead);
                onLog('[SUCCESS] ' + validLeads.length + '/' + targetCount + ': @' + lead.ig_handle +
                    ' (' + this.formatFollowers(lead.follower_count || 0) + ', ' + lead.niche + ')' +
                    (lead.decisionMaker?.email ? ' [email]' : ''));
                if (validLeads.length >= targetCount) break;
            }
        }

        onLog('[IG] Complete: ' + validLeads.length + '/' + targetCount + ' creators found');
        onComplete(validLeads);
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
