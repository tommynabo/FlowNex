# Secuencia Cold Email — Instantly (FlowNextOmega)

Cold sequence sent from a founder-led account. All copy in English (US/UK audience).
Subject lines kept lowercase-ish, conversational, max 5 words.

Variables: `{{firstName}}`. Add more only when scraper enriches.

---

## TL;DR — Cómo navegar este documento

Este documento contiene **DOS secuencias distintas** que conviven en paralelo. Entenderlas por separado es crítico antes de tocar nada:

### Secuencia 1: COLD (frío, automatizada en Instantly)
- A quién va: leads recién extraídos del scraper que NO han respondido nada nunca.
- Quién la envía: **Instantly** (automatizado, sin humano en cada send).
- Cuándo se dispara cada email: en función del tiempo desde el primer contacto, no de la acción del lead.
- 3 emails: Step 1 (día 0) → Step 2 (día +2 si no responde) → Step 3 (día +5 si no responde).
- **Si el lead responde en cualquier momento, esta secuencia se pausa.** A partir de ahí lo gestiona el setter.

### Secuencia 2: WARM (post-positive-reply, gestionada por el setter)
- A quién va: leads que **YA respondieron positivamente** al cold y recibieron la primera respuesta del setter, pero NO han rellenado el formulario.
- Quién la envía: **el setter** (humano + AI draft). Aclaración importante abajo en su sección.
- Cuándo se dispara cada email: en función de los días desde la primera respuesta del setter, no del cold inicial.
- 5 emails: WFU1 (día +2 desde la respuesta del setter) → WFU2 → WFU3 → WFU4 → WFU5 (día +21).
- **Si el lead responde o rellena el form, se pausa.**

### Visualización del túnel completo

```
DÍA 0    →    Step 1 (Cold)             [Instantly]
   |
   | no reply → DÍA +2 → Step 2 (Cold)  [Instantly]
   |              |
   |              | no reply → DÍA +5 → Step 3 (Cold)  [Instantly]
   |              |              |
   |              |              | no reply → END (lead dropped)
   |              |
   | positive reply en cualquier punto del cold
   ↓
PRIMERA RESPUESTA DEL SETTER (Branch A/B/C/D/E/F — ver 02_ai_setter_branches.md)
   |
   | form filled → END (success, candidate enters funnel)
   |
   | no form filled → DÍA +2 (desde setter) → WFU1   [Setter]
   |                       |
   |                       | DÍA +5 → WFU2 (Loom personalizado opcional)
   |                       | DÍA +9 → WFU3
   |                       | DÍA +14 → WFU4
   |                       | DÍA +21 → WFU5 (breakup)
   |                              |
   |                              → END (no fill, lead archived)
```

### KPIs que mide esta secuencia

| Donde aplica        | KPI                                                       | Baseline            | Objetivo                                   |
| ------------------- | --------------------------------------------------------- | ------------------- | ------------------------------------------ |
| Cold completo       | Open rate del Step 1                                      | 54%                 | ≥50% (guardrail)                           |
| Cold completo       | Positive reply rate por 100 emails enviados               | 24%                 | ≥20% (guardrail)                           |
| Cold Step 3 (nuevo) | % de positive replies que vienen de Step 3 sobre el total | n/a (no existe hoy) | medir, conservar si aporta ≥5% incremental |
| Warm sequence       | **Form completed / positive reply** (north-star)          | ~0%                 | **≥30%** primer test, **≥40%** stretch     |
| Warm sequence       | Tiempo medio desde positive reply → form completed        | n/a                 | medir y reducir over time                  |

---

## STEP 1 — Cold opener (Day 0)

### Control (current production — DO NOT TOUCH)

**Subject:** `{{firstName}}, collab?`

**Body:**
```
Hi {{firstName}},

Came across your content while looking for fitness creators in the US — really strong stuff.

We're building out the content team at Symmetry (top Health & Fitness app in the Spanish-speaking world, +1M downloads) and we're looking for creators who can produce high-volume vertical content. Comp is $4k–$20k/month based on results, fully remote.

Worth a quick chat?
```

