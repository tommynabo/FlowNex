/**
 * api/instantly-analytics.ts
 * Vercel Serverless Function — GET only.
 * Proxies Instantly's analytics overview endpoint so the API key stays server-side.
 *
 * GET /api/instantly-analytics            → aggregate across ALL campaigns
 * GET /api/instantly-analytics?ids=<uuid> → scope to specific campaign(s)
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const instantlyKey = process.env.INSTANTLY_API_KEY;
  if (!instantlyKey) {
    return res.status(500).json({ error: 'Missing INSTANTLY_API_KEY env var' });
  }

  // Forward optional campaign-ID filter from the client (?ids=uuid&ids=uuid2)
  const params = new URLSearchParams();
  const rawIds = req.query.ids;
  if (rawIds) {
    (Array.isArray(rawIds) ? rawIds : [rawIds]).forEach(id => params.append('ids', id));
  }

  const qs = params.toString();
  const url = `https://api.instantly.ai/api/v2/campaigns/analytics/overview${qs ? '?' + qs : ''}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${instantlyKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: 'Instantly API error',
        status: response.status,
        details: text.substring(0, 300),
      });
    }

    const data = await response.json() as {
      emails_sent_count?:   number;
      contacted_count?:     number;
      reply_count_unique?:  number;
    };

    return res.status(200).json({
      emailsSent:      data.emails_sent_count  ?? 0,
      sequenceStarted: data.contacted_count    ?? 0,
      replied:         data.reply_count_unique ?? 0,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[instantly-analytics] Error:', msg);
    return res.status(500).json({ error: 'Internal error', message: msg });
  }
}
