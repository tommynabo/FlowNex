/**
 * isStrictlyValidEmail
 *
 * Single source of truth for email validation across the entire pipeline.
 * Rejects template/placeholder emails before they can reach the DB or Instantly.
 *
 * Called from:
 *   - lib/emailScraper.ts         (website scraping phase)
 *   - services/search/EmailDiscoveryService.ts  (all 3 discovery stages)
 */
export function isStrictlyValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;

  const lower = email.toLowerCase().trim();

  // ── 1. Basic format check ────────────────────────────────────────────────
  const FORMAT_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!FORMAT_REGEX.test(lower)) return false;

  const atIndex = lower.indexOf('@');
  const local = lower.substring(0, atIndex);
  const domain = lower.substring(atIndex + 1);

  // ── 2. Explicit template combos (belt-and-suspenders) ───────────────────
  if (lower === 'user@domain.com') return false;
  if (lower === 'user@website.com') return false;

  // ── 3. Forbidden domains ─────────────────────────────────────────────────
  const forbiddenDomains = [
    'domain.com',
    'website.com',
    'example.com',
    'yoursite.com',
    'mysite.com',
    'email.com',
    'mywebsite.com',
    'test.com',
    // kept from previous list
    'wix.com',
    'sentry.io',
  ];
  if (forbiddenDomains.some(d => domain === d || domain.endsWith(`.${d}`))) return false;

  // ── 4. Forbidden local parts ─────────────────────────────────────────────
  const forbiddenLocalParts = [
    'user',
    'example',
    'test',
    'yourname',
    'email',
    'name',
    'insertname',
    'firstname',
    'lastname',
    'admin',
  ];
  if (forbiddenLocalParts.includes(local)) return false;

  return true;
}
