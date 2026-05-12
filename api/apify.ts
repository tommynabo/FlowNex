import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ApifyClient } from 'apify-client';

/**
 * API Route: /api/apify
 *
 * Server-side proxy for all Apify API calls using the official apify-client SDK.
 * The Apify token is read from env vars and NEVER sent to the browser.
 *
 * Request body:
 *   { path: string, method?: 'GET' | 'POST', body?: unknown }
 *
 * Supported path patterns (same interface as before, now backed by SDK):
 *   POST  acts/{actorId}/runs[?timeout=N&memory=N]  → start run
 *   GET   acts/{actorId}/runs/{runId}               → get run status
 *   GET   datasets/{datasetId}/items[?limit=N]      → list dataset items
 *   POST  actor-runs/{runId}/abort                  → abort run
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

  console.log(`[api/apify] ${method} ${path}`);

  const client = new ApifyClient({ token });

  try {
    // ── POST acts/{actorId}/runs[?timeout=N&memory=N] → start run ────────────
    const startMatch = path.match(/^acts\/([^/?]+)\/runs(\?(.*))?$/);
    if (startMatch && method === 'POST') {
      const actorId = startMatch[1];
      const qs = new URLSearchParams(startMatch[3] ?? '');
      const timeout = qs.has('timeout') ? parseInt(qs.get('timeout')!) : undefined;
      const memory  = qs.has('memory')  ? parseInt(qs.get('memory')!)  : undefined;

      const runInfo = await client.actor(actorId).start(apifyBody ?? {}, { timeout, memory });
      // Wrap in { data: ... } to match the REST API shape the engines expect
      return res.status(201).json({ data: runInfo });
    }

    // ── GET acts/{actorId}/runs/{runId} → poll run status ────────────────────
    const statusMatch = path.match(/^acts\/[^/]+\/runs\/([^/?]+)/);
    if (statusMatch && method === 'GET') {
      const runInfo = await client.run(statusMatch[1]).get();
      return res.status(200).json({ data: runInfo });
    }

    // ── GET datasets/{datasetId}/items[?limit=N] → fetch results ─────────────
    const datasetMatch = path.match(/^datasets\/([^/?]+)\/items(\?(.*))?$/);
    if (datasetMatch && method === 'GET') {
      const qs    = new URLSearchParams(datasetMatch[3] ?? '');
      const limit = qs.has('limit') ? parseInt(qs.get('limit')!) : undefined;
      const result = await client.dataset(datasetMatch[1]).listItems({ limit });
      // Return the items array directly — engines expect Array.isArray(response)
      return res.status(200).json(result.items);
    }

    // ── POST actor-runs/{runId}/abort → abort run ─────────────────────────────
    const abortMatch = path.match(/^actor-runs\/([^/]+)\/abort$/);
    if (abortMatch && method === 'POST') {
      const runInfo = await client.run(abortMatch[1]).abort();
      return res.status(200).json({ data: runInfo });
    }

    // ── Fallback: raw fetch for any unrecognised path ─────────────────────────
    const separator = path.includes('?') ? '&' : '?';
    const apifyUrl  = `https://api.apify.com/v2/${path}${separator}token=${token}`;
    const fetchOpts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
    if (method === 'POST' && apifyBody !== undefined) fetchOpts.body = JSON.stringify(apifyBody);

    const apifyRes   = await fetch(apifyUrl, fetchOpts);
    const rawText    = await apifyRes.text();
    if (!apifyRes.ok) {
      console.error(`[api/apify] Apify error ${apifyRes.status}:`, rawText.substring(0, 300));
      return res.status(apifyRes.status).json({ error: `Apify error ${apifyRes.status}`, details: rawText.substring(0, 300) });
    }
    try   { return res.status(200).json(JSON.parse(rawText)); }
    catch { return res.status(200).send(rawText); }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/apify] Error:', msg);
    // Surface the error with enough context for the client to parse quota errors
    return res.status(500).json({ error: msg, details: msg });
  }
}