---

### Variant A — "role" reframe (anti-collab hypothesis)

**Subject:** `{{firstName}}, content role`

**Body:**
```
Hi {{firstName}},

Came across your content while looking for fitness creators in the US — really strong stuff.

We're hiring for the content team at Symmetry (top Health & Fitness app in the Spanish-speaking world, +1M downloads, $1M+ ARR). Looking for creators who can produce high-volume vertical content. Performance-based comp $4k–$20k/month, fully remote.

This is a role on our team — not a one-off brand collab.

Worth a quick chat?
```

**What changes vs control:**
- Subject: `collab` → `content role`
- Body: "building out" → "hiring for", adds $1M+ ARR
- New line: explicit "role on our team — not a one-off brand collab" preempts the per-post objection

---

### Variant B — "quick one" minimalist (test if subject ambiguity wins)

**Subject:** `{{firstName}}, quick one`

**Body:** Same as Variant A body.

**Hypothesis:** the ambiguous subject keeps open rate high (no obvious "this is a pitch" signal) while the body does the framing work.

---

### Variant C — long-form with proof (test if more context closes more loops)

**Subject:** `{{firstName}}, content role`

**Body:**
```
Hi {{firstName}},

Came across your content while looking for fitness creators in the US — really strong stuff.

Quick context: Symmetry is the #1 Health & Fitness app in the Spanish-speaking world (+1M downloads, $1M+ ARR). We grew entirely from organic short-form video — no paid ads. Now we're expanding to US/UK and hiring creators to do the same here.

This is a full role on our content team. Performance-based comp $4k–$20k/month. 4h/day, 6 days/week, fully remote.

Not a brand collab — an actual paid position on the team.

P.S. We don't pay for hours, we pay for downloads. Top performers do 4h days and hit $20k/mo.

Worth a quick chat?
```

**Sobre la P.S. (aclaración del razonamiento):** sustituye al risk reversal monetario que usan OSS/Imperium ("you don't pay unless results"). En su caso, el risk reversal va dirigido al prospecto que arriesga dinero. En el nuestro, el creador arriesga tiempo y esfuerzo. La P.S. equivalente debe darle confianza de que el upside es real y proporcional al esfuerzo, no inflado ni capeado por política interna. "No pagamos por horas, pagamos por descargas" comunica eso en una frase.

**Hypothesis:** the longer email cuts the per-post objection at the source by establishing context, expectations, and risk reversal upfront. It may lower open rate slightly but raise quality of replies.

---

## STEP 2 — Follow-up #1 (Day +2, no reply to step 1)

### Control (current production — DO NOT TOUCH)

**Subject:** (no subject — same thread)

**Body:**
```
hey {{firstName}},

Just bumping this up in case it got buried.

We're actively scaling the content team right now — reviewing applications this week.

Full role details + short form (takes under 5 min): https://symmetry.club/roles/ugc-creator-en

Our Head of Content reviews every application personally and gets back fast.

Worth a look?
```

---

### Variant A — reframe + slight social proof bump

**Body:**
```
hey {{firstName}},

Bumping this up in case it got buried.

To be clear — this isn't a brand collab. It's a paid position on our content team, $4–20k/mo based on what you produce. Same model that took our ES creators from 0 to 8-figure runs.

Full details + short form (under 5 min): https://symmetry.club/roles/ugc-creator-en

Our Head of Content reviews every application personally.

Worth a look?
```

---

## STEP 3 — Follow-up #2 (Day +5, no reply to step 1 or 2) — NEW

This step does not exist in current production. Add as test.

**Subject:** (no subject — same thread)

**Body:**
```
hey {{firstName}},

Last bump on my end.

Honest take: most fitness creators we reach out to don't realize this isn't a sponsorship — it's a real role with real comp. Most who apply end up wishing they'd done it sooner.

If you're open to it, here's the form (5 min): https://symmetry.club/roles/ugc-creator-en

If not, no worries — I'll stop showing up in your inbox.

Best,
[Founder name]
```

