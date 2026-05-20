# AI Setter — Response Branches (FlowNext)

When a lead positively replies to the cold email, FlowNext (AI setter) generates a draft response, which is reviewed by a human and sent. This document defines **6 branches** the setter chooses from based on the lead's reply.

The current setter behaviour (one generic message) is replaced by this branching logic.

---

## TL;DR — Cómo navegar este documento

- **6 ramas iniciales** (A-F) cubren los patrones de respuesta más comunes que vamos a ver desde el día 1.
- **No son fijas**: el sistema está pensado para crecer. Cada vez que detectamos una objeción nueva que se repite, abrimos una rama (G, H, I...). Ver sección "Evolución del árbol" al final del doc.
- **Cada rama tiene un patrón estructural común** (acknowledge → reframe → CTA único), heredado de OSS (ver `06_research_evidence.md` §4).
- **El humano siempre revisa** antes del send en v1. Cuando una rama esté validada (ver criterios al final), podemos automatizarla.

## KPI norte de este documento

**Form completed / positive reply**. Hoy ~0%, objetivo ≥30%.

Este es el documento con mayor palanca sobre el KPI norte de todo el sistema. Si las ramas funcionan, la conversión sube. Si no, no se mueve nada más.

---

## Principles for the setter

1. **Branch identification first, response second.** Setter must classify the reply before drafting.
2. **One CTA per response**: link to the role page + form.
3. **Loom in Branch A by default.** Other branches add Loom if the reply has objection signals.
4. **First-person founder voice.** All messages signed by the founder.
5. **Threading.** Always reply in the same email thread.
6. **Length cap.** Max ~120 words per response. Brevity preserves the email-style cadence.
7. **No marketing-speak.** Direct, honest, peer-to-peer.

---

## Branch identification — quick triage

| Branch                                    | Triggered when reply contains...                                                            | Priority                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| **A — Interest, no objection**            | "Sounds interesting", "tell me more", "I'm open", "what's the role", no specific objection  | Default                    |
| **B — Per-post / brand-collab objection** | "rate per video/post", "£X per piece", "I work per-post", "what's the budget per video"     | Highest — most common pain |
| **C — Time / commitment concern**         | "how many hours", "is this full-time", "I'm busy", "side gig?"                              | High                       |
| **D — Authority skepticism**              | "is this real", "never heard of you", "who are you", "show me proof"                        | High                       |
| **E — Specific question** (other)         | Any concrete question not in B/C/D — compensation structure, tools, location, contract type | Medium                     |
| **F — Not interested / not a fit**        | "no thanks", "not for me", "I'm based outside US/UK", "I'm signed", explicit decline        | Closeout                   |

If reply matches multiple, prioritize B > D > C > E > A. Branch F always closes — no follow-ups.

---

## Branch A — Interest, no objection (DEFAULT)

This is the most common positive reply. Lead is curious, no specific objection.

**Subject:** (same thread)

**Body:**
```
Glad you're interested {{firstName}}.

Quick context before you dig in — recorded a short video that walks you through what Symmetry is, why we're hiring US/UK creators now, and how the role actually works. Worth 2 minutes:

[LOOM_LINK_GENERIC_TWO_REASONS or LOOM_LINK_PAS — alternated per A/B variant]

If it resonates, here's the form (5 min, our Head of Content reads every one): https://symmetry.club/roles/ugc-creator-en

What questions come up after watching the video? Happy to answer.

— [Founder]
```

**Why it works:**
- Loom sells the company in 60-90s — solves the authority gap before asking for the form.
- The video acts as a one-time investment from the founder's side, generic enough to send to everyone.
- The CTA is the form. The closing question keeps the door open if Loom raises doubts.

---

## Branch B — Per-post / brand-collab objection (HIGHEST PRIORITY)

The lead has interpreted the offer as a per-piece sponsored collab. This is THE objection we keep losing money on.

**Body:**
```
Good question {{firstName}}, and totally fair to ask.

This is different from a brand collab — there's no per-post fee. It's a paid role on our content team. Comp is performance-based: base $4k/mo, scaling up to $20k/mo for top performers, with the upside tied to downloads driven by your videos.

The reason it's not per-piece: you're producing high volume (we built our ES business this way) and we want creators who are scaling with us, not booking one-off campaigns.

Worth seeing how it actually works — short video here that walks through it: [LOOM_LINK_GENERIC]

If you're in, form takes 5 min: https://symmetry.club/roles/ugc-creator-en

Either way, glad you asked the question first.

— [Founder]
```

