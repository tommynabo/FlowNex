import React from 'react';
import { Play, Square, Hash, Zap } from 'lucide-react';
import { SearchConfigState } from '../lib/types';

interface SearchConfigProps {
  config: SearchConfigState;
  onChange: (updates: Partial<SearchConfigState>) => void;
  onSearch: () => void;
  onStop: () => void;
  isSearching: boolean;
  totalLeadsGenerated: number;
}

export function SearchConfig({
  config,
  onChange,
  onSearch,
  onStop,
  isSearching,
  totalLeadsGenerated
}: SearchConfigProps) {
  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = parseInt(e.target.value);
    if (isNaN(val)) val = 1;
    if (val < 1) val = 1;
    if (val > 20) val = 20;
    onChange({ maxResults: val });
  };

  const maxAllowed = 20;

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm relative overflow-hidden hover:border-primary/20 transition-all">
      <div className="absolute top-0 right-0 w-40 h-40 bg-primary/5 rounded-full blur-3xl -mr-20 -mt-20 pointer-events-none" />

      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Zap className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h3 className="font-semibold text-lg text-foreground">New Campaign</h3>
          <p className="text-sm text-muted-foreground">Search Instagram creators by hashtag</p>
        </div>
        {totalLeadsGenerated > 0 && (
          <div className="ml-auto bg-primary/10 border border-primary/20 rounded-lg px-3 py-1">
            <span className="text-xs font-mono text-primary">{totalLeadsGenerated} total</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-4 items-end">
        {/* Hashtag / Query Input */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5" />
            Hashtags or keywords
          </label>
          <input
            type="text"
            value={config.query}
            onChange={(e) => onChange({ query: e.target.value })}
            disabled={isSearching}
            placeholder="#fitnesscoach OR #mindset OR #personaldevelopment"
            className="w-full h-[42px] px-4 text-sm bg-background border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary transition-all placeholder:text-muted-foreground/50 disabled:opacity-50"
          />
        </div>

        {/* Lead Count */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Count
          </label>
          <div className="flex items-center gap-2 h-[42px]">
            <input
              type="range"
              min="1"
              max={maxAllowed}
              step="1"
              value={config.maxResults || 1}
              onChange={(e) => onChange({ maxResults: parseInt(e.target.value) })}
              disabled={isSearching}
              className="w-28 h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
            />
            <input
              type="number"
              min="1"
              max={maxAllowed}
              value={config.maxResults}
              onChange={handleNumberChange}
              onClick={(e) => e.currentTarget.select()}
              disabled={isSearching}
              className="w-14 text-center font-bold text-base bg-background border-2 border-input rounded-lg py-1 focus:ring-2 focus:ring-primary focus:border-primary transition-all"
            />
          </div>
        </div>

        {/* Action Button */}
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
    </div>
  );
}