**Why add this:** the OSS framework runs 3-4 follow-ups in cold sequences with rotating angles. This step adds a "scarcity + breakup" angle. Low risk — if not converting, drop it.

---

## Delivery & timing

| Step | Day | Trigger | Notes |
|---|---|---|---|
| 1 | 0 | New lead added | Initial cold |
| 2 | +2 | No reply to step 1 | Current control follow-up |
| 3 | +5 | No reply to step 1 or 2 | NEW — breakup |

All from the same sender + dedicated domain stack as today. No HTML, no embedded images, no Loom in cold (deliverability protection).

---

## Variables / personalization slots

Currently only `{{firstName}}` is guaranteed. Design notes for when the scraper enriches:

- `{{nicheSignal}}` — one-line observation tied to the creator's content (e.g. "your transformation reels"). Insert at line 1 of body.
- `{{recentReference}}` — a specific recent post mention if available.
- `{{followerCount}}` — if reliable, can be used in P.S. as "we work with creators from 10k to 1M followers".

Until those exist, the copy above must work with name-only.

---

## Sender setup (FlowNextOmega current infra)

- Domain stack: as currently configured.
- Warm-up: maintain current Instantly warm-up.
- Volume: keep current cadence until variants are validated, then scale toward 500/day.

---

## WARM FOLLOW-UP SEQUENCE (post-positive-reply)

These emails fire AFTER a positive reply is received and the setter has sent the first response (see `02_ai_setter_branches.md` Branch A). If the lead doesn't fill the form within N days, this warm sequence kicks in. Sent from the same setter/founder address as a continuation of the same thread.

### ¿Quién envía esto y cómo? (aclaración importante)

Cuando digo "lo manda el setter, no Instantly", **NO** quiero decir que cada email se escribe a mano cada vez. Quiero decir lo siguiente:

- El **Cold** corre 100% automatizado en Instantly. Una vez configurada la secuencia, Instantly dispara los Steps 1, 2 y 3 sin intervención humana.
- El **Warm** corre a través del **setter** (FlowNext + humano-en-loop). La diferencia es que cada WFU pasa por la lógica de FlowNext (AI draft + revisión humana antes de enviar) en lugar de salir disparado de Instantly directamente.

**Por qué la diferencia importa:**
1. El Warm va en respuesta a una conversación viva. Si el lead respondió algo nuevo entre WFU1 y WFU2, queremos que FlowNext lo detecte y rame a una respuesta personalizada (no que mande el WFU2 ciegamente).
2. Mantener el WFU en el setter preserva el contexto del hilo de email (mismo thread, mismo founder address, mismo tono).
3. Si una WFU lleva un Loom personalizado (WFU2), eso requiere acción humana que Instantly no puede automatizar.

**Opciones de implementación según tu infra actual de FlowNext:**

- **v1 (recomendado)**: FlowNext detecta "positive_reply_but_no_form_fill" como estado y lanza un draft de WFU automático en el día programado. Un humano lo revisa en <1 min y lo aprueba (mismo workflow que las branches del setter). Esto es lo más cerca a "auto" sin perder calidad.
- **v2 (más automatizado)**: cuando los WFUs estén estables y validados con datos, se pueden mandar SIN revisión humana en los días programados (excepto WFU2 con Loom personalizado, que siempre requiere humano). FlowNext sigue siendo quien los envía técnicamente, pero el humano solo interviene en excepciones.
- **alternativa no recomendada**: meter el Warm como una secuencia independiente en Instantly. **No lo hagas en v1** porque pierdes la integración con el thread del cold y la lógica de pausar si el lead responde.

En resumen: el Warm fluye técnicamente por FlowNext (mismo motor que las branches del setter), no por Instantly. Tu pregunta era correcta: la diferencia clave vs. el Cold es que no es "ciego automatizado por tiempo", sino "automatizado pero con awareness del estado de la conversación".

### Cadence

