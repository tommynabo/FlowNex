import React, { useState, useEffect, useCallback } from 'react';
import {
  Bot,
  CheckCircle,
  XCircle,
  Edit3,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Inbox,
  TrendingUp,
  BarChart2,
  Send,
  AlertCircle,
} from 'lucide-react';
import { setterAgentService } from '../services/setter/SetterAgentService';
import { LeadConversation, SetterStatus, IntentType } from '../lib/types';

// ── Props ────────────────────────────────────────────────────────────────────

interface SetterDashboardProps {
  userId: string;
  onLog: (message: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const INTENT_LABELS: Record<IntentType, { label: string; color: string }> = {
  interested:     { label: 'Interesado',      color: 'text-green-400 bg-green-400/10 border-green-400/20' },
  objection:      { label: 'Objeción',         color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20' },
  question:       { label: 'Pregunta',         color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  not_interested: { label: 'No interesado',    color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  unsubscribe:    { label: 'Baja',             color: 'text-zinc-400 bg-zinc-400/10 border-zinc-400/20' },
  unknown:        { label: 'Desconocido',      color: 'text-zinc-500 bg-zinc-500/10 border-zinc-500/20' },
};

const STATUS_LABELS: Record<SetterStatus, { label: string; color: string }> = {
  pending_review: { label: 'Pendiente',  color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20' },
  approved:       { label: 'Aprobado',   color: 'text-green-400 bg-green-400/10 border-green-400/20' },
  rejected:       { label: 'Rechazado',  color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  corrected:      { label: 'Corregido',  color: 'text-purple-400 bg-purple-400/10 border-purple-400/20' },
  sent:           { label: 'Enviado',    color: 'text-primary bg-primary/10 border-primary/20' },
};

function confidenceBadge(score?: number): { label: string; color: string } {
  if (score === undefined || score === null) return { label: '—', color: 'text-zinc-500' };
  if (score >= 90) return { label: `${score}%`, color: 'text-green-400' };
  if (score >= 70) return { label: `${score}%`, color: 'text-yellow-400' };
  return { label: `${score}%`, color: 'text-red-400' };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// ── Modal types ──────────────────────────────────────────────────────────────

type ModalMode = 'approve' | 'correct' | 'reject' | null;

interface ActiveModal {
  mode: ModalMode;
  conversation: LeadConversation;
}

// ── Stats Bar ─────────────────────────────────────────────────────────────────

interface StatsBarProps {
  total: number;
  pendingReview: number;
  approvalRate: number;
  avgConfidence: number;
}

function StatsBar({ total, pendingReview, approvalRate, avgConfidence }: StatsBarProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      {[
        { label: 'Total Respuestas', value: total, icon: <Inbox className="w-4 h-4" />, color: 'text-primary' },
        { label: 'Pendientes', value: pendingReview, icon: <AlertCircle className="w-4 h-4" />, color: 'text-yellow-400' },
        { label: 'Tasa Aprobación', value: `${approvalRate}%`, icon: <TrendingUp className="w-4 h-4" />, color: 'text-green-400' },
        { label: 'Confianza Media IA', value: `${avgConfidence}%`, icon: <BarChart2 className="w-4 h-4" />, color: 'text-purple-400' },
      ].map(stat => (
        <div key={stat.label} className="bg-card border border-border rounded-xl p-4 flex flex-col gap-2">
          <div className={`flex items-center gap-1.5 text-xs text-muted-foreground`}>
            <span className={stat.color}>{stat.icon}</span>
            {stat.label}
          </div>
          <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
        </div>
      ))}
    </div>
  );
}

// ── Conversation Row ──────────────────────────────────────────────────────────

interface ConversationRowProps {
  conv: LeadConversation;
  expanded: boolean;
  onToggleExpand: () => void;
  onOpenModal: (mode: ModalMode) => void;
}

function ConversationRow({ conv, expanded, onToggleExpand, onOpenModal }: ConversationRowProps) {
  const intent = INTENT_LABELS[conv.intentClassification ?? 'unknown'];
  const status = STATUS_LABELS[conv.status];
  const confidence = confidenceBadge(conv.confidenceScore);
  const isPending = conv.status === 'pending_review';

  return (
    <div className="border border-border rounded-xl overflow-hidden bg-card transition-all duration-200">
      {/* Row header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-secondary/20 transition-colors"
        onClick={onToggleExpand}
      >
        {/* Lead email */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{conv.leadEmail}</p>
          <p className="text-xs text-muted-foreground truncate">{conv.campaignName ?? conv.campaignId}</p>
        </div>

        {/* Intent badge */}
        <span className={`hidden md:inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${intent.color}`}>
          {intent.label}
        </span>

        {/* Confidence */}
        <span className={`hidden md:inline text-xs font-mono font-bold ${confidence.color}`}>
          {confidence.label}
        </span>

        {/* Status badge */}
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${status.color}`}>
          {status.label}
        </span>

        {/* Date */}
        <span className="hidden lg:inline text-xs text-muted-foreground whitespace-nowrap">
          {formatDate(conv.createdAt)}
        </span>

        {/* Expand toggle */}
        <button className="text-muted-foreground ml-1 shrink-0">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4 animate-[fadeIn_0.2s_ease-out]">
          {/* Lead reply */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">
              Respuesta del Lead
            </p>
            <div className="bg-secondary/30 rounded-lg p-3 text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">
              {conv.replyText}
            </div>
          </div>

          {/* AI draft */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5 text-primary" /> Borrador IA
            </p>
            {conv.aiDraft ? (
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                {conv.aiDraft}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">Sin borrador generado — escribe una respuesta manual al corregir.</p>
            )}
          </div>

          {/* Action buttons (only for pending) */}
          {isPending && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => onOpenModal('approve')}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/10 hover:bg-green-500/20 border border-green-500/30 text-green-400 rounded-lg text-sm font-medium transition-colors"
              >
                <CheckCircle className="w-4 h-4" /> Aprobar
              </button>
              <button
                onClick={() => onOpenModal('correct')}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-purple-400 rounded-lg text-sm font-medium transition-colors"
              >
                <Edit3 className="w-4 h-4" /> Corregir
              </button>
              <button
                onClick={() => onOpenModal('reject')}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 rounded-lg text-sm font-medium transition-colors"
              >
                <XCircle className="w-4 h-4" /> Rechazar
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Feedback Modal ────────────────────────────────────────────────────────────

interface FeedbackModalProps {
  modal: ActiveModal;
  onClose: () => void;
  onSubmit: (params: {
    decision: 'approved' | 'rejected' | 'corrected';
    correctedDraft?: string;
    reason: string;
  }) => Promise<void>;
  isSubmitting: boolean;
}

function FeedbackModal({ modal, onClose, onSubmit, isSubmitting }: FeedbackModalProps) {
  const { mode, conversation } = modal;
  const [correctedDraft, setCorrectedDraft] = useState(conversation.aiDraft ?? '');
  const [reason, setReason] = useState('');

  const titles = {
    approve: { title: 'Aprobar Borrador', subtitle: 'El mensaje se enviará al lead via Instantly.', color: 'text-green-400', icon: <CheckCircle className="w-5 h-5 text-green-400" /> },
    correct: { title: 'Corregir Borrador', subtitle: 'Edita el mensaje y explica los cambios para entrenar al bot.', color: 'text-purple-400', icon: <Edit3 className="w-5 h-5 text-purple-400" /> },
    reject:  { title: 'Rechazar Borrador', subtitle: 'El borrador no se enviará. Tu razón mejora al bot.', color: 'text-red-400', icon: <XCircle className="w-5 h-5 text-red-400" /> },
  };

  const meta = titles[mode!]!;

  const handleSubmit = async () => {
    if (!reason.trim()) return;
    await onSubmit({
      decision: mode === 'approve' ? 'approved' : mode === 'correct' ? 'corrected' : 'rejected',
      correctedDraft: mode === 'correct' ? correctedDraft : undefined,
      reason: reason.trim(),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl animate-[fadeIn_0.2s_ease-out]">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
          {meta.icon}
          <div>
            <h3 className={`font-semibold ${meta.color}`}>{meta.title}</h3>
            <p className="text-xs text-muted-foreground">{meta.subtitle}</p>
          </div>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Lead reply context */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Respuesta del Lead</p>
            <div className="bg-secondary/30 rounded-lg p-3 text-xs text-zinc-400 max-h-24 overflow-y-auto">
              {conversation.replyText}
            </div>
          </div>

          {/* Draft — editable only when correcting */}
          {mode === 'correct' ? (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Mensaje Corregido</p>
              <textarea
                value={correctedDraft}
                onChange={e => setCorrectedDraft(e.target.value)}
                rows={5}
                className="w-full bg-secondary/30 border border-border rounded-lg px-3 py-2 text-sm text-foreground resize-none focus:outline-none focus:border-purple-500/50 transition-colors"
                placeholder="Escribe aquí la versión corregida del mensaje..."
              />
            </div>
          ) : mode === 'approve' && conversation.aiDraft ? (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Mensaje a Enviar</p>
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 text-sm text-foreground max-h-32 overflow-y-auto">
                {conversation.aiDraft}
              </div>
            </div>
          ) : null}

          {/* Reason — always required */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">
              {mode === 'approve' ? '¿Por qué apruebas este mensaje?' :
               mode === 'correct' ? '¿Qué cambiaste y por qué?' :
               '¿Por qué rechazas este borrador?'}
              <span className="text-red-400 ml-0.5">*</span>
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={2}
              className="w-full bg-secondary/30 border border-border rounded-lg px-3 py-2 text-sm text-foreground resize-none focus:outline-none focus:border-primary/50 transition-colors"
              placeholder="Ej: Tono perfecto, CTA directo, responde la objeción de precio correctamente..."
            />
            {!reason.trim() && <p className="text-xs text-red-400 mt-1">El motivo es obligatorio para el entrenamiento del bot.</p>}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-border">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || !reason.trim()}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed
              ${mode === 'approve' ? 'bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/30' :
                mode === 'correct' ? 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 border border-purple-500/30' :
                'bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30'}`}
          >
            {isSubmitting ? (
              <><RefreshCw className="w-4 h-4 animate-spin" /> Procesando...</>
            ) : mode === 'approve' ? (
              <><Send className="w-4 h-4" /> Aprobar y Enviar</>
            ) : mode === 'correct' ? (
              <><Send className="w-4 h-4" /> Guardar y Enviar</>
            ) : (
              <><XCircle className="w-4 h-4" /> Confirmar Rechazo</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export function SetterDashboard({ userId, onLog }: SetterDashboardProps) {
  const [conversations, setConversations] = useState<LeadConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [filterStatus, setFilterStatus] = useState<SetterStatus | 'all'>('all');

  // Register log callback once
  useEffect(() => {
    setterAgentService.setLogCallback(onLog);
  }, [onLog]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const data = await setterAgentService.loadConversations(userId);
      setConversations(data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const total = conversations.length;
  const pendingReview = conversations.filter(c => c.status === 'pending_review').length;
  const resolved = conversations.filter(c => ['approved', 'corrected', 'sent'].includes(c.status)).length;
  const approvalRate = total > 0 ? Math.round((resolved / total) * 100) : 0;
  const scoresWithValue = conversations.filter(c => c.confidenceScore !== undefined);
  const avgConfidence = scoresWithValue.length > 0
    ? Math.round(scoresWithValue.reduce((s, c) => s + (c.confidenceScore ?? 0), 0) / scoresWithValue.length)
    : 0;

  // ── Filter ─────────────────────────────────────────────────────────────────
  const filtered = filterStatus === 'all' ? conversations : conversations.filter(c => c.status === filterStatus);

  // ── Feedback submit ────────────────────────────────────────────────────────
  const handleFeedbackSubmit = async (params: {
    decision: 'approved' | 'rejected' | 'corrected';
    correctedDraft?: string;
    reason: string;
  }) => {
    if (!activeModal) return;
    setIsSubmitting(true);

    const { conversation } = activeModal;

    onLog(`[SETTER] Entrante: Respuesta de ${conversation.leadEmail} → Procesando decisión "${params.decision}"...`);

    const result = await setterAgentService.submitFeedback({
      conversationId: conversation.id,
      userId,
      decision: params.decision,
      originalDraft: conversation.aiDraft ?? '',
      correctedDraft: params.correctedDraft,
      reason: params.reason,
    });

    setIsSubmitting(false);

    if (result.success) {
      if (params.decision === 'approved' || params.decision === 'corrected') {
        onLog(`[SETTER] ✅ Borrador enviado a Instantly para ${conversation.leadEmail}`);
      } else {
        onLog(`[SETTER] Borrador rechazado para ${conversation.leadEmail} → Feedback guardado`);
      }
      setActiveModal(null);
      load(true);
    } else {
      onLog(`[SETTER] ERROR: ${result.error}`);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="animate-[fadeIn_0.3s_ease-out] space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-primary/20 rounded-xl flex items-center justify-center border border-primary/30">
            <Bot className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">AI Setter</h1>
            <p className="text-xs text-muted-foreground">Respuestas entrantes de leads vía Instantly</p>
          </div>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Actualizar
        </button>
      </div>

      {/* Stats */}
      <StatsBar total={total} pendingReview={pendingReview} approvalRate={approvalRate} avgConfidence={avgConfidence} />

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-2">
        {(['all', 'pending_review', 'approved', 'corrected', 'rejected', 'sent'] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors border
              ${filterStatus === s
                ? 'bg-primary/20 text-primary border-primary/40'
                : 'text-muted-foreground border-border hover:text-foreground hover:border-border/60'
              }`}
          >
            {s === 'all' ? 'Todas' : STATUS_LABELS[s].label}
            {s === 'pending_review' && pendingReview > 0 && (
              <span className="ml-1.5 bg-yellow-400/20 text-yellow-400 rounded-full px-1.5 py-0.5 text-[10px]">
                {pendingReview}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Conversations list */}
      <div className="space-y-2">
        {loading ? (
          <div className="text-center py-12 text-muted-foreground">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-3 text-primary" />
            <p className="text-sm">Cargando conversaciones...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground border border-dashed border-border rounded-xl">
            <Inbox className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p className="text-sm font-medium">
              {filterStatus === 'all' ? 'No hay conversaciones aún' : `No hay conversaciones con estado "${STATUS_LABELS[filterStatus]?.label ?? filterStatus}"`}
            </p>
            <p className="text-xs mt-1 opacity-70">Las respuestas de leads aparecerán aquí via webhook de Instantly</p>
          </div>
        ) : (
          filtered.map(conv => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              expanded={expandedId === conv.id}
              onToggleExpand={() => setExpandedId(expandedId === conv.id ? null : conv.id)}
              onOpenModal={(mode) => setActiveModal({ mode, conversation: conv })}
            />
          ))
        )}
      </div>

      {/* Feedback Modal */}
      {activeModal && activeModal.mode && (
        <FeedbackModal
          modal={activeModal}
          onClose={() => setActiveModal(null)}
          onSubmit={handleFeedbackSubmit}
          isSubmitting={isSubmitting}
        />
      )}
    </div>
  );
}
