import React from 'react';
import { Lead } from '../lib/types';
import { User, Mail, Instagram, Sparkles, Users, TrendingUp } from 'lucide-react';

interface LeadsTableProps {
  leads: Lead[];
  onViewMessage: (lead: Lead) => void;
  onMarkContacted?: (lead: Lead) => void;
  onMarkDiscarded?: (lead: Lead) => void;
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

const exportToCSV = (leads: Lead[]) => {
  const headers = ['Creator Name', 'IG Handle', 'Followers', 'Niche', 'Audience Tier', 'Email', 'VSL Status', 'Cold Email Subject', 'Cold Email Body', 'VSL Pitch'];
  const escapeCSV = (value: string | undefined) => {
    if (!value) return '';
    const escaped = value.replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '');
    return escaped.includes(',') || escaped.includes('"') ? ('"' + escaped + '"') : escaped;
  };

  const rows = leads.map(l => [
    escapeCSV(l.decisionMaker?.name || ('@' + l.ig_handle)),
    escapeCSV(l.ig_handle ? '@' + l.ig_handle : ''),
    escapeCSV(l.follower_count ? formatFollowers(l.follower_count) : ''),
    escapeCSV(l.niche),
    escapeCSV(l.audience_tier),
    escapeCSV(l.decisionMaker?.email),
    escapeCSV(l.vsl_sent_status),
    escapeCSV(l.aiAnalysis?.coldEmailSubject),
    escapeCSV(l.aiAnalysis?.coldEmailBody),
    escapeCSV(l.aiAnalysis?.vslPitch)
  ].join(','));

  const csvContent = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'flownext_creators_' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export function LeadsTable({ leads, onViewMessage, onMarkContacted, onMarkDiscarded }: LeadsTableProps) {
  if (leads.length === 0) return null;

  return (
    <div className="mt-8 glass-card border border-border rounded-xl overflow-hidden shadow-sm animate-[fadeIn_0.5s_ease-out]">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <h3 className="font-semibold text-lg flex items-center gap-2">
          Creators Found
          <span className="bg-primary/10 text-primary text-xs px-2 py-0.5 rounded-full">{leads.length}</span>
        </h3>
        <button
          onClick={() => exportToCSV(leads)}
          className="px-3 py-1.5 text-xs font-medium border border-border rounded-md hover:bg-secondary transition-colors"
        >
          Export CSV
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-secondary/30 text-xs text-muted-foreground uppercase tracking-wider border-b border-border">
              <th className="px-5 py-4 font-medium">Creator</th>
              <th className="px-5 py-4 font-medium">Followers</th>
              <th className="px-5 py-4 font-medium">Niche</th>
              <th className="px-5 py-4 font-medium">Email</th>
              <th className="px-5 py-4 font-medium">VSL Status</th>
              <th className="px-5 py-4 font-medium">AI Insight</th>
              <th className="px-5 py-4 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {leads.map((lead) => (
              <tr key={lead.id} className="group hover:bg-secondary/20 transition-colors">
                <td className="px-5 py-4 align-top">
                  <div className="flex flex-col">
                    <span className="font-medium text-foreground">{lead.decisionMaker?.name || ('@' + lead.ig_handle)}</span>
                    {lead.ig_handle && (
                      <a href={'https://instagram.com/' + lead.ig_handle} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 text-xs text-primary hover:underline mt-0.5">
                        <Instagram className="w-3 h-3" />@{lead.ig_handle}
                      </a>
                    )}
                  </div>
                </td>
                <td className="px-5 py-4 align-top">
                  {lead.follower_count ? (
                    <div className="flex items-center gap-1 text-sm">
                      <Users className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="font-medium">{formatFollowers(lead.follower_count)}</span>
                      {lead.audience_tier && (
                        <span className="text-xs text-muted-foreground capitalize ml-1">({lead.audience_tier})</span>
                      )}
                    </div>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </td>
                <td className="px-5 py-4 align-top">
                  {lead.niche ? <span className="badge-neon">{lead.niche}</span> : <span className="text-xs text-muted-foreground">—</span>}
                </td>
                <td className="px-5 py-4 align-top">
                  {lead.decisionMaker?.email ? (
                    <div className="flex items-center gap-1.5 text-xs">
                      <Mail className="w-3 h-3 text-muted-foreground" />
                      <span>{lead.decisionMaker.email}</span>
                    </div>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </td>
                <td className="px-5 py-4 align-top">
                  <VslStatusBadge status={lead.vsl_sent_status} />
                </td>
                <td className="px-5 py-4 align-top">
                  <div className="bg-secondary/40 p-2 rounded-lg border border-border/50 max-w-[200px]">
                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                      {lead.aiAnalysis?.summary || lead.aiAnalysis?.vslPitch || '—'}
                    </p>
                  </div>
                </td>
                <td className="px-5 py-4 align-top text-right">
                  <button
                    onClick={() => onViewMessage(lead)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary/10 text-primary hover:bg-primary hover:text-black border border-primary/20 rounded-md text-xs font-bold transition-all"
                  >
                    <Mail className="w-3 h-3" />
                    <span className="hidden sm:inline">Send Email</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