| WFU  | Day after first setter response | Trigger      | Function                                       |
| ---- | ------------------------------- | ------------ | ---------------------------------------------- |
| WFU1 | +2                              | No form fill | Soft nudge                                     |
| WFU2 | +5                              | No form fill | Personalized Loom (optional, high-value leads) |
| WFU3 | +9                              | No form fill | Reframe + objection preempt                    |
| WFU4 | +14                             | No form fill | Light humor / pattern interrupt                |
| WFU5 | +21                             | No form fill | Breakup                                        |

### WFU1 — Soft nudge (Day +2)

```
hey {{firstName}},

Was the role link useful? Let me know if anything wasn't clear, happy to expand on it.

If you're in, the form takes 5 min: https://symmetry.club/roles/ugc-creator-en

Talk soon.
```

### WFU2 — Personalized Loom (Day +5) — optional for high-value leads

If lead has >100k followers or scraper flagged them as high-fit, the founder records a 30-60s personalized Loom referencing their specific content.

```
hey {{firstName}},

Just recorded this for you: [LOOM_LINK_PERSONALIZED]

30 seconds. Worth a watch.

Form: https://symmetry.club/roles/ugc-creator-en
```

For everyone else, skip WFU2 and go straight to WFU3 at Day +5.

### WFU3 — Reframe + objection preempt (Day +9, or +5 if WFU2 skipped)

```
hey {{firstName}},

Realized I might not have made this clear enough up front: this is a paid role on the content team, not a brand collab. Base comp $4k/mo plus performance — top folks hit $20k/mo.

If that wasn't on your radar, here's the form: https://symmetry.club/roles/ugc-creator-en

Honestly, our Head of Content checks the new submissions every morning. 5 min on your side.
```

### WFU4 — Pattern interrupt (Day +14)

```
{{firstName}}, before I let this go cold —

Are you out, or just busy?

If out, no problem, I'll leave you alone. If busy, the form is here when you're ready: https://symmetry.club/roles/ugc-creator-en

Either way, I'd appreciate a one-word reply so I know.
```

### WFU5 — Breakup (Day +21)

```
{{firstName}}, last one from me.

Closing the loop on this. If the timing isn't right, all good — file me away and reach out when it is.

If it is and you just forgot: https://symmetry.club/roles/ugc-creator-en

Either way, best of luck with what you're working on.

[Founder name]
```

---

## Implementation notes

- WFU sequence runs in the **same email thread** as the original cold + positive reply. Continuity matters.
- If lead replies at any point in WFU, sequence pauses and setter takes over (back to setter branches in `02_`).
- If lead clicks the form link and starts but doesn't finish, that's tracked separately and gets a different micro-flow (out of scope for v1; flag for v2).

---

## KPIs específicos del Warm sequence

| WFU | KPI principal | Por qué importa |
|---|---|---|
| WFU1 | % de form fills en las 48h post-WFU1 | mide si un simple nudge basta |
| WFU2 | % de form fills atribuibles a personalized Loom (cuando se manda) | valida si el Loom personalizado tiene ROI vs su coste de tiempo |
| WFU3 | % de form fills tras WFU3 + % de objections "per-post" que aparecen tras enviarlo | mide si el reframe explícito convierte la objeción tardía |
| WFU4 | reply rate (cualquier reply, sea sí o no) | mide si pattern interrupt activa al lead silencioso |
| WFU5 | % de leads que aplican en el último momento (form fill 0-2 días después) | mide el clásico "última oportunidad" |

**KPI agregado del Warm sequence**: form completions/100 positive replies acumulado a los 21 días. Es el indicador real de si el Warm está moviendo la aguja.

---

## Recordatorio final — la north-star

Todo lo anterior existe para mover **una única métrica**: form completions / positive reply.

Hoy esa métrica está cerca de 0%. Si la subimos a 30%, sin tocar nada más del funnel, el sistema entero produce ~10x los aplicantes cualificados actuales. Cada decisión en este documento se evalúa contra ese único número.
