import { enrichLeadWithEmail } from '../../lib/emailScraper';
import type { LogCallback } from './SearchService';

// ── Linktree URL patterns ─────────────────────────────────────────────────────
const LINKTREE_HOSTS = ['linktr.ee', 'linktree.me'];

// ── EmailDiscoveryService ─────────────────────────────────────────────────────

/**
 * 3-stage email discovery pipeline for Instagram creator profiles.
 *
 * Stage 1: Apify native fields (already extracted in SearchService before this runs)
 * Stage 2: Website / Linktree scraping
 * Stage 3: Instagram source HTML via server-side /api/ig-email proxy
 *
 * Called AFTER the ICP soft filter, so only verified/candidate leads are enriched.
 */
export class EmailDiscoveryService {

  /**
   * Stage 2 — scrape the creator's linked website or Linktree page.
   * Linktree pages expose all linked URLs in their HTML; we extract those and
   * check each one for an email before falling back to the homepage itself.
   */
  async findViaWebsite(website: string, handle: string, onLog: LogCallback): Promise<string> {
    if (!website) return '';

    const url = website.startsWith('http') ? website : `https://${website}`;

    try {
      const host = new URL(url).hostname.toLowerCase();

      if (LINKTREE_HOSTS.some(h => host.includes(h))) {
        // Linktree: extract all href links from the page, check each for email
        const html = await this.fetchWithTimeout(url, 8000);
        if (!html) return '';

        // Extract email directly from Linktree page text
        const directEmail = this.regexEmail(html);
        if (directEmail) {
          onLog(`[EMAIL] @${handle} → found on Linktree page`);
          return directEmail;
        }

        // Extract linked URLs from Linktree and scrape each
        const linkedUrls = this.extractLinktreeUrls(html);
        for (const linkedUrl of linkedUrls.slice(0, 4)) {
          try {
            const linkedEmail = await enrichLeadWithEmail(linkedUrl);
            if (linkedEmail) {
              onLog(`[EMAIL] @${handle} → found on Linktree-linked site: ${linkedUrl}`);
              return linkedEmail;
            }
          } catch { /* skip failed linked page */ }
        }
        return '';
      }

      // Regular website: use existing emailScraper
      const found = await enrichLeadWithEmail(url);
      if (found) {
        onLog(`[EMAIL] @${handle} → found on website ${url}`);
        return found;
      }
    } catch (e) {
      // Graceful fail — DNS error, timeout, etc.
    }

    return '';
  }

  /**
   * Stage 3 — fetch the Instagram profile page server-side to extract the
   * "public_email" field that Instagram embeds in the page JSON for business accounts.
   * Proxied through /api/ig-email to avoid CORS and Instagram bot detection.
   */
  async findViaInstagramSource(handle: string, onLog: LogCallback): Promise<string> {
    try {
      const response = await fetch('/api/ig-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: handle })
      });

      if (!response.ok) return '';

      const data = await response.json();
      const email = (data.email || '').toLowerCase().trim();

      if (email) {
        onLog(`[EMAIL] @${handle} → found in Instagram source HTML`);
        return email;
      }
    } catch { /* graceful fail */ }

    return '';
  }

  /**
   * Full 3-stage discovery orchestrator.
   * Stage 1 (Apify native fields) is already resolved in SearchService before
   * this is called — the pre-extracted `existingEmail` is passed in.
   *
   * @param existingEmail  Email already found via bio/Apify fields (may be empty)
   * @param website        External URL from Apify profile (may be empty)
   * @param handle         Instagram handle
   * @param onLog          Terminal log callback
   */
  async discoverEmail(
    existingEmail: string,
    website: string,
    handle: string,
    onLog: LogCallback
  ): Promise<string> {
    // Stage 1 result already in hand
    if (existingEmail) {
      onLog(`[EMAIL] @${handle} → found in bio/Apify fields`);
      return existingEmail;
    }

    // Stage 2: website / Linktree
    if (website) {
      const websiteEmail = await this.findViaWebsite(website, handle, onLog);
      if (websiteEmail) return websiteEmail;
    }

    // Stage 3: Instagram source HTML (server-side)
    const igEmail = await this.findViaInstagramSource(handle, onLog);
    if (igEmail) return igEmail;

    onLog(`[EMAIL] @${handle} → no email found across all 3 stages`);
    return '';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async fetchWithTimeout(url: string, timeout = 8000): Promise<string | null> {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
        }
      });
      clearTimeout(id);
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  private regexEmail(text: string): string {
    const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (!match) return '';
    const email = match[0].toLowerCase();
    // Filter obvious false positives
    if (email.includes('example.com') || email.includes('wix.com') || email.includes('sentry.io')) return '';
    return email;
  }

  private extractLinktreeUrls(html: string): string[] {
    // Linktree embeds links in <a href="..."> with external URLs
    const matches = html.matchAll(/href="(https?:\/\/(?!linktr\.ee)[^"]+)"/g);
    const urls: string[] = [];
    for (const m of matches) {
      const url = m[1];
      if (!url.includes('instagram.com') && !url.includes('facebook.com') && !url.includes('twitter.com')) {
        urls.push(url);
      }
    }
    return [...new Set(urls)];
  }
}

export const emailDiscoveryService = new EmailDiscoveryService();
