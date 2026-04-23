import { Lead } from '../../lib/types';
import { supabase } from '../../lib/supabase';

export class DeduplicationService {
    private normalizeHandle(handle: string): string {
        return handle.toLowerCase().replace(/^@/, '').trim();
    }

    async fetchExistingLeads(userId: string | null): Promise<{
        existingIgHandles: Set<string>;
        existingEmails: Set<string>;
        totalCount: number;
    }> {
        const existingIgHandles = new Set<string>();
        const existingEmails = new Set<string>();

        if (!userId) {
            console.warn('[DEDUP] No userId provided. Skipping duplicate check.');
            return { existingIgHandles, existingEmails, totalCount: 0 };
        }

        try {
            const { data, error } = await supabase
                .from('leads')
                .select('ig_handle, email')
                .eq('user_id', userId);

            if (error) {
                console.error('[DEDUP] Error fetching existing leads:', error);
                return { existingIgHandles, existingEmails, totalCount: 0 };
            }

            if (!data || data.length === 0) {
                return { existingIgHandles, existingEmails, totalCount: 0 };
            }

            for (const row of data) {
                if (row.ig_handle) existingIgHandles.add(this.normalizeHandle(row.ig_handle));
                if (row.email) existingEmails.add(row.email.toLowerCase().trim());
            }

            const totalCount = existingIgHandles.size + existingEmails.size;
            console.log('[DEDUP] Pre-Flight: ' + existingIgHandles.size + ' IG handles, ' + existingEmails.size + ' emails');
            return { existingIgHandles, existingEmails, totalCount };
        } catch (error) {
            console.error('[DEDUP] Unexpected error in fetchExistingLeads:', error);
            return { existingIgHandles, existingEmails, totalCount: 0 };
        }
    }

    filterUniqueCandidates(
        candidates: Lead[],
        existingIgHandles: Set<string>,
        existingEmails: Set<string> = new Set()
    ): Lead[] {
        const uniqueCandidates: Lead[] = [];
        const sessionHandles = new Set<string>();
        const sessionEmails = new Set<string>();

        for (const candidate of candidates) {
            let isDuplicate = false;

            if (candidate.ig_handle) {
                const handle = this.normalizeHandle(candidate.ig_handle);
                if (existingIgHandles.has(handle) || sessionHandles.has(handle)) {
                    isDuplicate = true;
                } else {
                    sessionHandles.add(handle);
                }
            }

            if (!isDuplicate && candidate.decisionMaker?.email) {
                const email = candidate.decisionMaker.email.toLowerCase().trim();
                if (existingEmails.has(email) || sessionEmails.has(email)) {
                    isDuplicate = true;
                } else {
                    sessionEmails.add(email);
                }
            }

            if (!isDuplicate) uniqueCandidates.push(candidate);
        }

        console.log('[DEDUP] ' + uniqueCandidates.length + '/' + candidates.length + ' unique (' + (candidates.length - uniqueCandidates.length) + ' rejected)');
        return uniqueCandidates;
    }

    async saveUniqueLeads(leads: Lead[], userId: string | null, sessionId: string): Promise<boolean> {
        if (!userId || leads.length === 0) {
            console.warn('[DEDUP] No leads to save or missing userId');
            return false;
        }

        try {
            const leadsToInsert = leads.map(lead => ({
                user_id: userId,
                search_id: sessionId,
                name: lead.decisionMaker?.name || ('@' + lead.ig_handle) || '',
                ig_handle: lead.ig_handle || '',
                follower_count: lead.follower_count || 0,
                niche: lead.niche || '',
                audience_tier: lead.audience_tier || 'nano',
                job_title: lead.decisionMaker?.role || 'Content Creator',
                email: lead.decisionMaker?.email || '',
                location: lead.location || '',
                ai_summary: lead.aiAnalysis?.summary || '',
                ai_pain_points: lead.aiAnalysis?.painPoints || [],
                cold_email_subject: lead.aiAnalysis?.coldEmailSubject || '',
                cold_email_body: lead.aiAnalysis?.coldEmailBody || '',
                vsl_pitch: lead.aiAnalysis?.vslPitch || '',
                vsl_sent_status: lead.vsl_sent_status || 'pending',
                email_status: lead.email_status || 'pending',
                status: lead.status || 'scraped'
            }));

            const { error } = await supabase.from('leads').insert(leadsToInsert);

            if (error) {
                console.error('[DEDUP] Error saving leads:', error);
                return false;
            }

            console.log('[DEDUP] Saved: ' + leads.length + ' leads');
            return true;
        } catch (error) {
            console.error('[DEDUP] Unexpected error in saveUniqueLeads:', error);
            return false;
        }
    }
}

export const deduplicationService = new DeduplicationService();