**Why it works:**
- Acknowledges the question without arguing.
- Reframes the comp model in plain numbers.
- Names the "why not per-piece" explicitly — removes the ambiguity for good.
- Includes Loom because authority is also needed here.

---

## Branch C — Time / commitment concern

Lead is interested but worried about hours or fit alongside other work.

**Body:**
```
Honest answer {{firstName}} — the minimum is 4h/day, 6 days a week. So it works as a part-time role if you protect that time, but it's not a "few hours here and there" kind of thing.

The reason it's that intensive: we test a lot, kill a lot, double down on what works. That pace requires being in the loop daily.

If it fits, this is what most performers tell us: they drop one or two other things and focus here, because the comp scales with their work in a way most creator gigs don't ($4–20k/mo based on results).

Short video that walks through the role: [LOOM_LINK_GENERIC]

Form (5 min): https://symmetry.club/roles/ugc-creator-en

— [Founder]
```

---

## Branch D — Authority skepticism

Lead doesn't know Symmetry and is hesitant. Needs proof before engaging further.

**Body:**
```
Fair pushback {{firstName}}. We're not a name you'd know in the US yet — that's literally why we're hiring US creators.

For context: Symmetry is the #1 Health & Fitness app in the Spanish-speaking world, +1M downloads, $1M+ ARR. App store: https://apps.apple.com/app/symmetry/[ID] (or whatever the official link is). Site: https://symmetry.club

We grew the ES market entirely from organic short-form video, no paid ads. The reason we're going US/UK now is ARPU there is ~2.5x higher and we want to do the same playbook.

Short video where I walk you through it: [LOOM_LINK_GENERIC]

Form when you're ready (5 min): https://symmetry.club/roles/ugc-creator-en

— [Founder]
```

**Why it works:**
- Acknowledges the brand recognition gap head-on rather than dodging.
- Stacks proof: rank, downloads, ARR, business reason.
- Links to public-facing assets (app store + site) for additional verification.
- Loom adds founder-face for further trust.

---

## Branch E — Specific question (other)

Lead asks a concrete question that doesn't fit B/C/D. Answer the question directly, then bridge to the form.

**Template (setter fills in answer):**
```
Good question {{firstName}}.

[1-2 sentences answering the specific question accurately.]

For the full picture: [LOOM_LINK_GENERIC]

Form here (5 min): https://symmetry.club/roles/ugc-creator-en

Any other questions, just hit reply.

— [Founder]
```

**Common sub-cases and quick answers** (setter library):
- *"What's the exact comp structure?"* → "Base $4k/mo + performance bonus tied to download attribution. Top performers hit $20k/mo. We'll explain the exact attribution model on the intro call if you apply."
- *"Where do I need to be based?"* → "US or UK. Other locations don't fit because the content needs to resonate with the local market."
- *"Is this a contractor or employee role?"* → "Contractor for now, with flexibility on structure if you join. We'll discuss on the call."
- *"What tools do you use?"* → "Standard short-form content stack — phones for shooting, CapCut/Premiere for editing, internal Notion/Slack for ops. No fancy gear required, just performance."
- *"Are you hiring multiple people?"* → "Yes, we're building a team — not a single hire. We'll scale based on who performs."

---

## Branch F — Not interested / not a fit

Closeout. Polite, no insistence, leave door open.

**Body:**
```
All good {{firstName}}, appreciate you replying back.

If anything changes — or if you know someone US/UK based who'd be a great fit — feel free to point them this way.

Best with what you're working on.

— [Founder]
```

**Important:** Branch F closes the lead in FlowNext. No warm follow-up sequence is triggered.

---

## Loom variant selection (A/B inside Branch A)

In Branch A, two Loom versions are tested:
- **LOOM_TWO_REASONS** — warm/personal style (see `03_loom_script.md`)
- **LOOM_PAS** — problem-aware style

Initial assignment: 50/50 random per lead. After ~50 form submissions, promote the winner.

---

## Setter workflow (human-in-loop)

