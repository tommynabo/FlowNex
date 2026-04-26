import React, { useState } from 'react';
import { X, Rocket, Hash, Users, MapPin, Tag } from 'lucide-react';
import { Campaign, IcpFilters } from '../lib/types';
import { supabase } from '../lib/supabase';

interface CampaignCreatorModalProps {
  userId: string;
  onClose: () => void;
  onCreated: (campaign: Campaign) => void;
}

const REGION_OPTIONS = ['US', 'UK', 'CA', 'AU', 'ES', 'MX', 'AR', 'CO', 'DE', 'FR'];
const CONTENT_TYPE_OPTIONS = ['Fitness', 'Nutrition'];
const FOLLOWER_PRESETS = [
  { label: 'Nano (10K–50K)', min: 10_000, max: 50_000 },
  { label: 'Micro (50K–200K)', min: 50_000, max: 200_000 },
  { label: 'Mid (200K–1M)', min: 200_000, max: 1_000_000 },
  { label: 'Macro (1M+)', min: 1_000_000, max: 99_000_000 },
  { label: 'All sizes', min: 0, max: 99_000_000 },
];

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return n === 0 ? 'Any' : String(n);
}

export function CampaignCreatorModal({ userId, onClose, onCreated }: CampaignCreatorModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [hashtagsRaw, setHashtagsRaw] = useState('#fitnesscoach #mindset #personaldevelopment');
  const [instantlyCampaignId, setInstantlyCampaignId] = useState('');
  const [icp, setIcp] = useState<IcpFilters>({
    minFollowers: 0, maxFollowers: 99_000_000,
    regions: [], contentTypes: [], campaignName: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const updateIcp = (u: Partial<IcpFilters>) => setIcp(prev => ({ ...prev, ...u }));

  const toggleRegion = (r: string) =>
    updateIcp({ regions: icp.regions.includes(r) ? icp.regions.filter(x => x !== r) : [...icp.regions, r] });

  const toggleContentType = (ct: string) =>
    updateIcp({ contentTypes: icp.contentTypes.includes(ct) ? icp.contentTypes.filter(x => x !== ct) : [...icp.contentTypes, ct] });

  const parseHashtags = (raw: string) =>
    (raw.match(/#?[a-zA-Z0-9_]+/g) ?? []).map(h => h.replace(/^#/, '')).filter(Boolean);

  const handleCreate = async () => {
    if (!name.trim()) { setError('Campaign name is required.'); return; }
    setSaving(true);
    setError('');
    const hashtags = parseHashtags(hashtagsRaw);
    try {
      const { data, error: dbErr } = await supabase
        .from('campaigns')
        .insert({
          user_id: userId,
          name: name.trim(),
          description: description.trim() || null,
          status: 'active',
          hashtags,
          icp_min_followers: icp.minFollowers,
          icp_max_followers: icp.maxFollowers,
          icp_regions: icp.regions,
          icp_content_types: icp.contentTypes,
          total_leads: 0,
          leads_with_email: 0,
          ...(instantlyCampaignId.trim() ? { instantly_campaign_id: instantlyCampaignId.trim() } : {}),
        })
        .select()
        .single();

      if (dbErr) throw dbErr;

      const campaign: Campaign = {
        id: data.id,
        name: data.name,
        description: data.description,
        status: data.status,
        hashtags: data.hashtags,
        icpFilters: {
          minFollowers: data.icp_min_followers,
          maxFollowers: data.icp_max_followers,
          regions: data.icp_regions ?? [],
          contentTypes: data.icp_content_types ?? [],
          campaignName: data.name,
        },
        totalLeads: 0,
        createdAt: new Date(data.created_at),
        userId,
        instantlyCampaignId: data.instantly_campaign_id ?? undefined,
      };
      onCreated(campaign);
    } catch (e: any) {
      setError(e.message || 'Failed to create campaign.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border sticky top-0 bg-card z-10">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg">
              <Rocket className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold text-lg text-foreground">New Campaign</h2>
              <p className="text-xs text-muted-foreground">Define your ICP and search strategy</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          {/* Name */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Campaign Name *</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Fitness Micro-Influencers Q2 2026"
              className="w-full h-10 px-3 text-sm bg-background border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary transition-all placeholder:text-muted-foreground/50"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional notes about this campaign"
              className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary transition-all placeholder:text-muted-foreground/50 resize-none"
            />
          </div>

          {/* Instantly Campaign ID */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Instantly Campaign ID <span className="font-normal">(optional)</span></label>
            <input
              type="text"
              value={instantlyCampaignId}
              onChange={e => setInstantlyCampaignId(e.target.value)}
              placeholder="e.g. f021448d-70d0-413a-82aa-932b54d326df"
              className="w-full h-10 px-3 text-sm bg-background border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary transition-all placeholder:text-muted-foreground/50 font-mono"
            />
            <p className="text-xs text-muted-foreground">Leads from this campaign will be sent to this specific Instantly campaign. Leave blank to use the default.</p>
          </div>

          {/* Hashtags */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Hash className="w-3.5 h-3.5" />
              Hashtags
            </label>
            <input
              type="text"
              value={hashtagsRaw}
              onChange={e => setHashtagsRaw(e.target.value)}
              placeholder="#fitnesscoach #workout #mindset"
              className="w-full h-10 px-3 text-sm bg-background border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary transition-all placeholder:text-muted-foreground/50"
            />
            <p className="text-xs text-muted-foreground">
              {parseHashtags(hashtagsRaw).length} tags: {parseHashtags(hashtagsRaw).map(h => '#' + h).join(' ')}
            </p>
          </div>

          {/* Follower range */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              Follower Range
            </label>
            <div className="flex flex-wrap gap-2">
              {FOLLOWER_PRESETS.map(p => {
                const active = icp.minFollowers === p.min && icp.maxFollowers === p.max;
                return (
                  <button
                    key={p.label}
                    onClick={() => updateIcp({ minFollowers: p.min, maxFollowers: p.max })}
                    className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-all ${
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-primary font-mono">
              {fmt(icp.minFollowers)} – {fmt(icp.maxFollowers)} followers
            </p>
          </div>

          {/* Regions */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5" />
              Target Regions <span className="text-muted-foreground font-normal">(empty = any)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {REGION_OPTIONS.map(r => (
                <button
                  key={r}
                  onClick={() => toggleRegion(r)}
                  className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-all ${
                    icp.regions.includes(r)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Content types */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5" />
              Content Types <span className="text-muted-foreground font-normal">(empty = any)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {CONTENT_TYPE_OPTIONS.map(ct => (
                <button
                  key={ct}
                  onClick={() => toggleContentType(ct)}
                  className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-all ${
                    icp.contentTypes.includes(ct)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                  }`}
                >
                  {ct}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-6 border-t border-border sticky bottom-0 bg-card">
          <button
            onClick={onClose}
            className="flex-1 h-10 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saving || !name.trim()}
            className="flex-1 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-bold hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving ? (
              <span className="animate-spin w-4 h-4 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full" />
            ) : (
              <Rocket className="w-4 h-4" />
            )}
            {saving ? 'Creating…' : 'Create Campaign'}
          </button>
        </div>
      </div>
    </div>
  );
}
