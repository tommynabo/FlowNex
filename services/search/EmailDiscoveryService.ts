import type { LogCallback } from './SearchService';
import { isStrictlyValidEmail } from '../../lib/emailValidator';

// ── EmailDiscoveryService ─────────────────────────────────────────────────────

/**
 * 3-stage email discovery pipeline for Instagram creator profiles.
 *
 * Stage 1: Apify native fields (already extracted in SearchService before this runs)
 * Stage 2: Website / Linktree / bio-link scraping — ALL via server-side /api/scrape-email
 *          (bio-link pages like Linktree/Beacons are handled by scrape-email which follows links)
 * Stage 3: Instagram source HTML via server-side /api/ig-email proxy
 *
 * NOTE: All HTTP fetching goes through server-side API routes to avoid CORS.
 * Client-side direct fetches to external domains are blocked by CORS in browsers.
 */
export class EmailDiscoveryService {

  /**
   * Stage 2 — scrape the creator's linked website or bio-link page (Linktree, Beacons, etc.)
   * All fetching is server-side via /api/scrape-email which handles bio-link pages natively.
   */
  async findViaWebsite(website: string, handle: string, onLog: LogCallback): Promise<string> {
    if (!website) return '';
    const url = website.startsWith('http') ? website : `https://${website}`;
    try {
      const found = await this.scrapeEmailServerSide(url, onLog);
      if (found) {
        onLog(`[EMAIL] @${handle} → found on website/bio-link ${url}`);
        return found;
      }
    } catch {
      // Graceful fail
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
   * Stage 3 (TikTok variant) — fetch the TikTok profile page server-side to
   * extract any email address embedded in the page JSON.
   * Proxied through /api/tiktok-email to avoid CORS and bot detection.
   */
  async findViaTikTokSource(handle: string, onLog: LogCallback): Promise<string> {
    try {
      const response = await fetch('/api/tiktok-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: handle }),
      });

      if (!response.ok) return '';

      const data = await response.json();
      const email = (data.email || '').toLowerCase().trim();

      if (email) {
        onLog(`[EMAIL] @${handle} (TikTok) → found in TikTok source HTML`);
        return email;
      }
    } catch { /* graceful fail */ }

    return '';
  }

  /**
   * Full 3-stage email discovery for TikTok creators.
   * Mirrors discoverEmail() but uses findViaTikTokSource() for Stage 3
   * instead of the Instagram source HTML endpoint.
   */
  async discoverEmailForTikTok(
    existingEmail: string,
    website: string,
    handle: string,
    onLog: LogCallback,
  ): Promise<string> {
    // Stage 1 result already in hand
    if (existingEmail && isStrictlyValidEmail(existingEmail)) {
      onLog(`[EMAIL] @${handle} (TikTok) → found in bio/scraper fields`);
      return existingEmail;
    }

    // Stage 2 + Stage 3 run concurrently — both are independent network calls.
    // Running them in parallel halves the latency when Stage 2 finds nothing.
    const [websiteEmail, ttEmail] = await Promise.all([
      website ? this.findViaWebsite(website, handle, onLog) : Promise.resolve(''),
      this.findViaTikTokSource(handle, onLog),
    ]);
    const result = [websiteEmail, ttEmail].find(e => e && isStrictlyValidEmail(e)) ?? '';
    if (!result) onLog(`[EMAIL] @${handle} (TikTok) → no email found across all 3 stages`);
    return result;
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
    if (existingEmail && isStrictlyValidEmail(existingEmail)) {
      onLog(`[EMAIL] @${handle} → found in bio/Apify fields`);
      return existingEmail;
    }

    // Stage 2 + Stage 3 run concurrently — both are independent network calls.
    // Running them in parallel halves the latency when Stage 2 finds nothing.
    const [websiteEmail, igEmail] = await Promise.all([
      website ? this.findViaWebsite(website, handle, onLog) : Promise.resolve(''),
      this.findViaInstagramSource(handle, onLog),
    ]);
    const result = [websiteEmail, igEmail].find(e => e && isStrictlyValidEmail(e)) ?? '';
    if (!result) onLog(`[EMAIL] @${handle} → no email found across all 3 stages`);
    return result;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private regexEmail(text: string): string {
    const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (!match) return '';
    const email = match[0].toLowerCase();
    if (!isStrictlyValidEmail(email)) return '';
    return email;
  }

  /**
   * Server-side email scraper — proxied through /api/scrape-email to avoid CORS.
   * Handles bio-link pages (Linktree, Beacons, etc.) by following their embedded links.
   */
  private async scrapeEmailServerSide(url: string, _onLog: LogCallback): Promise<string> {
    try {
      const response = await fetch('/api/scrape-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      if (!response.ok) return '';
      const data = await response.json();
      return (data.email || '').toLowerCase().trim();
    } catch {
      return '';
    }
  }
}

export const emailDiscoveryService = new EmailDiscoveryService();
