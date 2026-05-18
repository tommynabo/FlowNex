/**
 * api/instantly-sequence.ts
 * Vercel Serverless Function — GET only.
 * Fetches the FlowNextOmega campaign from Instantly and returns its
 * sequence steps (subject, body preview, delay, variant count).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

const CAMPAIGN_ID = 'f021448d-70d0-413a-82aa-932b54d326df';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const key = process.env.INSTANTLY_API_KEY;
  if (!key) return res.status(500).json({ error: 'Missing INSTANTLY_API_KEY' });

  try {
    const resp = await fetch(
      `https://api.instantly.ai/api/v2/campaigns/${CAMPAIGN_ID}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({
        error: 'Instantly API error',
        details: text.substring(0, 300),
      });
    }

    const data = await resp.json() as {
      sequences?: Array<{
        steps: Array<{
          delay?:      number;
          delay_unit?: string;
          variants?:   Array<{ subject?: string; body?: string }>;
        }>;
      }>;
    };

    const steps = data.sequences?.[0]?.steps ?? [];

    return res.status(200).json({
      steps: steps.map((s, i) => ({
        number:       i + 1,
        subject:      s.variants?.[0]?.subject ?? '',
        body:         s.variants?.[0]?.body    ?? '',
        delay:        s.delay      ?? 0,
        delayUnit:    s.delay_unit ?? 'days',
        variantCount: s.variants?.length ?? 1,
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[instantly-sequence] Error:', msg);
    return res.status(500).json({ error: 'Internal error', message: msg });
  }
}
