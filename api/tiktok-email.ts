import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * API Route: /api/tiktok-email
 * Server-side proxy that attempts to extract a public email address from a TikTok
 * profile page. Must run server-side: browser fetches are blocked by CORS and
 * TikTok's bot detection. Mirrors the pattern of /api/ig-email.
 *
 * TikTok embeds user data inside a <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
 * JSON block. Business accounts occasionally expose an email field there.
 *
 * Returns: { email: string | null }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'username required' });
  }

  // Sanitise: strip leading @, allow alphanumeric / dots / underscores only
  const cleanHandle = username.replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '').slice(0, 30);
  if (!cleanHandle) return res.status(400).json({ error: 'invalid username' });

  try {
    const ttUrl = `https://www.tiktok.com/@${cleanHandle}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(ttUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[tiktok-email] HTTP ${response.status} for @${cleanHandle}`);
      return res.status(200).json({ email: null });
    }

    const html = await response.text();

    // Search for email patterns in the embedded JSON blobs and mailto links.
    // Exclude TikTok's own domain addresses (support@tiktok.com, etc.)
    const patterns = [
      /"email"\s*:\s*"([^"]+)"/,
      /"contactEmail"\s*:\s*"([^"]+)"/,
      /"publicEmail"\s*:\s*"([^"]+)"/,
      /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const email = match[1].toLowerCase().trim();
        // Basic sanity checks: valid format, not TikTok's own domain, not placeholder
        if (
          email.includes('@') &&
          email.includes('.') &&
          !email.includes('tiktok.com') &&
          !email.includes('example.com') &&
          email.length < 100
        ) {
          console.log(`[tiktok-email] Found email for @${cleanHandle}`);
          return res.status(200).json({ email });
        }
      }
    }

    return res.status(200).json({ email: null });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tiktok-email] Error for @${cleanHandle}: ${msg}`);
    // Always return 200 with null — caller handles gracefully
    return res.status(200).json({ email: null });
  }
}
