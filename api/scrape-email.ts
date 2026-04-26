import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * API Route: /api/scrape-email
 * Server-side proxy to extract a contact email from any public website URL.
 * Must run server-side: browser fetch of external sites is blocked by CORS.
 *
 * Returns: { email: string | null }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url required' });
  }

  // Validate URL scheme
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'url must be http or https' });
  }

  // Block private/local addresses (SSRF protection)
  const hostname = parsedUrl.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('172.16.') ||
    hostname.startsWith('172.17.') ||
    hostname.startsWith('172.18.') ||
    hostname.startsWith('172.19.') ||
    hostname.startsWith('172.20.') ||
    hostname.startsWith('172.21.') ||
    hostname.startsWith('172.22.') ||
    hostname.startsWith('172.23.') ||
    hostname.startsWith('172.24.') ||
    hostname.startsWith('172.25.') ||
    hostname.startsWith('172.26.') ||
    hostname.startsWith('172.27.') ||
    hostname.startsWith('172.28.') ||
    hostname.startsWith('172.29.') ||
    hostname.startsWith('172.30.') ||
    hostname.startsWith('172.31.') ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname === '169.254.169.254' // AWS metadata
  ) {
    return res.status(400).json({ error: 'private urls not allowed' });
  }

  try {
    // ── Bio-link pages (Linktree, Beacons, etc.) ──────────────────────────────
    // These pages aggregate external links; we must follow each link to find email.
    if (isBioLinkPage(parsedUrl.hostname)) {
      const html = await fetchRaw(url);
      if (html) {
        const directEmail = extractEmail(html);
        if (directEmail) return res.status(200).json({ email: directEmail });

        const linkedUrls = extractBioLinkUrls(html, parsedUrl.hostname);
        for (const linkedUrl of linkedUrls.slice(0, 6)) {
          const linkedEmail = await fetchAndExtract(linkedUrl);
          if (linkedEmail) return res.status(200).json({ email: linkedEmail });
        }
      }
      return res.status(200).json({ email: null });
    }

    // ── Regular websites ──────────────────────────────────────────────────────
    const homepageEmail = await fetchAndExtract(url);
    if (homepageEmail) {
      return res.status(200).json({ email: homepageEmail });
    }

    // Try contact/about page (same origin only)
    const contactEmail = await tryContactPage(url, parsedUrl.hostname);
    return res.status(200).json({ email: contactEmail ?? null });

  } catch (err) {
    console.warn('[scrape-email] Failed for', url, err);
    return res.status(200).json({ email: null });
  }
}

// ── Bio-link page detection & link extraction ─────────────────────────────────

const BIO_LINK_HOSTS = [
  'linktr.ee', 'linktree.me',
  'beacons.ai',
  'bio.site',
  'allmylinks.com',
  'tap.bio',
  'campsite.bio',
  'carrd.co',
  'solo.to',
  'about.me',
  'contactcard.me',
];

function isBioLinkPage(hostname: string): boolean {
  return BIO_LINK_HOSTS.some(h => hostname.includes(h));
}

const SOCIAL_SKIP_DOMAINS = [
  'instagram.com', 'facebook.com', 'twitter.com', 'x.com',
  'tiktok.com', 'youtube.com', 'linkedin.com', 'pinterest.com',
  'snapchat.com', 'threads.net', 'spotify.com', 'apple.com',
];

function extractBioLinkUrls(html: string, currentHost: string): string[] {
  const matches = html.matchAll(/href="(https?:\/\/[^"#?]+)"/g);
  const urls: string[] = [];
  for (const m of matches) {
    const u = m[1];
    try {
      const h = new URL(u).hostname.toLowerCase();
      if (h === currentHost) continue;
      if (SOCIAL_SKIP_DOMAINS.some(d => h.includes(d))) continue;
      if (isBioLinkPage(h)) continue; // skip nested bio-link pages
      urls.push(u);
    } catch { /* invalid URL */ }
  }
  return [...new Set(urls)];
}

async function fetchAndExtract(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const html = await response.text();
    return extractEmail(html);
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

async function tryContactPage(baseUrl: string, hostname: string): Promise<string | null> {
  try {
    const html = await fetchRaw(baseUrl);
    if (!html) return null;

    // Find first contact/about link
    const contactMatch = html.match(/href="([^"]*(?:contact|about|contacto|nosotros|reach)[^"]*)"/i);
    if (!contactMatch) return null;

    const contactHref = contactMatch[1];
    let contactUrl: string;
    try {
      contactUrl = new URL(contactHref, baseUrl).toString();
    } catch {
      return null;
    }

    // Stay on same origin for security
    if (new URL(contactUrl).hostname !== hostname) return null;

    return await fetchAndExtract(contactUrl);
  } catch {
    return null;
  }
}

async function fetchRaw(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

const FALSE_POSITIVE_DOMAINS = [
  'example.com', 'wix.com', 'sentry.io', 'w3.org', 'schema.org',
  'googleapis.com', 'cloudflare.com', 'facebook.com', 'instagram.com',
];

function extractEmail(html: string): string | null {
  // Strategy A: mailto: links (most reliable)
  const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
  if (mailtoMatch) {
    const email = mailtoMatch[1].toLowerCase().trim();
    if (!FALSE_POSITIVE_DOMAINS.some(d => email.includes(d))) return email;
  }

  // Strategy B: regex on HTML text
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = html.match(emailRegex);
  if (matches) {
    const valid = matches.find(e => !FALSE_POSITIVE_DOMAINS.some(d => e.includes(d)));
    if (valid) return valid.toLowerCase().trim();
  }

  return null;
}
