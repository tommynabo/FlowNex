# Rationale — Sistema de Cold Outreach para Content Creators (Symmetry US/UK)

Documento estratégico que justifica cada decisión del sistema diseñado. Léelo primero. El resto de archivos son la ejecución táctica de lo que aquí se explica.

> **¿Quieres verificar de dónde sale cada decisión?** Ver [`06_research_evidence.md`](06_research_evidence.md) — explica para cada principio: quién es la fuente, qué dice exactamente, cómo lo aplico aquí, y mi nivel de confianza. Cada decisión es trazable o explícitamente marcada como mi criterio.
>
> **¿Quieres ver todos los KPIs del sistema de un vistazo?** Ver [`07_kpi_dashboard.md`](07_kpi_dashboard.md) — el norte único, los guardrails, los KPIs por fase y por rama, las pirámides de medición. Si alguna vez no sabes qué métrica importa, ese doc lo aclara.

## El KPI norte (recordatorio constante)

```
FORMS COMPLETED / POSITIVE REPLIES    Baseline: ~0%   Target: ≥30%   Stretch: ≥40%
```

**Toda decisión de este documento existe para mover este número.** Si una propuesta no lo mueve, no debería estar aquí.

---

## 1. Diagnóstico del estado actual

Datos baseline (ventana 7 días, n=79 secuencias, campaña FlowNextOmega):

| Métrica | Valor actual | Lectura |
|---|---|---|
| Open rate | 54,43% | Excelente. No es el cuello de botella. |
| Reply positivo | ~24% (19/79) | Excelente. Top of funnel funciona. |
| Form completado / positive reply | ~0% (muy bajo) | **El agujero**. Aquí se pierde casi todo. |
| Click tracking | 0% (no fiable) | Problema de instrumentación, no de tráfico real. |

**El sistema actual no tiene un problema de captación de interés. Tiene un problema de conversión post-reply.**

Causas detectadas:
1. La palabra **"collab"** en asunto y cuerpo del email 1 enmarca la propuesta como una colaboración de marca, no como un puesto. Esto se confirma por la **objeción crítica recurrente**: muchos leads responden con su "rate per post" en lugar de aplicar al rol.
2. El **AI Setter manda un mensaje casi genérico** independientemente de lo que diga el lead. No hay ramas. No hay handling de objeciones. Funciona como reenvío de link.
3. **No hay warm follow-ups** después de la positive reply. Si el lead no rellena el form en la primera interacción, se pierde.
4. **Symmetry no tiene autoridad de marca en US/UK** → empresa desconocida + compromiso enorme (4h/día × 6 días, $4–20k/mes performance-based) → necesita prueba social y autoridad antes del ask.

## 2. Benchmark de referencia

OSS (JKD Agency, comunidad de Skool) reporta **35-50% de conversion rate de positive reply → booked appointment** en cold outreach high-ticket B2B. Esto es nuestro objetivo equivalente: positive reply → form completado.

Si pasamos de ~0% a 30%, manteniendo 24% de positive reply rate, sobre 500 emails/día (objetivo de escalado):
- 500 × 24% = 120 positive replies/día
- 120 × 30% = 36 form submissions/día
- 36 × ~25% qualification rate = 9 qualified applicants/día → ~270/mes

Eso es **~10x el volumen actual** de aplicantes cualificados, sin tocar el volumen de envío.

## 3. Principios extraídos de Skool aplicados a este caso

| Principio (Skool)                                                          | Aplicabilidad a talent         | Cómo lo aplicamos                                                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personalized line 1 obligatoria                                            | Limitado (solo `{firstName}`)  | Compensamos con un detalle del nicho que el ICP comparte (p. ej. "your hooks on gymtok caught my eye")                                                              |
| CTA condicional "if I could X, would you be open to a short conversation?" | Idéntico                       | Mantenemos esta forma del CTA en cold; sustituimos "short conversation" por "quick chat"                                                                            |
| Brevity (3-5 sentences)                                                    | Idéntico                       | El email 1 se mantiene corto                                                                                                                                        |
| P.S. con diferenciador                                                     | Crítico aquí                   | Añadimos P.S. que preempte la objeción per-post: "this is a paid role on our content team, not a one-off brand collab"                                              |
| Sender = founder, first name only                                          | Idéntico                       | Sender = el fundador                                                                                                                                                |
| 7-branch reply response sheet                                              | Crítico                        | Diseñamos 6 ramas para el AI Setter (ver `02_ai_setter_branches.md`)                                                                                                |
| 8-email warm follow-up sequence                                            | Crítico                        | Creamos warm follow-up de 5 emails (más corto, adaptado al ritmo del proyecto)                                                                                      |
| Loom en touch #4 del warm follow-up, no en el email frío                   | Importante                     | El Loom **no va en cold**; va en la respuesta del setter y se referencia de nuevo en WFU#3                                                                          |
| Loom personalizado > genérico                                              | Importante pero costoso        | Compromiso: **Loom genérico para la primera respuesta del setter** (escalable) + opción de Loom personalizado breve en WFU#3 si el lead se enfría (alto-valor sólo) |
| Frameworks de Loom: "Two reasons" y "PAS"                                  | Crítico                        | Grabamos **2 variantes** y testeamos A/B (ver `03_loom_script.md`)                                                                                                  |
| Calendar link como CTA (no landing)                                        | Cuestiona nuestra arquitectura | Decisión: landing como default (refuerza expectativas), variante A/B con form directo (test)                                                                        |

