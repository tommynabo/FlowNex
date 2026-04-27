/**
 * api/setter/send-reply.ts
 *
 * Vercel Serverless Function — POST only.
 * Called from the client (SetterDashboard) after a human approves or corrects a draft.
 * Sends the final reply via the Instantly Unibox API, then updates the conversation status.
 *
 * Required env vars (server-side only):
 *   INSTANTLY_API_KEY         — Instantly.ai API key (Plan Hypergrowth)
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service key
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

interface SendReplyRequest {
  conversationId: string;
  draft: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── 1. Validate request body ─────────────────────────────────────────────
  const { conversationId, draft } = req.body as Partial<SendReplyRequest>;

  if (!conversationId || typeof conversationId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid conversationId' });
  }
  if (!draft || typeof draft !== 'string' || draft.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty draft' });
  }

  // ── 2. Check env vars ────────────────────────────────────────────────────
  const instantlyKey = process.env.INSTANTLY_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!instantlyKey || !supabaseUrl || !serviceRoleKey) {
    console.error('[SETTER][SEND] Missing required env vars');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // ── 3. Load conversation from Supabase ───────────────────────────────────
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: conversation, error: fetchError } = await supabase
    .from('lead_conversations')
    .select('id, email_id, lead_email, status')
    .eq('id', conversationId)
    .single();

  if (fetchError || !conversation) {
    console.error('[SETTER][SEND] Conversation not found:', fetchError);
    return res.status(404).json({ error: 'Conversation not found' });
  }

  if (conversation.status === 'sent') {
    return res.status(409).json({ error: 'Reply already sent for this conversation' });
  }

  // ── 4. Send reply via Instantly Unibox API ────────────────────────────────
  // Endpoint: POST /api/v2/emails/reply
  // reply_to_uuid identifies the email thread to reply to.
  const instantlyUrl = 'https://api.instantly.ai/api/v2/emails/reply';

  let instantlyOk = false;
  let instantlyError = '';

  try {
    const instantlyResponse = await fetch(instantlyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${instantlyKey}`,
      },
      body: JSON.stringify({
        reply_to_uuid: conversation.email_id,
        body: {
          text: draft.trim(),
        },
      }),
    });

    if (instantlyResponse.ok) {
      instantlyOk = true;
    } else {
      const errBody = await instantlyResponse.text();
      instantlyError = `Instantly ${instantlyResponse.status}: ${errBody}`;
      console.error('[SETTER][SEND] Instantly API error:', instantlyError);
    }
  } catch (err) {
    instantlyError = String(err);
    console.error('[SETTER][SEND] Instantly fetch error:', err);
  }

  if (!instantlyOk) {
    return res.status(502).json({ error: 'Failed to send reply via Instantly', details: instantlyError });
  }

  // ── 5. Update conversation status in Supabase ────────────────────────────
  const { error: updateError } = await supabase
    .from('lead_conversations')
    .update({ status: 'sent', processed_at: new Date().toISOString() })
    .eq('id', conversationId);

  if (updateError) {
    // Reply was sent but DB update failed — log but return success to avoid duplicate sends
    console.error('[SETTER][SEND] DB update failed (reply was still sent):', updateError);
  }

  console.log(`[SETTER][SEND] Reply sent — conversationId=${conversationId}, lead=${conversation.lead_email}`);

  return res.status(200).json({ success: true, conversationId });
}
