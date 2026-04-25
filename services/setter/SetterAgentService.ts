/**
 * services/setter/SetterAgentService.ts
 *
 * Client-side service for the AI Setter module.
 * Handles loading conversations, submitting human feedback,
 * and triggering the server-side reply to Instantly.
 *
 * Pattern: Singleton class with callback-based log system,
 * consistent with AutopilotService.ts.
 */

import { supabase } from '../../lib/supabase';
import { LeadConversation, SetterFeedback, SetterStatus } from '../../lib/types';

// ── Callbacks ────────────────────────────────────────────────────────────────

type LogCallback = (message: string) => void;

// ── Public types ─────────────────────────────────────────────────────────────

export interface SubmitFeedbackParams {
  conversationId: string;
  decision: 'approved' | 'rejected' | 'corrected';
  originalDraft: string;
  correctedDraft?: string;
  reason: string;
  userId: string;
}

export interface SetterStats {
  total: number;
  pendingReview: number;
  approved: number;
  rejected: number;
  corrected: number;
  sent: number;
  avgConfidence: number;
}

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface ConversationRow {
  id: string;
  user_id: string;
  workspace_id: string | null;
  campaign_id: string;
  campaign_name: string | null;
  lead_email: string;
  email_id: string;
  reply_subject: string | null;
  reply_text: string;
  ai_draft: string | null;
  intent_classification: string | null;
  confidence_score: number | null;
  status: string;
  created_at: string;
  processed_at: string | null;
}

interface FeedbackRow {
  id: string;
  conversation_id: string;
  user_id: string;
  decision: string;
  original_draft: string;
  corrected_draft: string | null;
  reason: string;
  created_at: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

class SetterAgentService {
  private onLog: LogCallback | null = null;

  /** Register a log callback (e.g. addSetterLog from App.tsx) */
  setLogCallback(cb: LogCallback): void {
    this.onLog = cb;
  }

  private log(message: string): void {
    if (this.onLog) this.onLog(message);
    console.log('[SETTER]', message);
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  async loadConversations(userId: string): Promise<LeadConversation[]> {
    const { data, error } = await supabase
      .from('lead_conversations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      this.log(`[SETTER] Error cargando conversaciones: ${error.message}`);
      return [];
    }

    return (data as ConversationRow[]).map(this.mapConversation);
  }

  async loadPendingConversations(userId: string): Promise<LeadConversation[]> {
    const { data, error } = await supabase
      .from('lead_conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'pending_review')
      .order('created_at', { ascending: false });

    if (error) {
      this.log(`[SETTER] Error cargando pendientes: ${error.message}`);
      return [];
    }

    return (data as ConversationRow[]).map(this.mapConversation);
  }

  // ── Feedback & Reply ───────────────────────────────────────────────────────

  /**
   * Submit human feedback on an AI draft.
   * - Inserts a row into setter_feedback (for in-context learning)
   * - Updates lead_conversations.status
   * - If decision is 'approved' or 'corrected', triggers /api/setter/send-reply
   */
  async submitFeedback(params: SubmitFeedbackParams): Promise<{ success: boolean; error?: string }> {
    const { conversationId, decision, originalDraft, correctedDraft, reason, userId } = params;
    const finalDraft = decision === 'corrected' && correctedDraft ? correctedDraft : originalDraft;

    this.log(`[SETTER] Procesando decisión "${decision}" para conversación ${conversationId}...`);

    // 1. Insert feedback row
    const { error: feedbackError } = await supabase.from('setter_feedback').insert({
      conversation_id: conversationId,
      user_id: userId,
      decision,
      original_draft: originalDraft,
      corrected_draft: decision === 'corrected' ? (correctedDraft ?? null) : null,
      reason,
    });

    if (feedbackError) {
      this.log(`[SETTER] Error guardando feedback: ${feedbackError.message}`);
      return { success: false, error: feedbackError.message };
    }

    // 2. Determine new status
    const newStatus: SetterStatus =
      decision === 'rejected' ? 'rejected' :
      decision === 'corrected' ? 'corrected' :
      'approved';

    // 3. Update conversation status
    const { error: updateError } = await supabase
      .from('lead_conversations')
      .update({ status: newStatus })
      .eq('id', conversationId);

    if (updateError) {
      this.log(`[SETTER] Error actualizando estado: ${updateError.message}`);
      return { success: false, error: updateError.message };
    }

    // 4. If approved or corrected, send via Instantly
    if (decision === 'approved' || decision === 'corrected') {
      this.log(`[SETTER] Enviando respuesta a Instantly para lead...`);
      const sendResult = await this.sendReply(conversationId, finalDraft);
      if (!sendResult.success) {
        this.log(`[SETTER] Error al enviar a Instantly: ${sendResult.error}`);
        return { success: false, error: sendResult.error };
      }
      this.log(`[SETTER] ✅ Respuesta enviada correctamente a Instantly`);
    } else {
      this.log(`[SETTER] Borrador rechazado — feedback guardado para entrenamiento`);
    }

    return { success: true };
  }

  private async sendReply(
    conversationId: string,
    draft: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch('/api/setter/send-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, draft }),
      });

      if (!response.ok) {
        const body = await response.json() as { error?: string };
        return { success: false, error: body.error ?? `HTTP ${response.status}` };
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getStats(userId: string): Promise<SetterStats> {
    const { data, error } = await supabase
      .from('lead_conversations')
      .select('status, confidence_score')
      .eq('user_id', userId);

    if (error || !data) {
      return { total: 0, pendingReview: 0, approved: 0, rejected: 0, corrected: 0, sent: 0, avgConfidence: 0 };
    }

    const total = data.length;
    const pendingReview = data.filter(r => r.status === 'pending_review').length;
    const approved = data.filter(r => r.status === 'approved').length;
    const rejected = data.filter(r => r.status === 'rejected').length;
    const corrected = data.filter(r => r.status === 'corrected').length;
    const sent = data.filter(r => r.status === 'sent').length;

    const withScore = data.filter(r => typeof r.confidence_score === 'number');
    const avgConfidence =
      withScore.length > 0
        ? Math.round(withScore.reduce((sum, r) => sum + (r.confidence_score as number), 0) / withScore.length)
        : 0;

    return { total, pendingReview, approved, rejected, corrected, sent, avgConfidence };
  }

  // ── Feedback history (for advanced view) ─────────────────────────────────

  async loadFeedbackHistory(userId: string, limit = 50): Promise<SetterFeedback[]> {
    const { data, error } = await supabase
      .from('setter_feedback')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    return (data as FeedbackRow[]).map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      userId: r.user_id,
      decision: r.decision as 'approved' | 'rejected' | 'corrected',
      originalDraft: r.original_draft,
      correctedDraft: r.corrected_draft ?? undefined,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  // ── Mapper ────────────────────────────────────────────────────────────────

  private mapConversation(row: ConversationRow): LeadConversation {
    return {
      id: row.id,
      userId: row.user_id,
      workspaceId: row.workspace_id ?? undefined,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name ?? undefined,
      leadEmail: row.lead_email,
      emailId: row.email_id,
      replySubject: row.reply_subject ?? undefined,
      replyText: row.reply_text,
      aiDraft: row.ai_draft ?? undefined,
      intentClassification: (row.intent_classification as LeadConversation['intentClassification']) ?? undefined,
      confidenceScore: row.confidence_score ?? undefined,
      status: row.status as LeadConversation['status'],
      createdAt: row.created_at,
      processedAt: row.processed_at ?? undefined,
    };
  }
}

export const setterAgentService = new SetterAgentService();
