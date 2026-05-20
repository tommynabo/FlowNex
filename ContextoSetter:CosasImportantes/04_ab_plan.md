# A/B Testing Plan

Ordered by **expected impact on the north-star metric: positive reply → form completed**.

Run tests sequentially when possible (one big test at a time per funnel stage) so we don't muddy the signal. Some can run in parallel if they're at different funnel stages.

---

## North-star metric

**Form completions per positive reply** (a.k.a. reply-to-form conversion rate).

Baseline: ~0% today (very low).
Realistic first target: ≥30%.
Stretch target: ≥40%.

## Guardrail metrics (must not degrade)

- Open rate ≥ 50%
- Positive reply rate ≥ 20%
- Bounce rate < 3%
- Spam complaints ~0%

---

## Test 1 — AI Setter ramificado (vs current generic message) — HIGHEST IMPACT

**Hypothesis:** Replacing the single generic setter message with 6 branches (especially the per-post objection handler) will lift reply-to-form by 20+ percentage points on its own.

**Setup:**
- Control: current generic FlowNext message.
- Variant: new branched system from `02_ai_setter_branches.md`.
- Split: 50/50 random per positive reply.
- Sample size minimum: 60 positive replies per arm (≈250 cold emails per arm at 24% reply rate). At current volume of ~80/week, this takes ~3 weeks. At 500/day, ~3 days.

**Decision criterion:** if variant's reply-to-form rate is ≥2x control's after minimum sample, promote variant to full traffic.

**Risk:** low. The variant cannot be worse than the current "send link" approach for B/C/D leads.

---

## Test 2 — Loom variant A ("Two Reasons") vs Variant B ("PAS")

**Hypothesis:** PAS-style Loom resonates more with creators who feel underpaid by brand collabs; "Two Reasons" feels safer and more trustworthy for cautious leads. Unclear which wins.

**Setup:**
- Both run inside Branch A of the setter (the default branch).
- Split: 50/50 per Branch A response.
- Sample size minimum: 50 Branch A responses per arm.

**Decision criterion:** form completion rate per arm.

**Risk:** very low. Both Looms preserve all other system elements.

---

## Test 3 — Cold email Step 1: Control vs Variant A (anti-"collab" reframe)

**Hypothesis:** Removing the word "collab" from subject and body, and adding the explicit "not a one-off brand collab" line, reduces the rate of per-post objections downstream. This may slightly lower positive reply rate but increase REPLY QUALITY and thus net form completions.

**Setup:**
- Control: current step 1 with subject `{{firstName}}, collab?`.
- Variant A: subject `{{firstName}}, content role`, body with reframe and $1M+ ARR.
- Split: 50/50.
- Sample size minimum: 200 emails per arm.

**Decision criterion (composite, in this order):**
1. Form completions per 100 emails sent (the true north).
2. Open rate guardrail check.
3. Positive reply rate (can dip slightly if form rate compensates).
4. % of positive replies that contain per-post objection (lower is better — proxy for variant working as intended).

**Risk:** medium. We're touching the top of funnel. Run only after Test 1 is stable so we have a working setter to absorb whatever replies come.

---

## Test 4 — CTA destination: landing vs form-direct (in setter responses)

**Hypothesis:** The landing adds qualification value, but it also adds friction. The right answer depends on whether the landing's expectations-setting offsets the click loss.

**Setup:**
- Inside the setter responses (Branches A/B/C/D), randomize the CTA link:
  - Control (landing): `https://symmetry.club/roles/ugc-creator-en` (default anchor at top)
  - Variant (anchor): `https://symmetry.club/roles/ugc-creator-en#apply` (jumps directly to form on the landing)
  - Variant (form-direct): direct link to form, bypassing landing entirely
- Three-way split: 33/33/33.
- Sample size minimum: 50 setter responses per arm.

**Decision criterion:** form completion rate per arm, AND quality-of-submission (downstream qualification rate at the CV+video review step).

**Risk:** medium. Skipping the landing may lower quality of submitters even if it raises raw completions.

---

## Test 5 — Step 1 longer-form (Variant C with proof + P.S.) vs current