## 4. Decisiones clave del diseño

### 4.1 No tocar el control del email 1 en producción inmediata
El email 1 actual funciona en métricas de top-of-funnel (54% open, 24% positive reply). Cualquier cambio se prueba como **variante A/B**, no como reemplazo directo.

### 4.2 Reframe "rol/team", no "collab", en las variantes
La hipótesis fuerte es que "collab" siembra la objeción per-post downstream. Las variantes prueban subject + body sin esa palabra.

### 4.3 La gran inversión: AI Setter ramificado
Pasamos de 1 mensaje genérico a **6 ramas** identificables por el setter humano (o por reglas de keyword si se automatiza más adelante). Esto es probablemente el cambio con mayor impacto en la métrica norte.

### 4.4 Warm follow-up sequence de 5 toques
Después de la respuesta inicial del setter, si el lead no aplica en X días, se dispara una secuencia de 5 follow-ups con angles rotativos: nudge, reframe, Loom personalizado opcional, scarcity, breakup. Esto es nuevo en nuestro sistema.

### 4.5 Loom: dónde y qué
- **NO** en el cold email (riesgo de entregabilidad sin upside).
- **SÍ** en la primera respuesta del setter (Branch A — interest sin objeción). Aquí es donde "vende" la empresa antes de pedir el form.
- **SÍ** referenciado de nuevo en WFU#3 si el lead se enfría.
- Dos variantes para A/B: "Two reasons" y "PAS".

### 4.6 Destino del CTA
- **Default**: link a la landing (`https://symmetry.club/roles/ugc-creator-en`) con anchor que lleve directo a la sección del form (`#apply` u otro identificador en la landing).
- **Variante A/B**: link directo al formulario, sin landing intermedia. Testear conversion neta.

### 4.7 Instrumentación primero
Antes de tomar decisiones por métricas, hay que arreglar el tracking de clics (hoy 0% = no fiable). Sin esto las decisiones se toman a ciegas. Ver `05_instrumentation_checklist.md`.

## 5. Lo que NO hacemos (y por qué)

- **No** mandamos Loom en cold. Aumenta el riesgo de spam y los datos de OSS/EasyGrow no muestran que el Loom en cold supere al texto plano cuando el cold ya genera reply rates altos. Nuestro 24% positive reply ya es excepcional.
- **No** automatizamos llamadas (no tenemos infra de phone calling y el rol no la necesita). OSS lo hace porque su conversión final es una call con un sales rep; la nuestra es un form.
- **No** rediseñamos la landing en esta fase. La página de venta existente está bien diseñada y establece bien las expectativas según el equipo. Si los tests muestran que es un cuello de botella, se reabre.
- **No** intentamos personalización profunda del cold email en el v1. Mientras el scraper solo entregue `{firstName}`, mantenemos el diseño compatible con eso. Cuando se enriquezca, abrimos un upgrade dirigido.

## 6. Plan de despliegue (orden lógico)

1. **Semana 1**: arreglar tracking (instrumentation_checklist).
2. **Semana 1**: grabar las 2 variantes del Loom.
3. **Semana 1**: implementar el árbol de respuestas del AI Setter en FlowNext (humano-en-loop sigue activo).
4. **Semana 1**: diseñar y subir la warm follow-up sequence a Instantly (o donde se ejecute).
5. **Semana 2**: lanzar con el AI Setter ramificado + warm follow-up + Loom. Medir.
6. **Semana 2-3**: cuando haya suficiente muestra, empezar tests A/B (orden en `04_ab_plan.md`).
7. **Semana 4+**: iterar variantes ganadoras, escalar hacia 500 emails/día.

## 7. Métrica norte

**Form completado por positive reply.** Objetivo realista primer test: ≥30%. Stretch: 40%.

Métricas guardrail (no degradar):
- Open rate ≥ 50%
- Positive reply rate ≥ 20%
- Bounce < 3%
- Spam complaints ~0%

## 8. Documentos de este sistema

- `00_rationale.md` ← este documento (estrategia + decisiones de diseño)
- `01_secuencia_instantly.md` — cold email + warm follow-up sequence
- `02_ai_setter_branches.md` — árbol de respuestas + protocolo de evolución
- `03_loom_script.md` — guiones de los dos Looms (talking head)
- `04_ab_plan.md` — plan de A/B testing
- `05_instrumentation_checklist.md` — checklist de tracking + reporting
- `06_research_evidence.md` — fuentes, citas y trazabilidad de cada decisión
- `07_kpi_dashboard.md` — mapa único de todos los KPIs del sistema
