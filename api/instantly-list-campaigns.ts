/**
 * api/instantly-list-campaigns.ts
 *
 * Vercel Serverless Function — GET only.
 * Lists all Instantly campaigns so you can verify which Campaign ID to use.
 * Useful to confirm INSTANTLY_CAMPAIGN_ID env var points to the right campaign.
 *
 * Usage: GET /api/instantly-list-campaigns
 * Returns: [{ id, name, status, leads_count }]
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const instantlyKey = process.env.INSTANTLY_API_KEY;
  const configuredCampaignId = process.env.INSTANTLY_CAMPAIGN_ID;

  if (!instantlyKey) {
    return res.status(500).json({ error: 'Missing INSTANTLY_API_KEY' });
  }

  try {
    const response = await fetch('https://api.instantly.ai/api/v2/campaigns?limit=50', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${instantlyKey}`,
        'Content-Type': 'application/json',
      },
    });

    const responseText = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { raw: responseText };
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Instantly API error', details: data });
    }

    const campaigns = Array.isArray((data as any)?.items)
      ? (data as any).items
      : Array.isArray(data)
      ? data
      : [];

    const result = campaigns.map((c: any) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      leads_count: c.leads_count ?? c.total_leads ?? null,
      is_configured: c.id === configuredCampaignId,
    }));

    return res.status(200).json({
      configured_campaign_id: configuredCampaignId,
      total: result.length,
      campaigns: result,
    });
  } catch (e: any) {
    console.error('[instantly-list-campaigns] Error:', e.message);
    return res.status(500).json({ error: 'Internal error', message: e.message });
  }
}
