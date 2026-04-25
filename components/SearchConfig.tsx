import React, { useState } from 'react';
import { Play, Square, Hash, Zap, SlidersHorizontal, ChevronDown, ChevronUp, Users, MapPin, Tag } from 'lucide-react';
import { SearchConfigState, IcpFilters } from '../lib/types';

interface SearchConfigProps {
  config: SearchConfigState;
  onChange: (updates: Partial<SearchConfigState>) => void;
  onSearch: () => void;
  onStop: () => void;
  isSearching: boolean;
  totalLeadsGenerated: number;
  readOnly?: boolean;
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

function formatFollowerLabel(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return n === 0 ? 'Any' : String(n);
}

export function SearchConfig({
  config,
  onChange,
  onSearch,
  onStop,
  isSearching,
  totalLeadsGenerated,
  readOnly = false
}: SearchConfigProps) {
  const [icpOpen, setIcpOpen] = useState(false);

  const icp = config.icpFilters ?? {
    minFollowers: 0, maxFollowers: 99_000_000,
    regions: [], contentTypes: [], campaignName: ''
  };

  const updateIcp = (updates: Partial<IcpFilters>) => {
    onChange({ icpFilters: { ...icp, ...updates } });
  };

  const toggleRegion = (r: string) => {
    const next = icp.regions.includes(r)
      ? icp.regions.filter(x => x !== r)
      : [...icp.regions, r];
    updateIcp({ regions: next });
  };

  const toggleContentType = (ct: string) => {
    const next = icp.contentTypes.includes(ct)
      ? icp.contentTypes.filter(x => x !== ct)
      : [...icp.contentTypes, ct];
    updateIcp({ contentTypes: next });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = parseInt(e.target.value);
    if (isNaN(val)) val = 1;
    if (val < 1) val = 1;
    if (val > 20) val = 20;
    onChange({ maxResults: val });
  };

  const activeFilters =
    (icp.regions.length > 0 ? 1 : 0) +
    (icp.contentTypes.length > 0 ? 1 : 0) +
    (icp.minFollowers > 0 || icp.maxFollowers < 99_000_000 ? 1 : 0) +
    (icp.campaignName ? 1 : 0);

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm relative overflow-hidden hover:border-primary/20 transition-all">
      <div className="absolute top-0 right-0 w-40 h-40 bg-primary/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none" />

      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Zap className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h3 className="font-semibold text-lg text-foreground">{readOnly ? 'Generador' : 'New Campaign'}</h3>
          <p className="text-sm text-muted-foreground">{readOnly ? 'Ejecuta una búsqueda con los filtros de esta campaña' : 'Search Instagram creators by hashtag'}</p>
        </div>
        {totalLeadsGenerated > 0 && (
          <div className="ml-auto bg-primary/10 border border-primary/20 rounded-lg px-3 py-1">
            <span className="text-xs font-mono text-primary">{totalLeadsGenerated} total</span>
          </div>
        )}
      </div>

      {/* Main row */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-4 items-end">
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5" />
            Hashtags
          </label>
          {readOnly ? (
            <div className="flex flex-wrap gap-1.5 min-h-[42px] items-center py-1">
              {config.query.match(/#[a-zA-Z0-9_]+/g)?.map(tag => (
                <span key={tag} className="text-xs bg-primary/10 text-primary border border-primary/20 rounded-lg px-2.5 py-1 font-medium">
                  {tag}
                </span>
              )) || <span className="text-sm text-muted-foreground">{config.query}</span>}
            </div>
          ) : (
            <input
              type="text"
              value={config.query}
              onChange={(e) => onChange({ query: e.target.value })}
              disabled={isSearching}
              placeholder="#fitnesscoach OR #mindset OR #personaldevelopment"
              className="w-full h-[42px] px-4 text-sm bg-background border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary transition-all placeholder:text-muted-foreground/50 disabled:opacity-50"
            />
          )}
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Count</label>
          <div className="flex items-center gap-2 h-[42px]">
            <input
              type="range" min="1" max="20" step="1"
              value={config.maxResults || 1}
              onChange={(e) => onChange({ maxResults: parseInt(e.target.value) })}
              disabled={isSearching}
              className="w-28 h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
            />
            <input
              type="number" min="1" max="20"
              value={config.maxResults}
              onChange={handleNumberChange}
              onClick={(e) => e.currentTarget.select()}
              disabled={isSearching}
              className="w-14 text-center font-bold text-base bg-background border-2 border-input rounded-lg py-1 focus:ring-2 focus:ring-primary focus:border-primary transition-all"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-transparent uppercase tracking-wider select-none">&nbsp;</label>
          {isSearching ? (
            <button
              onClick={onStop}
              className="h-[42px] px-6 flex items-center justify-center rounded-lg font-bold text-sm transition-all bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 active:scale-[0.98]"
            >
              <Square className="w-4 h-4 mr-2 fill-current" />
              Stop
            </button>
          ) : (
            <button
              onClick={onSearch}
              disabled={!config.query}
              className="h-[42px] px-6 flex items-center justify-center rounded-lg font-bold text-sm transition-all shadow-lg shadow-primary/20 bg-primary text-primary-foreground hover:brightness-110 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-4 h-4 mr-2 fill-current" />
              Generate
            </button>
          )}
        </div>
      </div>

      {/* ICP Filter Toggle — hidden in read-only (campaign) mode */}
      {!readOnly && (
      <div className="mt-4 border-t border-border pt-4">
        <button
          onClick={() => setIcpOpen(o => !o)}
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <SlidersHorizontal className="w-4 h-4" />
          ICP Filters
          {activeFilters > 0 && (
            <span className="bg-primary text-primary-foreground text-xs rounded-full px-2 py-0.5 font-bold">
              {activeFilters}
            </span>
          )}
          {icpOpen ? <ChevronUp className="w-3.5 h-3.5 ml-1" /> : <ChevronDown className="w-3.5 h-3.5 ml-1" />}
        </button>

        {icpOpen && (
          <div className="mt-4 space-y-5">

            {/* Campaign name */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5" />
                Campaign Name (optional)
              </label>
              <input
                type="text"
                value={icp.campaignName}
                onChange={e => updateIcp({ campaignName: e.target.value })}
                placeholder="e.g. Fitness Micro-Influencers Q2"
                disabled={isSearching}
                className="w-full h-9 px-3 text-sm bg-background border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary transition-all placeholder:text-muted-foreground/50 disabled:opacity-50"
              />
            </div>

            {/* Follower range presets */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
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
                      disabled={isSearching}
                      className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-all disabled:opacity-50 ${
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
              {(icp.minFollowers > 0 || icp.maxFollowers < 99_000_000) && (
                <p className="text-xs text-primary font-mono">
                  Active: {formatFollowerLabel(icp.minFollowers)} – {formatFollowerLabel(icp.maxFollowers)}
                </p>
              )}
            </div>

            {/* Regions */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" />
                Target Regions
                {icp.regions.length > 0 && <span className="text-primary">({icp.regions.join(', ')})</span>}
              </label>
              <div className="flex flex-wrap gap-2">
                {REGION_OPTIONS.map(r => {
                  const active = icp.regions.includes(r);
                  return (
                    <button
                      key={r}
                      onClick={() => toggleRegion(r)}
                      disabled={isSearching}
                      className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-all disabled:opacity-50 ${
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                      }`}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Content types */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5" />
                Content Type
                {icp.contentTypes.length > 0 && <span className="text-primary">({icp.contentTypes.join(', ')})</span>}
              </label>
              <div className="flex flex-wrap gap-2">
                {CONTENT_TYPE_OPTIONS.map(ct => {
                  const active = icp.contentTypes.includes(ct);
                  return (
                    <button
                      key={ct}
                      onClick={() => toggleContentType(ct)}
                      disabled={isSearching}
                      className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-all disabled:opacity-50 ${
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                      }`}
                    >
                      {ct}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
