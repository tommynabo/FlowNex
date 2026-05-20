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
  loomLink: 'https://www.loom.com/share/f795c20c49fb4ab0a77d4ee09ec2d4ce',
  rolePageLink: 'https://symmetry.club/roles/ugc-creator-en',

  companyMission:
    'Symmetry is the #1 Health & Fitness app in the Spanish-speaking world, with over 1 million downloads ' +
    'and $1M+ ARR. The entire business was built from organic short-form vertical video content — no paid ads. ' +
    'We are now expanding to the US and UK market by hiring in-house UGC content creators.',

  offerDescription:
    'We are hiring UGC content creators based in the US or UK to join our in-house content team. ' +
    'THIS IS NOT a brand collab, a sponsored post, or a per-piece payment deal. ' +
    'It is a paid role on our content team with performance-based compensation: ' +
    'base $4,000/month scaling up to $20,000/month for top performers, tied to downloads driven by their content. ' +
    'Commitment: minimum 4 hours/day, 6 days/week, fully remote. ' +
    'The next step for interested candidates is to fill in the short form at the bottom of the role page ' +
    '(under 5 minutes) — our Head of Content reviews every application personally and reaches out fast.',

  jobDescription:
    'Position: UGC Content Creator — Vertical Format (Remote)\n' +
    '- Function: Create daily high-volume short-form vertical videos (TikTok/Reels format) that drive app downloads\n' +
    '- Location: Must be based in the US or UK (firm requirement)\n' +
    '- Schedule: Minimum 4h/day, 6 days/week, fully remote\n' +
    '- Compensation: $4,000–$20,000 USD/month, 100% performance-based (tied to downloads), no cap\n' +
    '- NOT per-video/post: comp is tied to overall content performance, not per video published\n' +
    '- High-volume testing environment: test formats, kill what doesn\'t convert, double down on what scales\n' +
    '- Direct feedback loop with Head of Content\n' +
    '- Start: Immediate — after application review, Head of Content schedules an intro call that same week',

  toneGuidelines:
    'Voice: Casual-Professional. Direct, honest, peer-to-peer — like a founder talking to a creator, not a recruiter.\n' +
    '- NEVER use emojis (zero tolerance in this campaign)\n' +
    '- NEVER use filler phrases like "Hope this finds you well", "I would be delighted", "It\'s my pleasure", "I\'m so excited"\n' +
    '- NEVER use corporate/recruiter language ("exciting opportunity", "we\'d love to connect", "touch base", "circle back")\n' +
    '- Write like a peer who respects the creator\'s time. Short sentences.\n' +
    '- EACH sentence or idea goes in its OWN paragraph, separated by a blank line (\\n\\n). NEVER group multiple sentences in the same block.\n' +
    '- Each message should be readable in under 20 seconds',

  copywritingRules:
    'Direct Response Rules:\n' +
    '1. The ONLY goal is to get the lead to fill in the short form at the role page\n' +
    '2. Answer the lead\'s actual question or objection FIRST, before pushing the form\n' +
    '3. THE CTA IS ALWAYS THE FORM — never say "book a time" or "schedule a call" directly. They fill the form first, then we contact them\n' +
    '4. CORRECT CTA: "fill in the short form (under 5 min) — our Head of Content will reach out to schedule a call after reviewing it"\n' +
    '5. WRONG CTA: "book a time here", "schedule a call here", "let\'s hop on a call" as the direct next step\n' +
    '6. If lead shows interest, send the Loom + form. Do not write a long explanation of the role\n' +
    '7. If lead has an objection, acknowledge it briefly, reframe it, then redirect to Loom + form\n' +
    '8. Never write messages longer than 6 lines total',

  faq: [
    {
      question: 'Is this a brand collab? / Rate per post? / Rate per video? / I work per-post / What\'s your budget per video?',
      answer:
        'This is NOT a brand collab or per-post deal — there is no per-piece fee. ' +
        'It is a paid role on our content team: you are a team member, not a brand partner. ' +
        'Compensation is performance-based: base $4k/mo scaling up to $20k/mo, tied to downloads driven by your content. ' +
        'The reason it\'s not per-piece: creators produce high volume and we want people scaling with us, not booking one-off campaigns.',
    },
    {
      question: 'What\'s the pay? / What\'s the salary? / How much does it pay?',
      answer:
        'Performance-based: base $4k/mo scaling up to $20k/mo for top performers, tied to downloads driven by your content. No cap. ' +
        'Not per-video — it\'s tied to overall impact. The more your content drives downloads, the higher your comp. ' +
        'Details are on the role page; the Head of Content goes through the exact attribution model on the intro call.',
    },
    {
      question: 'How many hours? / Is this full-time? / Is this a side gig?',
      answer:
        'Minimum 4 hours/day, 6 days a week. It works as a part-time commitment if you protect those hours, ' +
        'but it\'s not a "few hours here and there" gig — the high-volume testing pace requires being in the loop daily. ' +
        'Most creators who do well here drop one or two other things because the comp scales in a way most creator gigs don\'t.',
    },
    {
      question: 'Is this legit? / Never heard of Symmetry / Who are you? / Is this real?',
      answer:
        'Fair question. Symmetry is the #1 Health & Fitness app in the Spanish-speaking world — over 1M downloads, $1M+ ARR. ' +
        'Built entirely from organic short-form video, no paid ads. ' +
        'We\'re not known in the US yet because we\'re just expanding there now — that\'s literally why we\'re hiring US creators. ' +
        'App is live on the App Store (symmetry.club).',
    },
    {
      question: 'Is it remote? / Where do I need to be based?',
      answer:
        '100% remote, but you must be based in the US or UK. ' +
        'The content needs to resonate with local audiences — that\'s non-negotiable for the role to work.',
    },
    {
      question: 'What does the job involve? / What kind of content? / What\'s the process to apply?',
      answer:
        'High-volume short-form vertical video — TikTok/Reels format for a fitness app. ' +
        'You test formats, iterate fast, double down on what drives downloads. Direct feedback loop with Head of Content. ' +
        'To apply: fill in the short form at the bottom of the role page (under 5 min). ' +
        'Head of Content reviews every application personally and schedules an intro call that same week.',
    },
    {
      question: 'What is Symmetry? / Tell me about the company',
      answer:
        'Symmetry is the #1 Health & Fitness app in the Spanish-speaking world, with 1M+ downloads and $1M+ ARR. ' +
        'The entire business was built from organic short-form video content — no paid ads, just creators producing volume at scale. ' +
        'Now expanding to US/UK because ARPU there is ~2.5x higher, and we want to replicate the same playbook.',
    },
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
  branch?: string;
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

interface PriorConversationRow {
  reply_text: string;
  ai_draft: string | null;
  intent_classification: string | null;
  status: string;
  created_at: string;
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

  // Only process the target campaign — skip all others silently
  const TARGET_CAMPAIGN_ID = 'f021448d-70d0-413a-82aa-932b54d326df';
  if (payload.campaign_id !== TARGET_CAMPAIGN_ID) {
    return res.status(200).json({ skipped: true, reason: 'Not the target campaign' });
  }

  const { campaign_id, campaign_name, lead_email, email_id, reply_subject, reply_text, workspace, email_account } = payload;

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

  // ── 5b. Fetch prior conversations for this lead (multi-turn awareness) ───
  let priorConversations: PriorConversationRow[] = [];
  try {
    const { data: priorData } = await supabase
      .from('lead_conversations')
      .select('reply_text, ai_draft, intent_classification, status, created_at')
      .eq('lead_email', lead_email)
      .order('created_at', { ascending: true })
      .limit(5);

    if (priorData) priorConversations = priorData as PriorConversationRow[];
  } catch (err) {
    console.warn('[SETTER][WEBHOOK] Could not load prior conversations (non-fatal):', err);
  }

  const isFollowUp = priorConversations.length > 0;
  const formWasSent = priorConversations.some(
    c => c.ai_draft !== null && c.ai_draft.includes('symmetry.club/roles/')
  );
  const historyText = isFollowUp
    ? priorConversations
        .map((c, i) => {
          const turn = `[Turn ${i + 1}]\nLead: "${c.reply_text}"`;
          return c.ai_draft
            ? `${turn}\nOur reply (sent): "${c.ai_draft}"\n(status: ${c.status})`
            : `${turn}\n(no reply sent yet — status: ${c.status})`;
        })
        .join('\n\n')
    : null;

  console.log(`[SETTER][WEBHOOK] lead=${lead_email} | isFollowUp=${isFollowUp} | turns=${priorConversations.length} | formWasSent=${formWasSent}`);

  // ── 6. Build 5-layer system prompt ───────────────────────────────────────
  const faqText = SYMMETRY_CONTEXT.faq
    .map((f, i) => `FAQ ${i + 1}:\nQuestion: ${f.question}\nAnswer: ${f.answer}`)
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

  const systemPrompt = `You are the AI Setter for ${SYMMETRY_CONTEXT.companyName}. Your job is to draft replies to fitness content creators who have responded to a cold outreach email about an in-house content creator role.

LANGUAGE RULE: All instructions below are written for your understanding. The "draft" field in your JSON output MUST be written exclusively in native American English (US English). Never write the draft in Spanish under any circumstance.

══ STEP 1 — CLASSIFY THE LEAD'S REPLY INTO A BRANCH ══

Before writing anything, classify the lead's reply into exactly ONE branch. Use this priority order: B > D > C > E > A. Branch F overrides all.

BRANCH A — Interest, no objection (DEFAULT)
  Trigger: "sounds interesting", "tell me more", "I'm open to it", "what's the role", "I'd love to know more", general curiosity with no specific objection.

BRANCH B — Per-post / brand-collab objection (HIGHEST PRIORITY)
  Trigger: mentions "rate per video/post", asks for per-piece pricing, "I work per-post", "what's your budget per video", asks about per-content rates, treats the offer as a brand sponsorship deal.

BRANCH C — Time / commitment concern
  Trigger: asks "how many hours", "is this full-time", "I'm already very busy", "is this a side gig", questions about schedule or whether it fits alongside other work.

BRANCH D — Authority / credibility skepticism
  Trigger: "is this real", "never heard of Symmetry", "who are you", "can you show proof", doubts about whether the company or role is legitimate.

BRANCH E — Specific question (other)
  Trigger: a concrete question about comp structure, location, contract type, tools, team size, or what the content work looks like — that does not fit B, C, or D.

BRANCH F — Not interested / not a fit
  Trigger: "no thanks", "not for me", "I'm already signed", "I'm based outside US/UK", any explicit decline.

══ STEP 2 — DRAFT THE RESPONSE USING THE CORRECT BRANCH TEMPLATE ══

Use the exact template below for the classified branch. Replace [firstName] with the lead's first name if available from context, or omit it gracefully.

--- BRANCH A TEMPLATE (Interest, no objection) ---
Glad you're interested, [firstName].

Quick context before you apply — I recorded a short video walking you through what Symmetry is, why we're hiring US/UK creators now, and how the role actually works. Worth 2 minutes:

${SYMMETRY_CONTEXT.loomLink}

If it resonates, fill in the short form here (under 5 min — our Head of Content reads every one personally): ${SYMMETRY_CONTEXT.rolePageLink}

What questions come up after watching? Happy to answer.

— [Founder]

--- BRANCH B TEMPLATE (Per-post / brand-collab objection) ---
Good question [firstName], and totally fair to ask.

This is different from a brand collab — there's no per-post fee. It's a paid role on our content team.

Comp is performance-based: base $4k/mo, scaling up to $20k/mo for top performers, tied to downloads driven by your videos — not per video published.

The reason it's not per-piece: you're producing high volume and we want creators who are scaling with us, not booking one-off campaigns.

Worth 2 minutes to see how it actually works: ${SYMMETRY_CONTEXT.loomLink}

If you're in, the form takes 5 min: ${SYMMETRY_CONTEXT.rolePageLink}

Either way, glad you asked first. — [Founder]

--- BRANCH C TEMPLATE (Time / commitment concern) ---
Honest answer [firstName] — the minimum is 4h/day, 6 days a week.

It works as a part-time role if you protect those hours, but it's not a "few hours here and there" kind of thing.

The reason it's that intensive: we test a lot, kill a lot, double down on what works. That pace requires being in the loop daily.

Most creators who do well here tell us they dropped one or two other things and focused here — because the comp scales in a way most creator gigs don't ($4–20k/mo based on results).

Short video walking through the role: ${SYMMETRY_CONTEXT.loomLink}

Form (5 min): ${SYMMETRY_CONTEXT.rolePageLink} — [Founder]

--- BRANCH D TEMPLATE (Authority / credibility skepticism) ---
Fair pushback [firstName] — we're not a name you'd know in the US yet, and that's literally why we're hiring US creators.

For context: Symmetry is the #1 Health & Fitness app in the Spanish-speaking world — +1M downloads, $1M+ ARR. Built entirely from organic short-form video, no paid ads.

We're going US/UK now because ARPU there is ~2.5x higher and we want to run the same playbook.

Short video where I walk you through it: ${SYMMETRY_CONTEXT.loomLink}

Form when you're ready (5 min): ${SYMMETRY_CONTEXT.rolePageLink} — [Founder]

--- BRANCH E TEMPLATE (Specific question) ---
Good question [firstName].

[Answer the specific question in 1-2 sentences. Use the FAQ section below for accurate answers. Do NOT invent details not covered by the FAQ.]

For the full picture: ${SYMMETRY_CONTEXT.loomLink}

Form here (5 min): ${SYMMETRY_CONTEXT.rolePageLink}

Any other questions, just hit reply. — [Founder]

--- BRANCH F TEMPLATE (Not interested) ---
All good [firstName], appreciate you replying back.

If anything changes — or if you know someone US/UK based who'd be a great fit — feel free to point them this way.

Best with what you're working on. — [Founder]

══ CRITICAL RULE — FORM ALREADY SUBMITTED ══

Read the CONVERSATION HISTORY in the user message BEFORE generating your draft.

If the history shows the role page link was ALREADY sent to this lead AND their current message indicates they filled out the form — trigger phrases: "I filled it out", "Done", "I submitted", "I applied", "I completed the form", "I sent it", "Already did it", "I already filled that in", "just applied", "I sent my details", "I submitted my application", "already done", "I did it" — respond ONLY with:

That's great — you're all set!

Our Head of Content reviews every application personally and will be in touch with you shortly.

No link. No CTA. No form URL in this response. Set "intent" to "form_submitted" and "branch" to "F".

IMPORTANT: When in doubt — if the form link was already sent in a prior turn AND any positive completion signal is present — assume submitted and close warmly. Do NOT re-send the form link.

══ CRITICAL RULE — CONVERSATION HISTORY AWARENESS ══

ALWAYS read the full CONVERSATION HISTORY in the user message before drafting.
- If this is a follow-up (history is not empty), do NOT treat it as first contact.
- Never repeat information or links already sent in a previous turn.
- Adjust tone to the current stage of the conversation.
- Answer follow-up questions directly without re-introducing the company from scratch.

══ CAPA 1: CONTEXTO DE ${SYMMETRY_CONTEXT.companyName.toUpperCase()} ══
${SYMMETRY_CONTEXT.companyMission}

ROL OFERTADO:
${SYMMETRY_CONTEXT.offerDescription}

DESCRIPCIÓN DEL PUESTO:
${SYMMETRY_CONTEXT.jobDescription}

══ CAPA 2: REGLAS DE COPYWRITING ══
${SYMMETRY_CONTEXT.copywritingRules}

══ CAPA 3: TONO DE VOZ ══
${SYMMETRY_CONTEXT.toneGuidelines}

══ CAPA 4: FAQ — OBJECIONES FRECUENTES ══
${faqText}

══ CAPA 5: APRENDIZAJE DE FEEDBACK HUMANO (últimas ${recentFeedback.length} decisiones) ══
${feedbackText}

══ OUTPUT FORMAT ══
Respond ONLY with a valid JSON object (no markdown, no extra text):
{
  "branch": "A" | "B" | "C" | "D" | "E" | "F",
  "intent": "interested" | "objection" | "question" | "not_interested" | "unsubscribe" | "form_submitted" | "unknown",
  "confidence_score": <number 0-100>,
  "draft": "<complete reply ready to send>"
}

Rules for confidence_score:
- 90-100: Clear branch match, template followed precisely, correct tone and length
- 70-89: Clear intent but moderately complex situation
- 50-69: Ambiguous intent or edge case not fully covered
- <50: Very hard to interpret or potentially hostile

MANDATORY PARAGRAPH FORMATTING — THIS IS NON-NEGOTIABLE:
Every single sentence or idea in the "draft" MUST be its own paragraph, separated by a blank line (\\n\\n).
NEVER put two or more sentences in the same block of text. One idea = one paragraph.
CORRECT: "Sentence 1.\\n\\nSentence 2.\\n\\nSentence 3."
WRONG: "Sentence 1. Sentence 2. Sentence 3."
WRONG: "Sentence 1.\\nSentence 2." (single newline is NOT a blank line — must be \\n\\n)
The human reviewer rejects drafts that violate this rule every single time without exception.`;

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
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: historyText
              ? `PRIOR CONVERSATION HISTORY WITH THIS LEAD:\n${historyText}\n\n──────────────────────────────\n\nCURRENT MESSAGE (turn ${priorConversations.length + 1}):\nLead: ${lead_email} | Campaign: "${campaign_name || campaign_id}"\nSubject: ${reply_subject || '(no subject)'}\n\nMessage:\n${reply_text}`
              : `El lead ${lead_email} ha respondido a la campaña "${campaign_name || campaign_id}":\n\nAsunto: ${reply_subject || '(sin asunto)'}\n\nMensaje:\n${reply_text}`,
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

  // ── 8b. Dedup guard — skip if this email_id was already processed ─────────
  const { data: existingConv } = await supabase
    .from('lead_conversations')
    .select('id')
    .eq('email_id', email_id)
    .maybeSingle();

  if (existingConv) {
    console.log(`[SETTER][WEBHOOK] Skipping duplicate — email_id ${email_id} already processed (id=${existingConv.id})`);
    return res.status(200).json({ skipped: true, reason: 'duplicate_email_id', existingId: existingConv.id });
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
      email_account: email_account ?? null,
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

  console.log(`[SETTER][WEBHOOK] Conversation saved — id=${inserted?.id}, lead=${lead_email}, branch=${aiResult.branch ?? '?'}, intent=${aiResult.intent}, confidence=${aiResult.confidence_score}`);

  return res.status(200).json({
    success: true,
    conversationId: inserted?.id,
    intent: aiResult.intent,
    confidence_score: aiResult.confidence_score,
  });
}
