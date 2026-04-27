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

// ── Symmetry context (inlined to avoid Vercel ESM module resolution issues) ──
// Keep in sync with config/symmetry.ts
const SYMMETRY_CONTEXT = {
  companyName: 'Symmetry',
  companyMission:
    'Symmetry es una empresa de prospección y ventas B2B que ayuda a emprendedores digitales, ' +
    'coaches y consultores a escalar su captación de clientes mediante sistemas de outreach automatizado. ' +
    'No vendemos software; ofrecemos un servicio hands-off donde nosotros operamos el sistema por el cliente.',
  offerDescription:
    'Ofrecemos posiciones de Setter para trabajar con nuestros clientes. ' +
    'Un Setter es la persona que responde las respuestas entrantes de leads, califica el interés, ' +
    'y agenda llamadas de cierre con el Closer o el fundador. Es un rol 100% remoto, flexible, ' +
    'con comisiones por reunión agendada.',
  jobDescription:
    'Puesto: Setter de Ventas (Remoto)\n' +
    '- Función: Responder leads entrantes, cualificar interés y agendar llamadas de 30 min\n' +
    '- Modalidad: 100% remoto, horario flexible (mínimo 4h/día)\n' +
    '- Compensación: Base fija + comisión por reunión agendada (sin tope)\n' +
    '- Requisitos: Comunicación escrita fluida, proactividad, acceso a ordenador/móvil\n' +
    '- No se requiere experiencia previa en ventas; formamos desde cero\n' +
    '- Incorporación: Inmediata',
  toneGuidelines:
    'Tono de voz: Casual-Profesional. Joven, cercano y directo.\n' +
    '- NUNCA uses emojis en exceso (máximo 1 por mensaje, y solo si aporta)\n' +
    '- NUNCA uses frases de relleno como "espero que te encuentres bien", "un placer", "estoy encantado de"\n' +
    '- Escribe como un colega que conoce el sector, no como un bot ni un vendedor de piso\n' +
    '- Usa frases cortas. Párrafos de máximo 2 líneas\n' +
    '- El mensaje debe leerse en menos de 15 segundos',
  copywritingRules:
    'Reglas de Direct Response Marketing:\n' +
    '1. El objetivo del mensaje NO es cerrar la venta. Es conseguir el SIGUIENTE PASO (una respuesta, una llamada, una confirmación)\n' +
    '2. Responde PRIMERO a lo que preguntó el lead antes de ofrecer más información\n' +
    '3. Termina SIEMPRE con una pregunta o CTA claro (ej: "¿Te viene bien una llamada rápida el jueves?")\n' +
    '4. Si el lead muestra interés, agenda directamente. No des demasiada info por escrito\n' +
    '5. Si el lead pone una objeción, valídala brevemente y redirige hacia la solución\n' +
    '6. Nunca escribas mensajes de más de 5 líneas. Si necesitas más, algo está mal\n' +
    '7. No menciones precio ni condiciones exactas por email; eso se discute en llamada',
  faq: [
    { question: '¿Cuánto se paga? / ¿Cuál es el salario?', answer: 'La comp tiene una base fija más comisiones por reunión agendada, sin tope. Los detalles exactos los cerramos en una llamada de 20 minutos para ver si hay fit. ¿Tienes disponibilidad esta semana?' },
    { question: '¿Cuántas horas hay que trabajar? / ¿Es tiempo completo?', answer: 'Es flexible: mínimo 4 horas al día, tú decides el bloque horario. Muchos de nuestros setters lo combinan con otras actividades. Lo hablamos en la llamada, ¿te cuadra esta semana?' },
    { question: '¿Necesito experiencia? / No tengo experiencia en ventas', answer: 'No hace falta experiencia previa. Formamos desde cero con un onboarding de 3 días. Lo que más valoramos es la actitud y la comunicación escrita. ¿Seguimos hablando? Puedo hacer una llamada corta para contarte todo.' },
    { question: '¿Es presencial o remoto?', answer: '100% remoto. Solo necesitas internet y un dispositivo. Puedes trabajar desde donde quieras.' },
    { question: '¿De qué trata exactamente el trabajo? / ¿Qué hace un setter?', answer: 'El setter responde leads que ya han mostrado interés (no hay que buscarlos tú), los cualifica y agenda llamadas con nuestro equipo de cierre. Es la parte más interesante del embudo: pura conversación estratégica, sin presentaciones frías.' },
    { question: '¿Cuándo empieza? / ¿Cuándo hay que incorporarse?', answer: 'Incorporación inmediata. Si hay fit en la llamada, arrancamos esa misma semana. ¿Te viene bien hablar mañana o pasado?' },
  ],
};

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

CRITICAL RULE: TUS INSTRUCCIONES Y EL CONTEXTO DE LA EMPRESA ESTÁN EN ESPAÑOL PARA TU ENTENDIMIENTO, PERO EL CAMPO 'draft' DEL JSON FINAL (LA RESPUESTA AL LEAD) DEBE ESTAR ESCRITO EXCLUSIVAMENTE EN INGLÉS NATIVO AMERICANO (US ENGLISH). NO ESCRIBAS EL BORRADOR EN ESPAÑOL BAJO NINGÚN CONCEPTO.

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

  // ── 8. Auto-heal: Ensure user exists in profiles to satisfy FK constraint ──
  const { error: upsertError } = await supabase
    .from('profiles')
    .upsert({
      id: userId,
      email: 'setter_bot_auto@flownext.com', // Fallback email to satisfy constraints
    }, { onConflict: 'id' });

  if (upsertError) {
    console.warn('[SETTER][WEBHOOK] Warning: Could not auto-heal profile (may cause FK error):', upsertError.message);
  }

  // ── 9. Insert conversation into Supabase ──────────────────────────────────
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
