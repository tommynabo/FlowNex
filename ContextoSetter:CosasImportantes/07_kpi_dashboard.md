# KPI Dashboard — Sistema Cold Outreach Symmetry

Este documento es el **mapa único de todos los KPIs del sistema**. Si dudas alguna vez "¿qué medimos aquí?" o "¿cuál es el norte?", este es el documento.

Pega esta tabla en la wall del equipo. Léela cada lunes antes de tomar decisiones de iteración.

---

## 1. EL ÚNICO KPI QUE IMPORTA (north-star)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   FORMS COMPLETED  /  POSITIVE REPLIES                      │
│                                                             │
│   Baseline:  ~0%                                            │
│   Target:    ≥30% (primer test)                             │
│   Stretch:   ≥40%                                           │
│   Benchmark: 35-50% (OSS, comparable systems)               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Cualquier cambio en el sistema se evalúa contra este número.** Si una variante mueve este KPI arriba, gana. Si no lo mueve o lo mueve abajo, pierde — independientemente de cómo afecte a métricas secundarias.

**Por qué es el único que importa**: el cold ya funciona (54% open, 24% positive reply). El cuello de botella es post-reply. Mover este número es mover la métrica de aplicantes cualificados completos hacia arriba sin tocar volumen.

---

## 2. KPI estratégico downstream (lo que en realidad nos paga)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   QUALIFIED APPLICANTS PER 100 COLD EMAILS SENT             │
│                                                             │
│   Fórmula: (open × pos_reply × form_complete × qualif)/100  │
│   Baseline estimado: <1                                     │
│   Target a 30% form rate: ~3                                │
│   Stretch a 40% form rate: ~5                               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Este es el KPI que conecta el sistema de outreach con el resto del negocio. Es el output que el equipo de Head of Content recibe y filtra a las siguientes etapas (CV review → entrevista 15 min → prueba 48h → entrevista 30 min → contratación).

---

## 3. KPIs guardrail (no degradar bajo ningún concepto)

| KPI | Baseline actual | Mínimo aceptable | Acción si cae |
|---|---|---|---|
| Open rate (Step 1 cold) | 54% | ≥50% | Auditar entregabilidad (dominios, warm-up) |
| Positive reply rate / 100 enviados | 24% | ≥20% | Revisar cambios recientes al cold; rollback si necesario |
| Bounce rate | <3% (asumido) | <3% | Pausar campaña, limpiar lista, revisar dominios |
| Spam complaints | ~0% | <0.1% | Pausar inmediatamente, auditar copy y listas |

**Regla**: si una variante mueve la north-star arriba pero rompe un guardrail, NO se promueve. Los guardrails protegen la salud del canal a largo plazo.

---

## 4. KPIs por fase del funnel

### Fase Cold (gestión Instantly)

| Email | KPI clave | Por qué |
|---|---|---|
| Step 1 | Open rate, Reply rate | Tope del funnel |
| Step 2 | Incremental reply rate (positive replies sólo de Step 2) | Mide si vale la pena el segundo touch |
| Step 3 (nuevo) | Incremental reply rate | Mide si vale la pena el tercer touch |

### Fase Setter (post-positive-reply, 1ª respuesta)

| Branch | KPI principal | KPI secundario |
|---|---|---|
| A — Interest | Form completion rate post-Loom | % de Loom visto |
| B — Per-post objection | Form completion rate + % re-objection en WFU | Es la rama más cara, máxima atención |
| C — Time concern | Form completion rate | Detecta si la objeción es real o un proxy de otra cosa |
| D — Authority skepticism | Form completion rate post-Loom | Loom debería tener máximo lift aquí |
| E — Specific question | Form completion rate por sub-categoría | Granular para detectar candidatas a nueva rama |
| F — Not interested | n/a (cierre) | Solo trackear volumen para mejorar ICP filtering |

### Fase Warm follow-up (post-positive-reply, sin form en X días)

