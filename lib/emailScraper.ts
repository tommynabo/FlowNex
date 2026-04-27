import * as cheerio from 'cheerio';

/**
 * Attempts to find a contact email for a given website URL.
 * It first checks the homepage for mailto: links or visible emails.
 * If not found, it looks for a "Contact" or "About" page and scrapes that.
 */
export async function enrichLeadWithEmail(websiteUrl: string): Promise<string | undefined> {
    if (!websiteUrl) return undefined;

    try {
        // Ensure URL has protocol
        const urlToCheck = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
        
        console.log(`[EMAIL_SCRAPER] Visiting ${urlToCheck}...`);
        
        // 1. Scrape Homepage
        const homeHtml = await fetchWithTimeout(urlToCheck);
        if (!homeHtml) return undefined;

        let email = extractEmailFromHtml(homeHtml);
        if (email) return email;

        // 2. If no email, check for Contact/About pages links
        const $ = cheerio.load(homeHtml);
        const contactLink = $('a[href*="contact"], a[href*="contacto"], a[href*="about"], a[href*="nosotros"]').first().attr('href');

        if (contactLink) {
            const contactUrl = new URL(contactLink, urlToCheck).toString();
            console.log(`[EMAIL_SCRAPER] Visiting Contact Page: ${contactUrl}...`);
            const contactHtml = await fetchWithTimeout(contactUrl);
            if (contactHtml) {
                email = extractEmailFromHtml(contactHtml);
                if (email) return email;
            }
        }

        return undefined;
    } catch (error) {
        console.warn(`[EMAIL_SCRAPER] Failed to scrape ${websiteUrl}:`, error);
        return undefined;
    }
}

/**
 * Returns true if the email looks like a real contact address.
 * Rejects placeholder local parts and known fake/placeholder domains.
 */
function isRealEmail(email: string): boolean {
    const lower = email.toLowerCase();
    const [local, domain] = lower.split('@');
    if (!local || !domain) return false;

    // Block known placeholder local parts
    const fakeParts = ['user', 'example', 'yourname', 'email', 'test', 'name'];
    if (fakeParts.includes(local)) return false;

    // Block known placeholder / framework domains
    const fakeDomains = ['website.com', 'domain.com', 'example.com', 'wix.com'];
    if (fakeDomains.some(d => domain.includes(d))) return false;

    return true;
}

function extractEmailFromHtml(html: string): string | undefined {
    const $ = cheerio.load(html);
    
    // Strategy A: Look for mailto: links
    const mailto = $('a[href^="mailto:"]').first().attr('href');
    if (mailto) {
        const candidate = mailto.replace('mailto:', '').split('?')[0].trim();
        return isRealEmail(candidate) ? candidate : undefined;
    }

    // Strategy B: Regex search in text (careful with false positives)
    const emailRegex = /[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+/g;
    const matches = $.text().match(emailRegex);
    
    if (matches && matches.length > 0) {
        return matches.find(e => isRealEmail(e)) || undefined;
    }

    return undefined;
}

async function fetchWithTimeout(url: string, timeout = 5000): Promise<string | null> {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        
        const response = await fetch(url, { 
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        clearTimeout(id);
        
        if (!response.ok) return null;
        return await response.text();
    } catch (e) {
        return null; // Timeout or network error
    }
}
