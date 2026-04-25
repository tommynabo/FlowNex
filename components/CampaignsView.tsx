import React from 'react';
import { SearchSession, Campaign } from '../lib/types';
import {
  Calendar, Search, Mail, Instagram, ArrowRight, User,
  History, Plus, Rocket, Users, MapPin, Tag
} from 'lucide-react';

interface CampaignsViewProps {
  campaigns: Campaign[];
  onSelectCampaign: (campaign: Campaign) => void;
  onCreateCampaign: () => void;
}

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n === 0 ? 'Any' : String(n);
}

export function CampaignsView({ campaigns, onSelectCampaign, onCreateCampaign }: CampaignsViewProps) {
  return (
    <div className="space-y-6">

      <div className="space-y-4">
        {/* ── Campaigns section ── */}
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <Rocket className="w-5 h-5 text-primary" />
            <h3 className="text-lg font-bold text-foreground tracking-tight">Active Campaigns</h3>
            {campaigns.length > 0 && (
              <span className="text-xs bg-primary/20 rounded-full px-2.5 py-0.5 font-medium text-primary">{campaigns.length}</span>
            )}
          </div>
          <button
            onClick={onCreateCampaign}
            className="flex items-center gap-1.5 text-sm font-semibold text-primary hover:brightness-110 transition-all bg-primary/10 border border-primary/20 rounded-lg px-4 py-2"
          >
            <Plus className="w-4 h-4" />
            New Campaign
          </button>
        </div>

        {campaigns.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 border border-dashed border-border rounded-xl bg-card">
            <Rocket className="w-12 h-12 mb-4 opacity-20 text-primary" />
            <h4 className="text-lg font-medium text-foreground mb-1">No campaigns yet</h4>
            <p className="text-sm text-muted-foreground mb-4">Create a campaign to organize your leads and track results.</p>
            <button
              onClick={onCreateCampaign}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-all"
            >
              <Plus className="w-4 h-4" />
              Create your first campaign
            </button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-2">
            {campaigns.map(c => (
              <div key={c.id} onClick={() => onSelectCampaign(c)} className="cursor-pointer bg-card border border-border shadow-sm rounded-xl p-5 hover:border-primary/30 hover:shadow-md transition-all relative overflow-hidden group">
                <div className="absolute top-0 left-0 w-1 h-full bg-primary/20 group-hover:bg-primary transition-colors" />
                <div className="flex items-start justify-between gap-2 mb-4">
                  <div>
                    <h4 className="font-bold text-base text-foreground mb-1">{c.name}</h4>
                    {c.description && <p className="text-sm text-muted-foreground line-clamp-2">{c.description}</p>}
                  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${
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
                <div className="flex flex-wrap gap-2 mb-5">
                  {(c.icpFilters.minFollowers > 0 || c.icpFilters.maxFollowers < 99_000_000) && (
                    <span className="flex items-center gap-1.5 text-[11px] bg-secondary rounded-lg px-2 py-1 text-muted-foreground font-medium">
                      <Users className="w-3.5 h-3.5" />
                      {fmt(c.icpFilters.minFollowers)}–{fmt(c.icpFilters.maxFollowers)}
                    </span>
                  )}
                  {c.icpFilters.regions.map(r => (
                    <span key={r} className="flex items-center gap-1.5 text-[11px] bg-secondary rounded-lg px-2 py-1 text-muted-foreground font-medium">
                      <MapPin className="w-3.5 h-3.5" />{r}
                    </span>
                  ))}
                  {c.icpFilters.contentTypes.map(ct => (
                    <span key={ct} className="flex items-center gap-1.5 text-[11px] bg-secondary rounded-lg px-2 py-1 text-muted-foreground font-medium">
                      <Tag className="w-3.5 h-3.5" />{ct}
                    </span>
                  ))}
                  {c.hashtags.slice(0, 3).map(h => (
                    <span key={h} className="text-[11px] bg-primary/10 text-primary rounded-lg px-2 py-1 border border-primary/20 font-medium">
                      #{h}
                    </span>
                  ))}
                  {c.hashtags.length > 3 && (
                    <span className="text-[11px] text-muted-foreground rounded-lg px-2 py-1 bg-secondary font-medium">
                      +{c.hashtags.length - 3} more
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-5 text-sm font-medium text-foreground bg-secondary/30 p-3 rounded-lg border border-border">
                  <div className="flex flex-col">
                    <span className="text-xs text-muted-foreground font-normal mb-0.5">Total Leads</span>
                    <span className="flex items-center gap-1.5">
                      <User className="w-4 h-4 text-primary" />
                      {c.totalLeads}
                    </span>
                  </div>
                  <div className="w-px h-8 bg-border"></div>
                  <div className="flex flex-col">
                    <span className="text-xs text-muted-foreground font-normal mb-0.5">Created</span>
                    <span className="flex items-center gap-1.5">
                      <Calendar className="w-4 h-4 text-muted-foreground" />
                      {c.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}