| Touch | KPI principal | Por qué |
|---|---|---|
| WFU1 (día +2) | % de form fills en 48h post-WFU1 | Mide si un nudge basta |
| WFU2 (día +5) | % de form fills atribuibles a Loom personalizado | Valida ROI del Loom personalizado |
| WFU3 (día +9) | % form fills + % objections "per-post" detectadas | Reframe explícito |
| WFU4 (día +14) | reply rate (cualquier respuesta) | Pattern interrupt |
| WFU5 (día +21) | % aplicaciones "last-minute" | Breakup effect |

**KPI agregado del Warm**: cumulative form completion rate a los 21 días desde la 1ª respuesta del setter.

---

## 5. KPIs operacionales (calidad del sistema)

| KPI | Por qué importa | Target |
|---|---|---|
| Tiempo medio de revisión humana de drafts del setter | Si > 2 min/draft, el sistema no escala a 500/día | <90 segundos |
| % de drafts del setter aprobados sin editar | Mide calidad del FlowNext | ≥70% |
| % de drafts editados sustancialmente antes de enviar | Si > 30%, las plantillas necesitan revisión | <30% |
| Cobertura de ramas del setter | % de positive replies clasificadas correctamente en una rama A-F (no "otro") | ≥90% |
| Lag entre positive reply y respuesta del setter | Velocidad de respuesta = factor crítico en cold outreach | <30 min en horario laboral, <12h fuera |

---

## 6. KPIs de iteración (cuánto y qué rápido mejoramos)

| KPI | Por qué | Cadencia |
|---|---|---|
| Nº de A/B tests activos | Mantener sistema en mejora continua | 1-3 simultáneos máximo |
| Tiempo medio de un test (start → decision) | Iteramos rápido si volumen lo permite | 1-2 semanas |
| Nº de nuevas ramas del setter añadidas | Sistema vivo, aprendiendo | 1-2 / mes en estado maduro |
| % de objections capturadas por una rama específica vs catch-all (Branch E) | Madurez del árbol | ≥80% |

---

## 7. La pirámide de KPIs (de qué hablamos cuando hablamos del sistema)

```
                          QUALIFIED APPLICANTS / 100 EMAILS
                                       │
                                       │ (downstream KPI)
                                       │
                       FORMS COMPLETED / POSITIVE REPLIES        ← NORTH STAR
                                       │
                                       │ (the metric we optimize)
                                       │
                ┌──────────────────────┼──────────────────────┐
                │                      │                      │
            Cold open/reply       Setter branch        Warm follow-up
              (guardrail)         conversion           conversion
                │                      │                      │
            instrumentation        copy quality         sequence design
                │                      │                      │
            sender setup         FlowNext quality      Loom + tone calibration
```

Cada decisión del sistema se conecta a un nodo de esta pirámide. **Si una propuesta no encaja en ningún nodo, probablemente no debería implementarse.**

---

## 8. Reporting cadence

| Vista | Cadencia | Owner | Acción típica |
|---|---|---|---|
| North-star + guardrails | Diaria | Owner FlowNext | Detectar regresiones rápido |
| KPIs por rama | Semanal | Owner FlowNext | Decidir iteraciones de copy |
| Test A/B decisions | Semanal (cuando hay tests activos) | Owner sistema | Promote / kill / extend |
| Pirámide completa | Mensual | Equipo + founder | Decisiones estratégicas (volumen, dominios, escalado) |

---

## 9. Anti-patterns (lo que NO es un KPI relevante)

Para evitar perder el foco en métricas vanity:

❌ **Open rate** alto. Ya estamos al 54%. Más open rate no ayuda si no se convierte.
❌ **Click rate** sin context. El tracking actual está roto y aunque se arregle, clicks ≠ conversions.
❌ **Volume of emails sent**. Sin tasa de conversión, mandar más es mandar más bounces.
❌ **Reply rate** total. Solo importa el reply POSITIVO clasificado por FlowNext.
❌ **Loom views absoluto**. Importa el % de Loom visto + form completion rate post-view.
❌ **Length of WFU sequence**. 5 vs 8 emails no es un KPI, es un parámetro.

---

## 10. Mapa de referencia — qué medimos en cada paso del túnel

Esta sección es la **tarjeta de consulta rápida**. Cuando dudes "¿qué se mide aquí?", esta es la respuesta. Sin valores baseline, sin objetivos — solo qué métricas existen en cada paso del funnel y qué pregunta responden.

