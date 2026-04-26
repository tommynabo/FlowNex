/**
 * api/instantly-add-lead.ts
 *
 * Vercel Serverless Function — POST only.
 * Adds a single lead to the configured Instantly campaign.
 * Called automatically from SearchService after each completed search.
 *
 * Required env vars (server-side only):
 *   INSTANTLY_API_KEY       — Instantly.ai API key
 *   INSTANTLY_CAMPAIGN_ID   — UUID of the target Instantly campaign
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

interface AddLeadRequest {
  email: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  igHandle?: string;
  niche?: string;
  aiSummary?: string;
  coldEmailSubject?: string;
  followerCount?: number;
  campaignId?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── 1. Check env vars ────────────────────────────────────────────────────
  const instantlyKey = process.env.INSTANTLY_API_KEY;
  const campaignId = process.env.INSTANTLY_CAMPAIGN_ID;

  if (!instantlyKey || !campaignId) {
    console.error('[INSTANTLY] Missing INSTANTLY_API_KEY or INSTANTLY_CAMPAIGN_ID');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // ── 2. Validate request body ─────────────────────────────────────────────
  const body = req.body as Partial<AddLeadRequest>;

  if (!body.email || typeof body.email !== 'string' || !body.email.includes('@')) {
    return res.status(400).json({ error: 'Missing or invalid email' });
  }

  // ── 3. Parse name fields ─────────────────────────────────────────────────
  const fullName = ((body.firstName || '') + ' ' + (body.lastName || '')).trim();
  const nameParts = fullName.split(' ');
  const firstName = body.firstName || nameParts[0] || '';
  const lastName = body.lastName || nameParts.slice(1).join(' ') || '';

  // ── 4. Build Instantly v2 payload ────────────────────────────────────────
  const resolvedCampaignId = (body.campaignId && body.campaignId.trim()) ? body.campaignId.trim() : campaignId;

  const payload: Record<string, unknown> = {
    campaign_id: resolvedCampaignId,
    email: body.email.toLowerCase().trim(),
    first_name: firstName,
    last_name: lastName,
    company_name: body.companyName || '',
  };

  // Only include custom_variables if at least one has a value,
  // since undefined variables in Instantly silently drop the entire lead.
  const customVars: Record<string, string> = {};
  if (body.igHandle) customVars['ig_handle'] = body.igHandle;
  if (body.niche) customVars['niche'] = body.niche;
  if (body.aiSummary) customVars['ai_summary'] = body.aiSummary;
  if (body.coldEmailSubject) customVars['cold_email_subject'] = body.coldEmailSubject;
  if (body.followerCount) customVars['follower_count'] = String(body.followerCount);
  if (Object.keys(customVars).length > 0) {
    payload['custom_variables'] = customVars;
  }

  // ── 5. Call Instantly API ─────────────────────────────────────────────────
  try {
    const response = await fetch('https://api.instantly.ai/api/v2/leads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${instantlyKey}`,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    if (!response.ok) {
      console.error('[INSTANTLY] Add lead failed:', response.status, responseText.substring(0, 500));
      return res.status(response.status).json({
        error: 'Instantly API error',
        status: response.status,
        details: responseData,
      });
    }

    console.log('[INSTANTLY] Lead added:', body.email, '| campaign:', resolvedCampaignId, '| res:', JSON.stringify(responseData).substring(0, 200));
    return res.status(200).json({ success: true, email: body.email, data: responseData });
  } catch (e: any) {
    console.error('[INSTANTLY] Network error:', e.message);
    return res.status(500).json({ error: 'Network error: ' + e.message });
  }
}
