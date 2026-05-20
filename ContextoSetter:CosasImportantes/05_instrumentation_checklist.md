# Instrumentation Checklist

The current 0% click rate signal is broken. Before we make data-driven decisions, fix the tracking. This checklist gets the analytics into a state where every A/B test in `04_ab_plan.md` can actually be measured.

---

## Critical fixes (do these first)

### 1. Diagnose the 0% click rate in Instantly

- [ ] Verify click tracking is **enabled** in the FlowNextOmega campaign settings.
- [ ] Confirm Instantly is rewriting URLs (typically `inst.ly/...` or similar). If not, clicks won't be tracked.
- [ ] Verify the rewritten URL actually redirects to the landing without errors.
- [ ] Send a test email to a personal inbox and click the link. Confirm the click appears in Instantly metrics within 5-10 min.
- [ ] If still showing 0% after the test click, escalate to Instantly support with the campaign ID.

### 2. Add UTM parameters to all outbound links

Standardize UTMs so we can attribute form completions to the funnel stage that drove them.

Format: `https://symmetry.club/roles/ugc-creator-en?utm_source=instantly&utm_medium=email&utm_campaign=flownextomega&utm_content={{STEP}}`

Where `{{STEP}}` is one of:
- `cold_step_1` — initial cold
- `cold_step_2` — follow-up 1
- `cold_step_3` — follow-up 2 (new)
- `setter_a` — Branch A (interest)
- `setter_b` — Branch B (per-post objection)
- `setter_c` — Branch C (time concern)
- `setter_d` — Branch D (authority)
- `setter_e` — Branch E (other question)
- `wfu_1` through `wfu_5` — warm follow-ups
- `loom_two_reasons` and `loom_pas` — Loom variants (added to Loom thumbnail link OR appended to form link when Loom is sent)

### 3. Track form completions with attribution

- [ ] On the form submission page (or thank-you confirmation), capture the UTM params at submit time and store them with the submission record.
- [ ] Build a simple report that joins: lead → cold step → setter branch → warm follow-up touches → form completion → UTM_content of last clicked link.
- [ ] This is the most important pipeline. Without it, A/B tests are guesses.

### 4. Track Loom views

- [ ] Use Loom's built-in analytics (per-video view counts, watch time).
- [ ] In Branch A, embed the Loom with a unique URL per variant so we can attribute which Loom variant the lead actually watched.
- [ ] Manually export Loom analytics weekly; integrate into the same sheet as form completions.

---

## Reporting

### Weekly dashboard (minimal v1)

A simple Google Sheet or Notion table with these metrics, refreshed weekly:

**Cold sequence (top of funnel):**
- Emails sent
- Open rate
- Reply rate (all replies)
- Positive reply rate (per AI Setter classification)
- Bounce rate
- Spam complaints

**Setter branches (post-reply):**
- Replies per branch (A/B/C/D/E/F)
- Form completion rate per branch
- Average time from reply to form completion per branch

**Warm follow-up:**
- Leads entering WFU sequence
- Form completion at WFU1, WFU2, WFU3, WFU4, WFU5
- Cumulative form completion rate by day +21

**North-star:**
- Form completions per positive reply (the metric that was broken)
- Form completions per 100 cold emails sent (full-funnel)
- Qualified applicants per 100 cold emails sent (downstream — needs CV/video review step instrumented)

### Per-test view

For each active A/B test:
- Arm name (control, variant A, variant B)
- Sample size achieved per arm
- Primary metric per arm
- Relative lift
- Status (running / promoted / killed / inconclusive)

---

## What NOT to optimize for

- Open rate. It's a vanity metric once we're north of 30% (we're at 54%).
- Reply rate alone. A higher reply rate with worse quality is worse than fewer replies with better quality.
- Click rate. Useful as a leading indicator only, not a goal.

The only metric that matters for go/no-go on changes is **form completions** (eventually: qualified applicants).

---

## Data hygiene

- [ ] Every lead gets a unique ID. The same person who appears via two different scraper runs should de-duplicate to one ID.
- [ ] Don't include replies from bounced/auto-replies in "positive reply" counts. Use FlowNext's classification.
- [ ] Branch labels in FlowNext should be exclusive (one branch per reply, even if multiple trigger). Prioritize: B > D > C > E > A; F overrides all.
- [ ] Time-zone everything to a single zone (recommend Madrid/UTC depending on team). Dashboards in mixed TZs cause bad decisions.

---

## Owner

This checklist needs a single owner to execute. Likely the Head of Content or whoever owns FlowNextOmega operations. Without a single owner, instrumentation rot happens fast.

Estimated time to implement v1 of the dashboard: 4-6 hours. Worth it before any A/B test fires.
