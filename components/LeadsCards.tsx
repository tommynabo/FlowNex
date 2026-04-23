import React, { useState } from 'react';
import { Lead } from '../lib/types';
import { Copy, Check, X, Instagram, Mail, Users, TrendingUp } from 'lucide-react';

interface LeadsCardsProps {
  leads: Lead[];
  onMarkContacted: (leadId: string, messageType: 'a' | 'b') => void;
  onMarkDiscarded: (leadId: string) => void;
}

function formatFollowers(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

function VslStatusBadge({ status }: { status?: string }) {
    const map: Record<string, string> = {
        sent: 'badge-sent', opened: 'badge-opened', clicked: 'badge-clicked', converted: 'badge-converted'
    };
    const cls = map[status || ''] || 'badge-neon';
    const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Pending';
    return <span className={cls}>{label}</span>;
}

export function LeadsCards({ leads, onMarkContacted, onMarkDiscarded }: LeadsCardsProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  if (leads.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 px-4">
        <div className="text-center">
          <Instagram className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground text-lg">No creators yet</p>
          <p className="text-muted-foreground text-sm mt-2">Run a search to find Instagram creators</p>
        </div>
      </div>
    );
  }

  const activeLead = leads.find(l => l.status !== 'discarded');

  if (!activeLead) {
    return (
      <div className="flex items-center justify-center py-16 px-4">
        <div className="text-center">
          <Check className="w-12 h-12 text-primary mx-auto mb-4" />
          <p className="text-foreground text-lg font-medium">All creators processed!</p>
          <p className="text-muted-foreground text-sm mt-2">Total reviewed: {leads.length}</p>
        </div>
      </div>
    );
  }

  const currentIdx = leads.findIndex(l => l.id === activeLead.id);
  const progress = Math.round((currentIdx / leads.length) * 100);

  return (
    <div className="mt-8 space-y-4 max-w-2xl mx-auto">
      {/* Progress bar */}
      <div className="sticky top-4 z-40 glass-card border border-border rounded-lg p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Creator <span className="font-bold text-foreground">{currentIdx + 1}</span> of <span className="font-bold text-foreground">{leads.length}</span>
          </span>
          <span className="text-xs text-muted-foreground">{progress}% complete</span>
        </div>
        <div className="mt-2 w-full bg-secondary h-2 rounded-full overflow-hidden">
          <div className="bg-primary h-full transition-all glow-green" style={{ width: progress + '%' }} />
        </div>
      </div>

      {/* Creator Card */}
      <div className="glass-card border border-border rounded-xl overflow-hidden animate-[slideIn_0.3s_ease-out]">
        {/* Header */}
        <div className="bg-gradient-to-r from-primary/10 to-violet-500/5 border-b border-border p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h2 className="text-2xl font-bold text-foreground">{activeLead.decisionMaker?.name || ('@' + activeLead.ig_handle)}</h2>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {activeLead.ig_handle && (
                  <a href={'https://instagram.com/' + activeLead.ig_handle} target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 text-sm text-primary hover:underline">
                    <Instagram className="w-3.5 h-3.5" />@{activeLead.ig_handle}
                  </a>
                )}
                {activeLead.follower_count ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="w-3 h-3" />{formatFollowers(activeLead.follower_count)}
                  </span>
                ) : null}
                {activeLead.audience_tier && (
                  <span className="text-xs text-muted-foreground capitalize">{activeLead.audience_tier}</span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              {activeLead.niche && <span className="badge-neon">{activeLead.niche}</span>}
              <VslStatusBadge status={activeLead.vsl_sent_status} />
            </div>
          </div>
          {activeLead.decisionMaker?.email && (
            <div className="flex items-center gap-1.5 mt-3 text-sm text-muted-foreground">
              <Mail className="w-3.5 h-3.5" />
              <span>{activeLead.decisionMaker.email}</span>
            </div>
          )}
        </div>

        {/* Cold Email Section */}
        <div className="p-6 space-y-4">
          {activeLead.aiAnalysis?.coldEmailBody ? (
            <div className="bg-secondary/40 border border-border/50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-sm text-foreground">Cold Email</h3>
                  {activeLead.aiAnalysis?.coldEmailSubject && (
                    <p className="text-xs text-muted-foreground mt-0.5">Subject: {activeLead.aiAnalysis.coldEmailSubject}</p>
                  )}
                </div>
                <button
                  onClick={() => handleCopy(activeLead.aiAnalysis?.coldEmailBody || '', activeLead.id)}
                  className={'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ' + (
                    copiedId === activeLead.id
                      ? 'bg-primary/20 text-primary border border-primary/30'
                      : 'bg-secondary text-muted-foreground border border-border hover:text-primary hover:border-primary/30'
                  )}
                >
                  {copiedId === activeLead.id ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
                </button>
              </div>
              <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">{activeLead.aiAnalysis.coldEmailBody}</p>
            </div>
          ) : (
            <div className="bg-secondary/40 border border-dashed border-border rounded-lg p-4 text-center">
              <p className="text-sm text-muted-foreground">Generating cold email with AI...</p>
            </div>
          )}

          {activeLead.aiAnalysis?.vslPitch && (
            <div className="bg-violet-500/5 border border-violet-500/20 rounded-lg p-3">
              <p className="text-xs text-violet-400 font-medium mb-1 flex items-center gap-1"><TrendingUp className="w-3 h-3" /> VSL Pitch</p>
              <p className="text-sm text-foreground">{activeLead.aiAnalysis.vslPitch}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="bg-secondary/20 border-t border-border p-4 flex gap-3">
          <button
            onClick={() => onMarkContacted(activeLead.id, 'a')}
            className="flex-1 flex items-center justify-center gap-2 bg-primary text-black font-bold py-3 px-4 rounded-lg transition-all text-sm hover:brightness-110 active:scale-[0.98] glow-green"
          >
            <Mail className="w-4 h-4" /> Send VSL Email
          </button>
          <button
            onClick={() => onMarkDiscarded(activeLead.id)}
            className="px-4 py-3 border border-border rounded-lg text-foreground hover:bg-secondary transition-all font-medium text-sm"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div className="glass-card border border-border rounded-lg p-3 text-center">
          <p className="text-muted-foreground">Pending</p>
          <p className="text-lg font-bold text-foreground mt-1">{leads.filter(l => l.vsl_sent_status === 'pending' || l.status === 'ready').length}</p>
        </div>
        <div className="glass-card border border-border rounded-lg p-3 text-center">
          <p className="text-muted-foreground">Emailed</p>
          <p className="text-lg font-bold text-primary mt-1">{leads.filter(l => l.vsl_sent_status === 'sent' || l.status === 'contacted').length}</p>
        </div>
        <div className="glass-card border border-border rounded-lg p-3 text-center">
          <p className="text-muted-foreground">Converted</p>
          <p className="text-lg font-bold mt-1" style={{ color: 'hsl(152, 100%, 50%)' }}>{leads.filter(l => l.vsl_sent_status === 'converted').length}</p>
        </div>
      </div>
    </div>
  );
}
