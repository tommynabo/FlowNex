import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * API Route: /api/apify
 *
 * Server-side proxy for all Apify API calls.
 * The Apify token is read from env vars and NEVER sent to the browser.
 *
 * Request body:
 *   { path: string, method?: 'GET' | 'POST', body?: unknown }
 *
 * `path` is the Apify endpoint path WITHOUT the base URL, e.g.:
 *   "acts/apify~instagram-hashtag-scraper/runs"
 *   "acts/apify~instagram-hashtag-scraper/runs/abc123"
 *   "datasets/abc123/items"
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.VITE_APIFY_API_TOKEN || process.env.APIFY_API_TOKEN;
  if (!token) {
    console.error('[api/apify] VITE_APIFY_API_TOKEN not configured');
    return res.status(500).json({ error: 'Apify token not configured on server' });
  }

  const { path, method = 'GET', body: apifyBody } = req.body || {};

  if (!path || typeof path !== 'string') {
    return res.status(400).json({ error: '`path` field required' });
  }

  // Build Apify URL — use & if path already contains query params (e.g. ?memory=1024)
  const separator = path.includes('?') ? '&' : '?';
  const apifyUrl = `https://api.apify.com/v2/${path}${separator}token=${token}`;

  console.log(`[api/apify] ${method} ${path}`);

  try {
    const fetchOptions: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (method === 'POST' && apifyBody !== undefined) {
      fetchOptions.body = JSON.stringify(apifyBody);
    }

    const apifyRes = await fetch(apifyUrl, fetchOptions);
    const responseText = await apifyRes.text();

    if (!apifyRes.ok) {
      console.error(`[api/apify] Apify error ${apifyRes.status}:`, responseText.substring(0, 300));
      return res.status(apifyRes.status).json({
        error: `Apify error ${apifyRes.status}`,
        details: responseText.substring(0, 300),
      });
    }

    // Parse JSON if possible, otherwise return raw text
    try {
      const json = JSON.parse(responseText);
      return res.status(200).json(json);
    } catch {
      return res.status(200).send(responseText);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/apify] Unexpected error:', msg);
    return res.status(500).json({ error: 'Proxy error: ' + msg });
  }
}
