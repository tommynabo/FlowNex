// Serverless proxy for Serper Google Search API.
// Used by TikTokFacelessEngine (client-side) to avoid exposing the API key in the browser.
// Returns results in the same format as scraperlink~google-search-results-serp-scraper
// so the existing parser in TikTokFacelessEngine works with no changes.

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { keyword, num = 40 } = (req.body ?? {}) as { keyword?: string; num?: number };
  if (!keyword) {
    return res.status(400).json({ error: 'keyword is required' });
  }

  // Support both the correct spelling and the historical typo in .env
  const apiKey = process.env.SERPER_API_KEY ?? process.env.SERPET_API_KEY ?? '';
  if (!apiKey) {
    return res.status(500).json({ error: 'SERPER_API_KEY env var is not set' });
  }

  let serperData: { organic?: Array<{ link?: string; snippet?: string; title?: string }> };
  try {
    const resp = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ q: keyword, num }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `Serper error ${resp.status}: ${errText}` });
    }
    serperData = await resp.json() as typeof serperData;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(502).json({ error: `Serper fetch failed: ${msg}` });
  }

  // Mirror the output format of scraperlink~google-search-results-serp-scraper:
  // [{ results: [{ url, link, description, snippet, title }] }]
  // TikTokFacelessEngine reads: item.results[].url / item.results[].description
  return res.json([{
    results: (serperData.organic ?? []).map(o => ({
      url:         o.link        ?? '',
      link:        o.link        ?? '',
      description: o.snippet     ?? '',
      snippet:     o.snippet     ?? '',
      title:       o.title       ?? '',
    })),
  }]);
}
