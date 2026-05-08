/**
 * Vercel Cron Job: /api/cron/autopilot-engine
 * Schedule: every hour at :00 (see vercel.json → "0 * * * *")
 *
 * For each campaign with autopilot_enabled = true AND status = 'active':
 *   1. Checks if current UTC hour falls inside the campaign's [startHour, endHour] window
 *   2. Resets the daily leads counter if autopilot_reset_date < today
 *   3. Skips if daily limit already reached
 *   4. Runs CronSearchOrchestrator.runAutopilotBatch()
 *   5. Updates autopilot_leads_today, autopilot_last_run_at in campaigns
 *   6. Inserts a row in autopilot_runs for audit
 *
 * Auth:
 *   - Vercel cron calls automatically include x-vercel-cron: 1 header
 *   - Manual / external calls must include: Authorization: Bearer <CRON_SECRET>
 *
 * Required env vars:
 *   SUPABASE_URL or VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_KEY            ← service role key (bypasses RLS)
 *   APIFY_TOKEN
 *   INSTANTLY_API_KEY
 *   CRON_SECRET                     ← arbitrary secret for manual test calls
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient }                       from '@supabase/supabase-js';
// CronSearchOrchestrator is loaded dynamically inside the handler to catch
// any module-resolution errors and surface them as JSON instead of FUNCTION_INVOCATION_FAILED
import type { CampaignRow }                   from '../../services/autopilot/CronSearchOrchestrator';

// ── Supabase (service role — bypasses RLS for cron writes) ───────────────────

function getSupabase() {
  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '';
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  return createClient(url, key);
}

// ── Hourly window check ───────────────────────────────────────────────────────

/**
 * Returns the current hour (0–23) in a given IANA timezone.
 * Falls back to UTC if the timezone string is invalid.
 */
function getCurrentHourInTz(timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
    return h % 24;
  } catch {
    return new Date().getUTCHours();
  }
}

/**
 * Returns true if currentHour is inside [startHour, endHour].
 * Supports windows that cross midnight, e.g. startHour=22, endHour=6.
 */
function isInsideWindow(currentHour: number, startHour: number, endHour: number): boolean {
  if (startHour <= endHour) {
    // Same-day window, e.g. 09:00–18:00
    return currentHour >= startHour && currentHour < endHour;
  }
  // Cross-midnight window, e.g. 22:00–06:00
  return currentHour >= startHour || currentHour < endHour;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Top-level try-catch: surfaces any crash as JSON instead of FUNCTION_INVOCATION_FAILED
  try {
    return await _handler(req, res);
  } catch (fatal) {
    const msg = fatal instanceof Error ? fatal.message : String(fatal);
    console.error('[autopilot-engine] FATAL:', msg);
    return res.status(500).json({ error: 'Fatal crash', detail: msg });
  }
}