**Hypothesis:** A longer email that pre-empts the per-post objection AND establishes authority in cold may convert better, at a slight cost to open rate.

**Setup:**
- Control: current step 1.
- Variant: Step 1 Variant C from `01_secuencia_instantly.md`.
- Split: 50/50.
- Sample size: 200 per arm.

**Decision criterion:** same composite as Test 3.

**Risk:** medium. Longer email = more risk of spam triggers. Watch bounce/spam closely in first 50 sends.

---

## Test 6 — Adding Step 3 (breakup follow-up) vs current 2-step

**Hypothesis:** Adding a third cold touch with a breakup/scarcity angle rescues ~5-10% of leads who didn't reply to step 1 or 2.

**Setup:**
- Control: current 2-step sequence.
- Variant: 3-step sequence (step 3 from `01_secuencia_instantly.md`).
- Split: 50/50.
- Sample size: 300 leads per arm (need volume because the lift is on the tail).

**Decision criterion:** total positive replies per 100 sent, total form completions per 100 sent.

**Risk:** low. The breakup email is short and standard practice.

---

## Test 7 — Warm follow-up sequence vs none

**Hypothesis:** Adding the 5-email warm follow-up sequence (post-positive-reply) raises form completion rate substantially, because today we have zero touches after the first setter response.

**Setup:**
- Control: setter sends Branch response, no follow-up.
- Variant: setter sends Branch response, then warm follow-up sequence triggers if no form fill.
- Split: 50/50.
- Sample size: 60 positive replies per arm.

**Decision criterion:** form completion rate per arm, time-to-form-completion distribution.

**Risk:** low. Worst case is unsubscribes if too aggressive.

---

## Test 8 — Loom thumbnail/preview format (sub-test under Loom variants)

**Hypothesis:** Embedding the Loom as a clickable GIF preview (Loom's default sharing) drives more clicks than plain text link, but may raise spam risk in setter responses (which aren't sent via Instantly so less risk).

**Setup:**
- Run only after Tests 1 and 2 are stable.
- Inside Branch A, split between plain link vs embedded Loom GIF preview.
- Split: 50/50.
- Sample size: 50 per arm.

**Decision criterion:** Loom view rate (from Loom analytics) + form completion rate.

**Risk:** low for setter responses (warm thread). Do NOT extend this to cold emails.

---

## Execution sequence (recommended order)

1. **Week 1**: Fix instrumentation (see `05_instrumentation_checklist.md`).
2. **Week 1-2**: Deploy AI Setter branches + Loom (both variants) + warm follow-up sequence. Run **Test 1** (setter ramificado) + **Test 7** (warm follow-up). Both are high-impact, low-risk, and the gains compound.
3. **Week 3**: Run **Test 2** (Loom A vs B) once Branch A has volume.
4. **Week 4**: Run **Test 3** (cold step 1 reframe) once we have a working setter to absorb whatever replies the new step 1 generates.
5. **Week 5**: Run **Test 4** (CTA destination) and **Test 6** (3-step cold). Can run in parallel.
6. **Week 6+**: Run **Test 5** (longer cold) and **Test 8** (Loom thumbnail). Lower-priority refinements.

---

## Decision documentation

For every test, capture:
- Hypothesis
- Start date, end date
- Sample size achieved
- Result (raw numbers, not just %)
- Decision (promote variant / kill variant / extend test)
- Notes / surprises

Store decisions in a simple sheet: `ab_test_log.csv` with columns: test_id, hypothesis, start_date, end_date, n_control, n_variant, metric_control, metric_variant, p_value (if computed), decision, notes.

---

## Statistical sanity

We don't need formal stats for v1 unless results are close. Rule of thumb:
- Lift ≥ 50% relative with ≥50 events per arm → promote variant.
- Lift between 20% and 50% → extend test for more data.
- Lift < 20% or noisy → declare inconclusive, move to next test.

When in doubt and stakes are high, use a basic 2-proportion test (e.g., abtestcalculator.com). Most decisions in this plan don't need it because the lifts we're looking for are big.