1. FlowNext receives reply → classifies branch → drafts response.
2. Human reviewer:
   - Confirms branch is correct (overrides if not).
   - Adjusts copy if needed (don't change the structure, only fix tone or specifics).
   - Approves and sends.
3. Reply is logged with branch label for analytics.
4. If lead doesn't fill form within N days, warm follow-up sequence (`01_secuencia_instantly.md`) triggers automatically.

---

## Setter prompting (for FlowNext)

System prompt to give FlowNext (or whatever LLM powers it):

```
You are an AI sales setter for Symmetry, a fitness app hiring vertical content creators in the US/UK. A lead has positively replied to a cold email. Classify their reply into one of 6 branches:

A — General interest, no specific objection
B — Per-post / brand-collab objection (mentions rate per piece/post/video)
C — Time / commitment concern (asks about hours, full-time, etc.)
D — Authority skepticism (questions who we are, asks for proof)
E — Specific question (any concrete question not in B/C/D)
F — Not interested / decline

Then draft a response using the template for that branch. Keep under 120 words. First-person founder voice. Always include the Loom link and the form link. Always sign with the founder's first name.

If the reply spans multiple branches, prioritize: B > D > C > E > A. F overrides all.
```

---

## Metrics per branch (track in FlowNext)

For each branch, log:
- Number of replies classified into it
- Form-completion rate from that branch
- Average time to form completion
- Drop-off (replies that go silent after setter response)

This gives us empirical priority for which branches need most copy iteration.

---

## Open questions for v2

- Should Branch B trigger a different warm follow-up (more reframe) than Branch A?
- Should we add a Branch G — "asking to schedule a call directly"? Today the system is form-first, but some leads will push for a call before filling the form. Either we redirect to form or add an intro call step.
- Personalized Loom in WFU2 for high-value leads — who qualifies? Define a threshold (followers, niche match, brand signal) in a v2 doc.

---

## Evolución del árbol — protocolo para añadir ramas nuevas (LIVING DOCUMENT)

**El árbol no es fijo.** Es un sistema vivo que crece con la realidad de las respuestas que recibimos. Las 6 ramas iniciales (A-F) son la mejor apuesta basada en lo que ya hemos visto + en frameworks de OSS, pero las objeciones reales del mercado US/UK van a salir cosas que no anticipamos.

**El protocolo para añadir una rama nueva es el corazón operativo de este sistema.** Implementarlo bien es lo que diferencia un setter que mejora cada semana de uno que se estanca.

### Cuándo abrir una nueva rama

Una objeción / patrón de respuesta merece su propia rama cuando se cumple **al menos una** de estas tres condiciones:

1. **Frecuencia**: la misma objeción aparece **3 o más veces en una semana** (o 10+ en un mes a volumen estable).
2. **Conversión rota**: una objeción aparece menos de 3 veces, pero **TODAS las veces que aparece, la conversión a form se rompe** (lead se va silencioso o explícitamente rechaza tras la respuesta genérica). Es señal de que estamos perdiendo una cohorte completa por no tener el reframe correcto.
3. **Alto valor**: aparece en leads con perfil de alto fit (followers altos, contenido viral, US/UK base) — perder a estos por no tener un response específico es muy caro.

### Cómo se documenta una nueva rama (template)

Cuando se decide abrir una rama nueva (G, H, I...), se documenta en este mismo archivo siguiendo este template:

```
## Branch [LETRA] — [Nombre descriptivo]

**Triggered when reply contains:** [palabras/patrones clave]

**Priority:** [alta/media/baja, considerando frecuencia × impacto]

**Detected from real replies:** [fecha de detección + cuántas veces apareció en cuánto tiempo]

**Body:**
\`\`\`
[Template de respuesta — debe seguir el patrón universal: acknowledge → reframe → social proof opcional → CTA único → sign-off]
\`\`\`

**Why it works (hipótesis):**
- [Razón 1]
- [Razón 2]

**Status:** [draft / live / promoted / killed]
```

### Workflow operativo de detección + drafting

1. **Daily/Weekly review** (idealmente weekly, owner = quien gestione FlowNext):
   - Filtrar todas las replies clasificadas como "E — Specific question" o "A — Interest" en la semana.
   - Buscar patrones: ¿hay 3+ leads preguntando lo mismo dentro de una rama? Si sí, candidata a nueva rama.
   - Revisar replies que terminaron en "no form fill" — ¿hay un denominador común en la objeción?

2. **Draft de la nueva rama**:
   - Tomar 3-5 ejemplos reales de la objeción.
   - Identificar la raíz: ¿qué cree el lead que no es cierto? ¿qué cree el lead que es cierto y duda?
   - Escribir el reframe en 1-3 frases siguiendo el patrón universal.
   - Decidir si lleva Loom o no (regla: si la objeción es de autoridad / proof, sí; si es operativa, no).

3. **Test de la nueva rama**:
   - Empezar enviándola sólo cuando aparezca la objeción (no como default).
   - Medir: ¿se completan los forms tras esta respuesta? ¿Reaparece la objeción más tarde?
   - Mínimo 10 sends antes de considerarla validada.

4. **Promote o kill**:
   - Si tras 10 sends la rama tiene una tasa de form completion ≥ que la media del setter → **promote** (estado: live).
   - Si tiene tasa ≤ media → revisar copy y testar variante; segundo intento.
   - Si segundo intento tampoco → **kill** la rama (fallback a Branch E con respuesta específica) y archivar el aprendizaje.

### Mantener el catálogo limpio

- **Máximo 10 ramas activas** en cualquier momento. Más allá de eso, el setter (humano o AI) se vuelve lento clasificando y el coste de mantener > el valor incremental.
- **Si una rama está "dormida"** (no aparece en 4+ semanas seguidas), considerarla retirar — el contexto cambió y probablemente ya no es relevante.
- **Si dos ramas tienen el mismo response final** (ej. ambas terminan con el mismo Loom + mismo form link sin variar el body) → fusionar en una sola.

### Backlog de candidatas a futuras ramas

Esta sección se mantiene viva. Cada vez que el equipo detecte una potencial nueva rama pero aún no cumpla criterios para activarla, se anota aquí. Cuando cumpla criterios, se mueve arriba como Branch G/H/I/...

| Candidata | Trigger pattern | Veces vista | Última vez vista | Acción |
|---|---|---|---|---|
| "Pedir call antes que form" | "can we schedule a call first?" | TBD | TBD | A monitorizar |
| "Want to negotiate equity" | "is there equity?" | TBD | TBD | A monitorizar |
| "Already have brand deals" | "I already have a deal with X" | TBD | TBD | A monitorizar |
| ... | ... | ... | ... | ... |

(Llenar a medida que aparezcan.)

---

## KPIs por rama (instrumentar desde el día 1)

Cada rama debe medirse independientemente. **Sin esta granularidad, no se puede iterar copy con precisión.**

| Métrica por rama         | Fórmula                                                                          | Por qué importa                                                              |
| ------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Volumen**              | nº de replies clasificadas en esta rama / semana                                 | Indica si la rama es relevante a escala                                      |
| **Form completion rate** | forms completados de esta rama / replies en esta rama                            | El indicador clave de si el copy de esta rama funciona                       |
| **Avg time-to-form**     | tiempo medio desde send del setter hasta form completed, por rama                | Detecta ramas que convierten pero lento (puede valer la pena WFU específico) |
| **Drop-off rate**        | replies que van silenciosas tras el send del setter / total replies de esta rama | Detecta ramas con copy que mata la conversación                              |
| **Re-objection rate**    | replies en esta rama que provocan otra objeción del mismo tipo en WFU / total    | Detecta ramas donde el reframe no se ha asentado                             |

**Comparativa relevante**: tasa de form completion de cada rama vs la media del setter completo. Las ramas que sistemáticamente están por debajo de la media son candidatas a re-redactar el copy.

---

## KPIs por rama (banner rápido para owner del setter)

Pega esta tabla en tu dashboard semanal de FlowNext:

```
Branch | Volume (this week) | Form Conv % | Median time-to-form | Status
A      | ___                | ___%        | ___ days           | active
B      | ___                | ___%        | ___ days           | active
C      | ___                | ___%        | ___ days           | active
D      | ___                | ___%        | ___ days           | active
E      | ___                | ___%        | ___ days           | active
F      | ___                | n/a         | n/a                | closeout
[New]  | ___                | ___%        | ___ days           | testing
```

Decisiones que se toman con esta tabla cada semana:
- ¿Hay una rama con Form Conv % < 50% de la media? → revisar copy.
- ¿Hay una rama con Volume creciendo > 20% week over week? → considerar sub-ramificarla o invertir más en su copy.
- ¿Hay una rama "testing" con suficiente data? → promote/kill decision.
