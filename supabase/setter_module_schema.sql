-- ============================================================
-- FlowNext — AI Setter Module Schema
-- Run this after apex_engine_schema.sql
-- ============================================================

-- ============================================================
-- TABLE: lead_conversations
-- Stores every incoming reply from a lead via Instantly webhook
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_conversations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Instantly identifiers
  workspace_id          TEXT,
  campaign_id           TEXT NOT NULL,
  campaign_name         TEXT,
  lead_email            TEXT NOT NULL,
  email_id              TEXT NOT NULL,          -- reply_to_uuid from Instantly webhook; used to reply via Unibox API

  -- Incoming message from lead
  reply_subject         TEXT,
  reply_text            TEXT NOT NULL,

  -- AI-generated response
  ai_draft              TEXT,
  intent_classification TEXT,                   -- interested | objection | question | not_interested | unsubscribe | unknown
  confidence_score      SMALLINT CHECK (confidence_score BETWEEN 0 AND 100),

  -- Workflow status
  status                TEXT NOT NULL DEFAULT 'pending_review'
                          CHECK (status IN ('pending_review', 'approved', 'rejected', 'corrected', 'sent')),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at          TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_lead_conversations_user_id    ON lead_conversations (user_id);
CREATE INDEX IF NOT EXISTS idx_lead_conversations_status     ON lead_conversations (status);
CREATE INDEX IF NOT EXISTS idx_lead_conversations_campaign   ON lead_conversations (campaign_id);
CREATE INDEX IF NOT EXISTS idx_lead_conversations_created_at ON lead_conversations (created_at DESC);

-- RLS
ALTER TABLE lead_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own conversations"
  ON lead_conversations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users update own conversations"
  ON lead_conversations FOR UPDATE
  USING (auth.uid() = user_id);

-- INSERT is restricted to service-role key (webhook server), so no INSERT policy for authenticated users.
-- If you need client-side inserts, add: CREATE POLICY "..." ON lead_conversations FOR INSERT WITH CHECK (auth.uid() = user_id);


-- ============================================================
-- TABLE: setter_feedback
-- Fuel for in-context learning: every human decision on a draft
-- ============================================================
CREATE TABLE IF NOT EXISTS setter_feedback (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES lead_conversations(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  decision          TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'corrected')),

  original_draft    TEXT NOT NULL,   -- what the AI originally wrote
  corrected_draft   TEXT,            -- what the human changed it to (nullable — only for 'corrected')

  reason            TEXT NOT NULL,   -- human explanation; injected back into AI context as Layer 5

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_setter_feedback_user_id         ON setter_feedback (user_id);
CREATE INDEX IF NOT EXISTS idx_setter_feedback_conversation_id ON setter_feedback (conversation_id);
CREATE INDEX IF NOT EXISTS idx_setter_feedback_created_at      ON setter_feedback (created_at DESC);

-- RLS
ALTER TABLE setter_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own feedback"
  ON setter_feedback FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own feedback"
  ON setter_feedback FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own feedback"
  ON setter_feedback FOR UPDATE
  USING (auth.uid() = user_id);