---

### Túnel completo de un vistazo

```
   ┌─────────────────────────────────────────────────────────┐
   │  COLD SEQUENCE  (Instantly, automatizada)               │
   │  ────────────────────────────────────────────────────   │
   │  Step 1 (día 0)   →   Step 2 (día +2)   →   Step 3 (+5) │
   └─────────────────────────────────────────────────────────┘
                              │
                              │ positive reply (en cualquier step)
                              ↓
   ┌─────────────────────────────────────────────────────────┐
   │  SETTER FIRST RESPONSE  (FlowNext + humano)             │
   │  ────────────────────────────────────────────────────   │
   │  Branch A  Branch B  Branch C  Branch D  Branch E  ...  │
   └─────────────────────────────────────────────────────────┘
                              │
                              │ no form fill en X días
                              ↓
   ┌─────────────────────────────────────────────────────────┐
   │  WARM FOLLOW-UP SEQUENCE  (FlowNext + humano)           │
   │  ────────────────────────────────────────────────────   │
   │  WFU1 (+2)  WFU2 (+5)  WFU3 (+9)  WFU4 (+14)  WFU5 (+21)│
   └─────────────────────────────────────────────────────────┘
                              │
                              │ form completed
                              ↓
                       APPLICANT FUNNEL
                       (CV → entrevista → prueba → contratación)
```

---

### Qué medimos en cada paso

#### Fase COLD (gestionada por Instantly)

| Step | Métricas a medir | Pregunta que responde cada métrica |
|---|---|---|
| Step 1 (día 0) | Sent volume | ¿Cuánto envío? |
|  | Open rate | ¿Llega y se lee? |
|  | Reply rate total | ¿Genera respuesta de cualquier tipo? |
|  | Positive reply rate | ¿Genera respuesta con interés real? |
|  | Bounce rate | ¿Está la lista limpia y los dominios saludables? |
|  | Spam complaint rate | ¿Estamos quemando reputación de envío? |
| Step 2 (día +2) | Incremental positive replies (atribuidas sólo a Step 2) | ¿Vale la pena este segundo touch? |
|  | Open rate de Step 2 | ¿Sigue llegando o se está filtrando? |
|  | Cumulative positive reply rate (Step 1 + Step 2) | ¿Cómo va el cold en total? |
| Step 3 (día +5) | Incremental positive replies (atribuidas sólo a Step 3) | ¿Vale la pena el tercer touch? |
|  | Cumulative positive reply rate (los 3 steps) | ¿Cuál es el techo de positive reply del cold? |

#### Fase SETTER FIRST RESPONSE (gestionada por FlowNext)

| Branch | Métricas a medir | Pregunta que responde |
|---|---|---|
| Todas | Branch classification accuracy | ¿FlowNext clasifica bien o mete cosas en "otro"? |
|  | Lag entre positive reply y setter send | ¿Cuánto tarda el sistema en responder? |
|  | % de drafts aprobados sin editar | ¿FlowNext está produciendo respuestas usables? |
| Branch A — Interest | Volume | ¿Cuántos leads son "interés sin objeción"? |
|  | Form completion rate | ¿Convierte la rama por defecto? |
|  | Median time-to-form | ¿Cuánto tarda el lead en aplicar tras la respuesta? |
|  | Loom view rate | ¿Se está viendo el Loom que se manda? |
|  | % de Loom visto (de Loom analytics) | ¿Se ve completo o se abandona? |
| Branch B — Per-post objection | Volume | ¿Qué frecuencia tiene la objeción crítica? |
|  | Form completion rate | ¿El reframe explícito funciona? |
|  | Re-objection rate (vuelve a objetar después) | ¿El reframe "se queda" o reaparece? |
|  | Median time-to-form | ¿Convierten rápido o se cocinan? |
| Branch C — Time concern | Volume | ¿Cuántos leads se asustan por el commitment? |
|  | Form completion rate | ¿El framing del compromiso convence? |
|  | Median time-to-form |  |
| Branch D — Authority skepticism | Volume | ¿Cuánto pesa el brand-gap en US/UK? |
|  | Form completion rate | ¿La prueba social + Loom resuelven la duda? |
|  | Loom view rate | El Loom es crítico aquí — ¿se ve? |
| Branch E — Specific question | Volume | ¿Cuántos preguntan algo concreto? |
|  | Form completion rate por sub-categoría | ¿Hay sub-categorías que merecen su propia rama? |
| Branch F — Not interested | Volume | ¿Cuántos cierran limpiamente? Útil para mejorar ICP. |

