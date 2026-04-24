import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * API Route: /api/ig-email
 * Server-side proxy to extract the public_email field from an Instagram profile page.
 * Must run server-side: browser fetches of instagram.com are blocked by CORS
 * and Instagram's bot detection. Vercel edge has a different IP pool.
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

  // Sanitise: strip @, spaces, special chars
  const cleanHandle = username.replace(/[^a-zA-Z0-9._]/g, '').slice(0, 30);
  if (!cleanHandle) return res.status(400).json({ error: 'invalid username' });

  try {
    const igUrl = `https://www.instagram.com/${cleanHandle}/`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(igUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[ig-email] HTTP ${response.status} for @${cleanHandle}`);
      return res.status(200).json({ email: null });
    }

    const html = await response.text();

    // Instagram embeds profile data in multiple locations; try all three patterns
    const patterns = [
      /"public_email"\s*:\s*"([^"]+)"/,
      /"business_email"\s*:\s*"([^"]+)"/,
      /"contact_email"\s*:\s*"([^"]+)"/,
      /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const email = match[1].toLowerCase().trim();
        // Basic sanity check
        if (email.includes('@') && email.includes('.') && !email.includes('example.com')) {
          console.log(`[ig-email] Found email for @${cleanHandle}`);
          return res.status(200).json({ email });
        }
      }
    }

    return res.status(200).json({ email: null });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ig-email] Error for @${cleanHandle}: ${msg}`);
    // Always return 200 with null — caller handles gracefully
    return res.status(200).json({ email: null });
  }
}
