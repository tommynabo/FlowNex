/**
 * api/webhooks/instantly-reply.ts
 *
 * Vercel Serverless Function — POST only.
 * Receives reply_received webhook events from Instantly.ai,
 * generates an AI-drafted response using a 5-layer brain prompt,
 * and stores the conversation in Supabase for human review.
 *
 * Authentication: ?secret=<WEBHOOK_SECRET> query param.
 * Configure the full URL (with secret param) in Instantly webhook settings.
 *
 * Required env vars (server-side only):
 *   WEBHOOK_SECRET          — Shared secret added as URL query param
 *   SUPABASE_URL            — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service key (bypasses RLS for inserts)
 *   OPENAI_API_KEY          — OpenAI API key
 *   SETTER_USER_ID          — Supabase user UUID that owns incoming conversations
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { SYMMETRY_CONTEXT } from '../../config/symmetry';

// ── Types ────────────────────────────────────────────────────────────────────

interface InstantlyWebhookPayload {
  event_type: string;
  timestamp: string;
  workspace: string;
  campaign_id: string;
  campaign_name: string;
  lead_email?: string;
  email_account?: string;
  email_id?: string;           // reply_to_uuid — used to send the reply
  reply_subject?: string;
  reply_text?: string;
  reply_html?: string;
  reply_text_snippet?: string;
  [key: string]: unknown;
}

interface AiSetterResponse {
  intent: string;
  confidence_score: number;
  draft: string;
}

interface FeedbackRow {
  decision: string;
  original_draft: string;
  corrected_draft: string | null;
  reason: string;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── 1. Authenticate via query param secret ──────────────────────────────
  const { secret } = req.query;
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('[SETTER][WEBHOOK] WEBHOOK_SECRET env var not set');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  if (!secret || secret !== webhookSecret) {
    console.warn('[SETTER][WEBHOOK] Invalid or missing webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── 2. Parse & validate payload ─────────────────────────────────────────
  const payload = req.body as InstantlyWebhookPayload;

  // Only process reply events
  if (payload.event_type !== 'reply_received') {
    return res.status(200).json({ skipped: true, reason: `event_type=${payload.event_type}` });
  }

  const { campaign_id, campaign_name, lead_email, email_id, reply_subject, reply_text, workspace } = payload;

  if (!lead_email || !email_id || !campaign_id || !reply_text) {
    console.error('[SETTER][WEBHOOK] Missing required fields', { lead_email, email_id, campaign_id });
    return res.status(400).json({ error: 'Missing required fields: lead_email, email_id, campaign_id, reply_text' });
  }

  // ── 3. Init Supabase admin client (bypasses RLS) ─────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[SETTER][WEBHOOK] Missing Supabase env vars');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // ── 4. Resolve user_id ───────────────────────────────────────────────────
  const userId = process.env.SETTER_USER_ID;
  if (!userId) {
    console.error('[SETTER][WEBHOOK] SETTER_USER_ID env var not set');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // ── 5. Fetch recent feedback for in-context learning (Layer 5) ───────────
  let recentFeedback: FeedbackRow[] = [];
  try {
    const { data } = await supabase
      .from('setter_feedback')
      .select('decision, original_draft, corrected_draft, reason')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(15);

    if (data) recentFeedback = data as FeedbackRow[];
  } catch (err) {
    console.warn('[SETTER][WEBHOOK] Could not load feedback (non-fatal):', err);
  }

  // ── 6. Build 5-layer system prompt ───────────────────────────────────────
  const faqText = SYMMETRY_CONTEXT.faq
    .map((f, i) => `FAQ ${i + 1}:\nPregunta: ${f.question}\nRespuesta: ${f.answer}`)
    .join('\n\n');

  const feedbackText =
    recentFeedback.length > 0
      ? recentFeedback
          .map(
            (fb, i) =>
              `Ejemplo ${i + 1} [${fb.decision.toUpperCase()}]:\n` +
              `Borrador IA: "${fb.original_draft}"\n` +
              (fb.corrected_draft ? `Corregido a: "${fb.corrected_draft}"\n` : '') +
              `Razón: ${fb.reason}`
          )
          .join('\n\n')
      : 'No hay historial de feedback aún. Aplica las reglas de copywriting con máxima precisión.';

  const systemPrompt = `Eres el AI Setter de ${SYMMETRY_CONTEXT.companyName}. Tu función es generar respuestas a leads que han contestado emails de prospección.

══ CAPA 1: CONTEXTO DE ${SYMMETRY_CONTEXT.companyName.toUpperCase()} ══
${SYMMETRY_CONTEXT.companyMission}

OFERTA:
${SYMMETRY_CONTEXT.offerDescription}

DESCRIPCIÓN DEL PUESTO:
${SYMMETRY_CONTEXT.jobDescription}

══ CAPA 2: FORMACIÓN EN COPYWRITING (Direct Response) ══
${SYMMETRY_CONTEXT.copywritingRules}

══ CAPA 3: TONO DE VOZ ══
${SYMMETRY_CONTEXT.toneGuidelines}

══ CAPA 4: FAQ — CÓMO RESPONDER OBJECIONES FRECUENTES ══
${faqText}

══ CAPA 5: APRENDIZAJE DE FEEDBACK HUMANO (últimas ${recentFeedback.length} decisiones) ══
${feedbackText}

══ INSTRUCCIONES DE OUTPUT ══
Responde ÚNICAMENTE con un objeto JSON válido (sin markdown, sin texto extra) con esta estructura exacta:
{
  "intent": "interested" | "objection" | "question" | "not_interested" | "unsubscribe" | "unknown",
  "confidence_score": <número entre 0 y 100>,
  "draft": "<respuesta completa en texto plano que se enviará al lead>"
}

Reglas para confidence_score:
- 90-100: Respuesta directa a una objeción común del FAQ, tono y largo perfectos
- 70-89: Intención clara pero respuesta moderadamente compleja
- 50-69: Intención ambigua o situación no cubierta por el FAQ
- < 50: Mensaje muy difícil de interpretar o potencialmente hostil

El campo "draft" debe estar listo para enviarse tal cual. Sin placeholders, sin corchetes.`;

  // ── 7. Call OpenAI ────────────────────────────────────────────────────────
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error('[SETTER][WEBHOOK] OPENAI_API_KEY env var not set');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  let aiResult: AiSetterResponse;
  try {
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `El lead ${lead_email} ha respondido a la campaña "${campaign_name || campaign_id}":\n\nAsunto: ${reply_subject || '(sin asunto)'}\n\nMensaje:\n${reply_text}`,
          },
        ],
      }),
    });

    if (!openaiResponse.ok) {
      const errorBody = await openaiResponse.text();
      throw new Error(`OpenAI error ${openaiResponse.status}: ${errorBody}`);
    }

    const openaiData = await openaiResponse.json() as { choices: Array<{ message: { content: string } }> };
    const rawContent = openaiData.choices[0]?.message?.content ?? '{}';
    aiResult = JSON.parse(rawContent) as AiSetterResponse;

    if (!aiResult.draft || !aiResult.intent) {
      throw new Error('OpenAI returned incomplete JSON');
    }
  } catch (err) {
    console.error('[SETTER][WEBHOOK] OpenAI call failed:', err);
    // Store conversation without draft so reviewer can write manually
    aiResult = {
      intent: 'unknown',
      confidence_score: 0,
      draft: '',
    };
  }

  // ── 8. Insert conversation into Supabase ──────────────────────────────────
  const { data: inserted, error: insertError } = await supabase
    .from('lead_conversations')
    .insert({
      user_id: userId,
      workspace_id: workspace ?? null,
      campaign_id,
      campaign_name: campaign_name ?? null,
      lead_email,
      email_id,
      reply_subject: reply_subject ?? null,
      reply_text,
      ai_draft: aiResult.draft || null,
      intent_classification: aiResult.intent || 'unknown',
      confidence_score: aiResult.confidence_score ?? 0,
      status: 'pending_review',
    })
    .select('id')
    .single();

  if (insertError) {
    console.error('[SETTER][WEBHOOK] Supabase insert error:', insertError);
    return res.status(500).json({ error: 'Failed to save conversation', details: insertError.message });
  }

  console.log(`[SETTER][WEBHOOK] Conversation saved — id=${inserted?.id}, lead=${lead_email}, intent=${aiResult.intent}, confidence=${aiResult.confidence_score}`);

  return res.status(200).json({
    success: true,
    conversationId: inserted?.id,
    intent: aiResult.intent,
    confidence_score: aiResult.confidence_score,
  });
}