async function _handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const cronSecret    = process.env.CRON_SECRET ?? '';
  const isVercelCron  = req.headers['x-vercel-cron'] === '1';
  const authHeader    = (req.headers['authorization'] as string) ?? '';
  const bearerToken   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!isVercelCron && !(cronSecret && bearerToken === cronSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── 2. Validate env vars ───────────────────────────────────────────────────
  const apifyToken   = process.env.APIFY_TOKEN ?? process.env.VITE_APIFY_API_TOKEN ?? '';
  const instantlyKey = process.env.INSTANTLY_API_KEY ?? '';

  if (!apifyToken) {
    return res.status(500).json({ error: 'Missing APIFY_TOKEN / VITE_APIFY_API_TOKEN env var' });
  }
  if (!instantlyKey) {
    return res.status(500).json({ error: 'Missing INSTANTLY_API_KEY env var' });
  }

  // ── 3. Load active autopilot campaigns ────────────────────────────────────
  let supabase: ReturnType<typeof createClient>;
  try {
    supabase = getSupabase();
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }

  const { data: campaigns, error: dbErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('autopilot_enabled', true)
    .eq('status', 'active');

  if (dbErr) {
    return res.status(500).json({ error: `DB query failed: ${dbErr.message}` });
  }

  const currentHour = new Date().getUTCHours(); // kept for logging only
  const todayDate   = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  const summary: Array<{
    campaignId: string;
    campaignName: string;
    status: string;
    leadsFound?: number;
    addedToInstantly?: number;
    reason?: string;
    errors?: string[];
  }> = [];

  for (const campaign of (campaigns ?? []) as CampaignRow[]) {
    const startHour = campaign.autopilot_start_hour ?? 22;
    const endHour   = campaign.autopilot_end_hour   ?? 6;
    const campaignTz = (campaign as CampaignRow & { autopilot_timezone?: string }).autopilot_timezone ?? 'UTC';
    const localHour  = getCurrentHourInTz(campaignTz);

    // ── Window check ──────────────────────────────────────────────────────────
    if (!isInsideWindow(localHour, startHour, endHour)) {
      summary.push({ campaignId: campaign.id, campaignName: campaign.name, status: 'skipped', reason: `Outside window (${startHour}h–${endHour}h in ${campaignTz}, now ${localHour}h)` });
      continue;
    }

    // ── Reset daily counter if new day ────────────────────────────────────────
    let leadsToday = campaign.autopilot_leads_today ?? 0;
    if (!campaign.autopilot_reset_date || campaign.autopilot_reset_date < todayDate) {
      leadsToday = 0;
      await supabase.from('campaigns').update({
        autopilot_leads_today: 0,
        autopilot_reset_date:  todayDate,
      }).eq('id', campaign.id);
    }

    // ── Daily limit check ─────────────────────────────────────────────────────
    const dailyLimit = campaign.autopilot_daily_limit ?? 50;
    if (leadsToday >= dailyLimit) {
      summary.push({ campaignId: campaign.id, campaignName: campaign.name, status: 'skipped', reason: `Daily limit reached (${leadsToday}/${dailyLimit})` });
      continue;
    }

    // ── Insert audit row (running) ────────────────────────────────────────────
    const { data: runRow } = await supabase.from('autopilot_runs').insert({
      campaign_id: campaign.id,
      user_id:     campaign.user_id,
      status:      'running',
      batch_size:  campaign.autopilot_batch_size ?? 5,
    }).select().single();

    const runId = (runRow as { id?: string } | null)?.id ?? null;

    // ── Run the batch ─────────────────────────────────────────────────────────
    let batchStatus: 'success' | 'error' = 'success';
    let errorMessage: string | null       = null;
    let batchResult                       = { leadsFound: 0, addedToInstantly: 0, skippedDuplicate: 0, errors: [] as string[] };

    try {
      // Dynamic import to surface module-resolution errors as JSON
      const { runAutopilotBatch } = await import('../../services/autopilot/CronSearchOrchestrator');
      batchResult = await runAutopilotBatch(campaign, supabase, apifyToken, instantlyKey);
      if (batchResult.errors.length > 0 && batchResult.leadsFound === 0) {
        batchStatus  = 'error';
        errorMessage = batchResult.errors.join('; ');
      }
    } catch (e) {
      batchStatus  = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
    }

    const newLeadsToday = leadsToday + batchResult.leadsFound;

    // ── Update campaign counters ───────────────────────────────────────────────
    await supabase.from('campaigns').update({
      autopilot_leads_today: newLeadsToday,
      autopilot_reset_date:  todayDate,
      autopilot_last_run_at: new Date().toISOString(),
      ...(batchResult.leadsFound > 0
        ? { total_leads: supabase.rpc ? undefined : undefined } // total_leads updated via DB trigger or separately
        : {}),
    }).eq('id', campaign.id);

    // Increment total_leads separately (no rpc needed, just read-then-write is fine for cron)
    if (batchResult.leadsFound > 0) {
      const { data: latest } = await supabase.from('campaigns').select('total_leads').eq('id', campaign.id).single();
      const current = (latest as { total_leads?: number } | null)?.total_leads ?? 0;
      await supabase.from('campaigns').update({ total_leads: current + batchResult.leadsFound }).eq('id', campaign.id);
    }

    // ── Finalise audit row ─────────────────────────────────────────────────────
    if (runId) {
      await supabase.from('autopilot_runs').update({
        finished_at:             new Date().toISOString(),
        leads_found:             batchResult.leadsFound,
        leads_added_to_instantly: batchResult.addedToInstantly,
        status:                  batchStatus,
        error_message:           errorMessage,
        daily_total_after:       newLeadsToday,
      }).eq('id', runId);
    }

    summary.push({
      campaignId:      campaign.id,
      campaignName:    campaign.name,
      status:          batchStatus,
      leadsFound:      batchResult.leadsFound,
      addedToInstantly: batchResult.addedToInstantly,
      errors:          batchResult.errors.length > 0 ? batchResult.errors : undefined,
    });
  }

  return res.status(200).json({
    ok:              true,
    processedAt:     new Date().toISOString(),
    currentHourUTC:  currentHour,
    processed:       summary.length,
    campaigns:       summary,
  });
}
