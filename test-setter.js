/**
 * test-setter.js
 *
 * Quick local test to verify the AI Setter is trained correctly.
 * Simulates what the webhook does — calls OpenAI directly with the
 * current system prompt from config/symmetry.ts and prints the draft.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node test-setter.js
 *
 * Or create a .env file with OPENAI_API_KEY=sk-... and run:
 *   node -e "require('fs').readFileSync('.env','utf8').split('\n').forEach(l=>{const[k,v]=l.split('=');if(k)process.env[k]=v})" test-setter.js
 */

const FORM_URL = 'https://symmetry.club/roles/ugc-creator-en';

// ── Test cases — add or edit as needed ───────────────────────────────────────
const TEST_CASES = [
  {
    label: '✅ Positive interest',
    reply: "Sounds interesting, I'd like to know more about the role.",
    expectedIntent: 'interested',
    mustContain: FORM_URL,
  },
  {
    label: '💬 Salary question',
    reply: "How much does it pay? What's the compensation like?",
    expectedIntent: 'question',
    mustContain: ['4,000', '20,000'],
  },
  {
    label: '❓ Experience question',
    reply: "Do I need experience in content creation? I haven't done this professionally.",
    expectedIntent: 'question',
    mustContain: null,
  },
  {
    label: '❓ Remote question',
    reply: 'Is this position fully remote? Can I work from Europe?',
    expectedIntent: 'question',
    mustContain: ['US', 'UK', 'United'],
  },
  {
    label: '❓ What is Symmetry question',
    reply: "What company is this? I don't recognize Symmetry.",
    expectedIntent: 'question',
    mustContain: ['#1', 'Health', 'Fitness'],
  },
  {
    label: '🚫 Not interested',
    reply: "Not interested, please don't email me again.",
    expectedIntent: 'not_interested',
    mustContain: null,
  },
  {
    label: '✅ Ready to apply',
    reply: "I'm in, what's the next step?",
    expectedIntent: 'interested',
    mustContain: FORM_URL,
  },
];

// ── Minimal system prompt builder (mirrors instantly-reply.ts) ────────────────
function buildSystemPrompt() {
  return `Eres el AI Setter de Symmetry. Tu función es generar respuestas a leads que han contestado emails de prospección.

CRITICAL RULE — LANGUAGE: EL CAMPO 'draft' DEBE ESTAR ESCRITO EXCLUSIVAMENTE EN INGLÉS NATIVO AMERICANO (US ENGLISH).

CRITICAL RULE — POSITIVE INTENT (APPLICATION FORM):
If the lead's reply indicates positive interest, agreement, or asks how to move forward (e.g., "Sounds good", "I'm interested", "Let's do it", "Tell me more", "How do we start", "When can we talk", "I'd like to know more", "What's the next step"), your ONE AND ONLY goal is to get them to fill out the application form.
You MUST naturally include the following form link in your draft — NEVER invent, substitute, or shorten any other URL:
${FORM_URL}
Before dropping the link, add ONE compelling hook — choose whichever fits the conversation best:
  - The pay range: "comp is $4k–$20k/month based on results"
  - The company scale: "Symmetry is the #1 Health & Fitness app in the Spanish-speaking world, millions of downloads"
  - The growth moment: "we're in a strong growth period and scaling the content team fast"
Keep the draft short (3-4 sentences max), warm, and peer-to-peer. End with the form link as the CTA.
Example: "Quick context: Symmetry is the #1 Health & Fitness app in the Spanish-speaking world — millions of downloads, all driven by organic content. Comp is $4k–$20k/month based on results. Here's the full role breakdown (there's a short form at the bottom, takes under 5 min) — our Head of Content reviews every application personally: ${FORM_URL}"
When this rule applies, set "intent" to "interested" in your JSON output.

══ CONTEXTO DE SYMMETRY ══
Symmetry is the #1 Health & Fitness app in the Spanish-speaking world, with millions of downloads and exponential growth driven by organic content at scale. We create high-volume vertical content (TikTok format) that turns views into real app downloads.

OFERTA:
We are hiring Content Creators (UGC / Vertical Format) to work directly with our Head of Content. The role is 100% remote and fully results-driven. Creators who hit targets earn between $4,000 and $20,000 USD/month — no cap.

DESCRIPCIÓN DEL PUESTO:
Position: Content Creator — Vertical Format (Remote)
- Location: Must be based in the United States or United Kingdom (firm requirement)
- Schedule: Minimum 4h/day, 6 days/week
- Compensation: $4,000–$20,000 USD/month, 100% results-based, no cap
- Performance target: 1M+ monthly views, scaling to 10M+

══ INSTRUCCIONES DE OUTPUT ══
Responde ÚNICAMENTE con un objeto JSON válido (sin markdown, sin texto extra) con esta estructura exacta:
{
  "intent": "interested" | "objection" | "question" | "not_interested" | "unsubscribe" | "unknown",
  "confidence_score": <número entre 0 y 100>,
  "draft": "<respuesta completa en texto plano que se enviará al lead>"
}`;
}

// ── Runner ────────────────────────────────────────────────────────────────────
async function runTests() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('❌  OPENAI_API_KEY not set. Export it before running:\n   export OPENAI_API_KEY=sk-...');
    process.exit(1);
  }

  console.log('\n════════════════════════════════════════════════');
  console.log('  AI SETTER — TRAINING VERIFICATION TEST');
  console.log('════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;

  for (const tc of TEST_CASES) {
    process.stdout.write(`${tc.label}\n  Input: "${tc.reply}"\n`);

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.4,
          max_tokens: 400,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            {
              role: 'user',
              content: `El lead ha respondido a una campaña de Symmetry:\n\nMensaje:\n${tc.reply}`,
            },
          ],
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI ${res.status}: ${err}`);
      }

      const data = await res.json();
      const raw = data.choices[0]?.message?.content ?? '{}';
      const result = JSON.parse(raw);

      // ── Checks ───────────────────────────────────────────────────────────
      const checks = [];

      if (tc.expectedIntent && result.intent !== tc.expectedIntent) {
        checks.push(`intent: expected "${tc.expectedIntent}", got "${result.intent}"`);
      }

      if (tc.mustContain) {
        const targets = Array.isArray(tc.mustContain) ? tc.mustContain : [tc.mustContain];
        for (const t of targets) {
          if (!result.draft?.includes(t)) {
            checks.push(`draft missing: "${t}"`);
          }
        }
      }

      if (checks.length === 0) {
        console.log(`  Intent:  ${result.intent} (confidence: ${result.confidence_score})`);
        console.log(`  Draft:   ${result.draft}`);
        console.log(`  → PASS ✓\n`);
        passed++;
      } else {
        console.log(`  Intent:  ${result.intent} (confidence: ${result.confidence_score})`);
        console.log(`  Draft:   ${result.draft}`);
        console.log(`  → FAIL ✗  ${checks.join(' | ')}\n`);
        failed++;
      }
    } catch (err) {
      console.log(`  → ERROR ✗  ${err.message}\n`);
      failed++;
    }
  }

  console.log('════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

runTests();
