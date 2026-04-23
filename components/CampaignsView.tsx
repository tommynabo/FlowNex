import React from 'react';
import { SearchSession, Campaign } from '../lib/types';
import {
  Calendar, Search, Mail, Instagram, ArrowRight, User,
  History, Plus, Rocket, Users, MapPin, Tag
} from 'lucide-react';

interface CampaignsViewProps {
  history: SearchSession[];
  campaigns: Campaign[];
  onSelectSession: (session: SearchSession) => void;
  onCreateCampaign: () => void;
}

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n === 0 ? 'Any' : String(n);
}

export function CampaignsView({ history, campaigns, onSelectSession, onCreateCampaign }: CampaignsViewProps) {
  return (
    <div className="space-y-6">

      {/* ── Campaigns section ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 pt-2 pb-1">
            <Rocket className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Campaigns</h3>
            {campaigns.length > 0 && (
              <span className="text-xs bg-secondary rounded-full px-2 py-0.5 text-muted-foreground">{campaigns.length}</span>
            )}
          </div>
          <button
            onClick={onCreateCampaign}
            className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:brightness-110 transition-all bg-primary/10 border border-primary/20 rounded-lg px-3 py-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            New Campaign
          </button>
        </div>

        {campaigns.length === 0 ? (
          <div className="text-center py-8 border border-dashed border-border rounded-xl bg-card/50">
            <Rocket className="w-8 h-8 mx-auto mb-3 opacity-20 text-primary" />
            <p className="text-sm text-muted-foreground">No campaigns yet.</p>
            <button
              onClick={onCreateCampaign}
              className="mt-3 text-xs text-primary hover:underline"
            >
              Create your first campaign →
            </button>
          </div>
        ) : (
          <div className="grid gap-3">
            {campaigns.map(c => (
              <div key={c.id} className="bg-card border border-border rounded-xl p-4 hover:border-primary/30 transition-all">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div>
                    <h4 className="font-semibold text-sm text-foreground">{c.name}</h4>
                    {c.description && <p className="text-xs text-muted-foreground mt-0.5">{c.description}</p>}
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
                    c.status === 'active'
                      ? 'bg-green-500/10 text-green-400 border-green-500/20'
                      : c.status === 'paused'
                      ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                      : 'bg-muted text-muted-foreground border-border'
                  }`}>
                    {c.status}
                  </span>
                </div>

                {/* ICP badges */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {(c.icpFilters.minFollowers > 0 || c.icpFilters.maxFollowers < 99_000_000) && (
                    <span className="flex items-center gap-1 text-xs bg-secondary rounded-full px-2 py-0.5 text-muted-foreground">
                      <Users className="w-3 h-3" />
                      {fmt(c.icpFilters.minFollowers)}–{fmt(c.icpFilters.maxFollowers)}
                    </span>
                  )}
                  {c.icpFilters.regions.map(r => (
                    <span key={r} className="flex items-center gap-1 text-xs bg-secondary rounded-full px-2 py-0.5 text-muted-foreground">
                      <MapPin className="w-3 h-3" />{r}
                    </span>
                  ))}
                  {c.icpFilters.contentTypes.map(ct => (
                    <span key={ct} className="flex items-center gap-1 text-xs bg-secondary rounded-full px-2 py-0.5 text-muted-foreground">
                      <Tag className="w-3 h-3" />{ct}
                    </span>
                  ))}
                  {c.hashtags.slice(0, 3).map(h => (
                    <span key={h} className="text-xs bg-primary/10 text-primary rounded-full px-2 py-0.5 border border-primary/20">
                      #{h}
                    </span>
                  ))}
                  {c.hashtags.length > 3 && (
                    <span className="text-xs text-muted-foreground rounded-full px-2 py-0.5 bg-secondary">
                      +{c.hashtags.length - 3}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <User className="w-3 h-3" />
                    {c.totalLeads} leads
                  </span>
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {c.createdAt.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Past search sessions ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-3 pt-2 pb-1 border-t border-border">
          <History className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Search History</h3>
          {history.length > 0 && (
            <span className="text-xs bg-secondary rounded-full px-2 py-0.5 text-muted-foreground">{history.length}</span>
          )}
        </div>

        {history.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Search className="w-8 h-8 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No campaigns yet. Run your first search above.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {history.map((session) => (
              <div
                key={session.id}
                onClick={() => onSelectSession(session)}
                className="bg-card border border-border rounded-xl p-4 hover:border-primary/50 transition-all cursor-pointer group flex flex-col md:flex-row md:items-center justify-between gap-3"
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 bg-secondary/50 rounded-lg flex items-center justify-center border border-border group-hover:bg-primary/10 group-hover:text-primary transition-colors flex-shrink-0">
                    {session.source === 'instagram' ? <Instagram className="w-5 h-5" /> : <Mail className="w-5 h-5" />}
                  </div>
                  <div>
                    <h4 className="font-medium text-sm group-hover:text-primary transition-colors line-clamp-1">
                      {session.query}
                    </h4>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        <span>{session.date.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })} {session.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        <span>{session.resultsCount} creators found</span>
                      </div>
                    </div>
                  </div>
                </div>
                <button className="flex items-center text-xs font-medium text-muted-foreground group-hover:text-primary transition-colors ml-auto">
                  View Results <ArrowRight className="w-3.5 h-3.5 ml-1 group-hover:translate-x-0.5 transition-transform" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 pt-2 pb-1 border-t border-border">
        <History className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Past Campaigns</h3>
        {history.length > 0 && (
          <span className="text-xs bg-secondary rounded-full px-2 py-0.5 text-muted-foreground">{history.length}</span>
        )}
      </div>

      {history.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <Search className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No campaigns yet. Run your first search above.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {history.map((session) => (
            <div
              key={session.id}
              onClick={() => onSelectSession(session)}
              className="bg-card border border-border rounded-xl p-4 hover:border-primary/50 transition-all cursor-pointer group flex flex-col md:flex-row md:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 bg-secondary/50 rounded-lg flex items-center justify-center border border-border group-hover:bg-primary/10 group-hover:text-primary transition-colors flex-shrink-0">
                  {session.source === 'instagram' ? <Instagram className="w-5 h-5" /> : <Mail className="w-5 h-5" />}
                </div>
                <div>
                  <h4 className="font-medium text-sm group-hover:text-primary transition-colors line-clamp-1">
                    {session.query}
                  </h4>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      <span>{session.date.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })} {session.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      <span>{session.resultsCount} creators found</span>
                    </div>
                  </div>
                </div>
              </div>
              <button className="flex items-center text-xs font-medium text-muted-foreground group-hover:text-primary transition-colors ml-auto">
                View Results <ArrowRight className="w-3.5 h-3.5 ml-1 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