#### Fase WARM FOLLOW-UP (gestionada por FlowNext)

| Touch | Métricas a medir | Pregunta que responde |
|---|---|---|
| WFU1 (día +2) | Open rate | ¿Sigue el thread caliente o ya se enfrió? |
|  | Reply rate | ¿Activa diálogo? |
|  | Form completion rate en 48h post-WFU1 | ¿Basta un nudge para cerrar? |
| WFU2 (día +5, Loom personalizado opcional) | % de leads que recibieron el Loom personalizado | ¿A cuántos se les llegó a aplicar el high-touch? |
|  | Form completion rate de leads con Loom personalizado | ¿Vale el coste de tiempo del founder? |
|  | Loom view rate del personalizado | ¿Se ve? |
| WFU3 (día +9) | Form completion rate | ¿El reframe explícito tardío recupera leads? |
|  | % de leads que plantean per-post objection tras este touch | ¿Estamos sembrando o resolviendo la objeción? |
| WFU4 (día +14) | Reply rate (cualquier respuesta) | ¿El pattern interrupt activa al lead silencioso? |
|  | Form completion rate post-WFU4 |  |
| WFU5 (día +21) | Form completion rate "last minute" (0-2 días post-send) | ¿Hay efecto breakup? |
|  | Archive rate | ¿Qué porcentaje de leads acaba archivado? |
| Sequence agregado | Cumulative form completion rate a 21 días desde 1ª respuesta del setter | ¿Cuánto rescata el Warm en total? |

#### Composite (norte y downstream)

| KPI | Fórmula | Pregunta que responde |
|---|---|---|
| **Forms completed / positive replies** | forms / positive replies | El norte. ¿Estamos convirtiendo el interés en aplicación? |
| Qualified applicants / 100 cold emails | (open × pos_reply × form_complete × qualif_rate) | ¿Cuál es el output real del sistema a la empresa? |
| Qualified applicants / mes | qualified applicants × 30 | El output absoluto en escala. |

#### Operacionales (calidad del sistema)

| Métrica | Pregunta que responde |
|---|---|
| Avg setter draft review time | ¿Escala el sistema con el volumen objetivo? |
| % drafts approved without edit | ¿FlowNext está bien calibrado? |
| % drafts edited substantially | ¿Hay ramas que necesitan re-redacción? |
| Branch coverage (% de positive replies bien clasificadas) | ¿El árbol es exhaustivo o tenemos blind spots? |
| Lag positive reply → setter send | ¿Respondemos rápido? |

#### Iteración (salud del proceso de mejora)

| Métrica | Pregunta que responde |
|---|---|
| # A/B tests activos | ¿Estamos iterando o congelados? |
| Tiempo medio de A/B test | ¿Decidimos rápido o se nos pudren? |
| # nuevas ramas / mes | ¿El sistema está aprendiendo del mercado? |
| % objections capturadas por rama específica vs Branch E catch-all | ¿La madurez del árbol va subiendo? |

---

### Cómo usar este mapa

- **Antes de tomar una decisión**: identifica qué métrica de esta tabla afecta tu decisión. Si no afecta a ninguna, probablemente no merece el cambio.
- **Antes de proponer un test A/B**: identifica QUÉ métrica de esta tabla debe moverse para que el test sea un éxito. Escríbelo en el plan del test.
- **En reuniones de revisión**: usa esta tabla como agenda. Recórrela paso a paso del túnel. Es el ritual de health-check del sistema.
- **Cuando entres a iterar copy**: localiza la rama o el touch en esta tabla, mira qué KPIs específicos lo gobiernan, y optimiza contra ellos — no contra impresiones subjetivas del texto.

Si no podemos contestar a las preguntas de la columna derecha con datos, **el problema es de instrumentación**, no de estrategia. Ir a `05_instrumentation_checklist.md`.
