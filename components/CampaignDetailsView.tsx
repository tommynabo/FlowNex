import React, { useState, useEffect, useRef } from 'react';
import { Campaign, SearchConfigState, Lead } from '../lib/types';
import { ArrowLeft, Search, Table, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { SearchConfig } from './SearchConfig';
import { AgentTerminal } from './AgentTerminal';
import { LeadsTable } from './LeadsTable';

const PAGE_SIZE = 25;

interface CampaignDetailsViewProps {
  campaign: Campaign;
  onBack: () => void;
  // Search Props
  config: SearchConfigState;
  onChangeConfig: (updates: Partial<SearchConfigState>) => void;
  onSearch: () => void;
  onStop: () => void;
  isSearching: boolean;
  totalLeadsGenerated: number;
  terminalVisible: boolean;
  terminalExpanded: boolean;
  onToggleTerminal: () => void;
  logs: string[];
  leads: Lead[];
  onViewMessage: (lead: Lead) => void;
  lastSearchCount: number;
}

export function CampaignDetailsView({
  campaign,
  onBack,
  config,
  onChangeConfig,
  onSearch,
  onStop,
  isSearching,
  totalLeadsGenerated,
  terminalVisible,
  terminalExpanded,
  onToggleTerminal,
  logs,
  leads,
  onViewMessage  lastSearchCount,}: CampaignDetailsViewProps) {
  const [activeTab, setActiveTab] = useState<'generator' | 'results'>('generator');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [page, setPage] = useState(1);

  // Reset pagination when leads change
  useEffect(() => { setPage(1); }, [leads.length]);

  // Auto-switch to Results tab only when search finishes WITH new leads
  const prevIsSearching = useRef(false);
  useEffect(() => {
    if (prevIsSearching.current && !isSearching && lastSearchCount > 0) {
      setActiveTab('results');
    }
    prevIsSearching.current = isSearching;
  }, [isSearching, lastSearchCount]);

  const exportCSV = () => {
    if (leads.length === 0) return;
    let filtered = leads;
    if (startDate) filtered = filtered.filter(l => new Date((l as any).date || Date.now()) >= new Date(startDate));
    if (endDate) filtered = filtered.filter(l => new Date((l as any).date || Date.now()) <= new Date(endDate));
    if (filtered.length === 0) { alert('No leads found in this date range.'); return; }

    const headers = ['Name', 'Instagram', 'Followers', 'Niche', 'Email', 'Status'];
    const rows = filtered.map(l => [
      l.decisionMaker?.name || '',
      l.ig_handle ? '@' + l.ig_handle : '',
      l.follower_count || 0,
      l.niche || '',
      l.decisionMaker?.email || '',
      l.status || ''
    ]);
    const csvContent = [headers.join(','), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `campaign_${campaign.name}_leads.csv`;
    link.click();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button 
            onClick={onBack}
            className="p-2 hover:bg-secondary rounded-lg transition-colors border border-transparent hover:border-border"
          >
            <ArrowLeft className="w-5 h-5 text-muted-foreground" />
          </button>
          <div>
            <h2 className="text-2xl font-bold">{campaign.name}</h2>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
              <span>{campaign.hashtags.map(h => `#${h}`).join(' ')}</span>
              <span>•</span>
              <span>{campaign.totalLeads} Leads</span>
            </div>
          </div>
        </div>
        <div className="flex bg-secondary p-1 rounded-lg border border-border">
          <button
            onClick={() => setActiveTab('generator')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              activeTab === 'generator' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Search className="w-4 h-4" />
            Generator
          </button>
          <button
            onClick={() => setActiveTab('results')}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
              activeTab === 'results' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Table className="w-4 h-4" />
            Results Pipeline
          </button>
        </div>
      </div>

      {/* Tabs */}
      {activeTab === 'generator' && (
        <div className="animate-[fadeIn_0.3s_ease-out] space-y-6">
          <SearchConfig
            config={config}
            onChange={onChangeConfig}
            onSearch={onSearch}
            onStop={onStop}
            isSearching={isSearching}
            totalLeadsGenerated={totalLeadsGenerated}
            readOnly={true}
          />

          <AgentTerminal
            logs={logs}
            isVisible={terminalVisible}
            isExpanded={terminalExpanded}
            onToggleExpand={onToggleTerminal}
          />
        </div>
      )}

      {activeTab === 'results' && (
        <div className="animate-[fadeIn_0.3s_ease-out] space-y-6">
          <div className="flex justify-between items-center bg-card p-4 rounded-xl border border-border">
            <div className="flex items-center gap-3">
              <h3 className="font-bold text-lg">Results Pipeline</h3>
              <span className="text-xs bg-primary/10 text-primary border border-primary/20 rounded-full px-2.5 py-0.5 font-medium">
                {leads.length} leads
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="date"
                value={startDate}
                onChange={e => { setStartDate(e.target.value); setPage(1); }}
                className="bg-white text-black text-sm px-3 py-2 rounded-lg border border-border focus:border-primary outline-none [color-scheme:light]"
                title="Start Date"
              />
              <span className="text-muted-foreground text-sm">to</span>
              <input
                type="date"
                value={endDate}
                onChange={e => { setEndDate(e.target.value); setPage(1); }}
                className="bg-white text-black text-sm px-3 py-2 rounded-lg border border-border focus:border-primary outline-none [color-scheme:light]"
                title="End Date"
              />
              <button
                onClick={exportCSV}
                className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-all ml-2"
              >
                <Download className="w-4 h-4" />
                Export CSV
              </button>
            </div>
          </div>

          {(() => {
            let filtered = leads;
            if (startDate) filtered = filtered.filter(l => new Date((l as any).date || Date.now()) >= new Date(startDate));
            if (endDate) filtered = filtered.filter(l => new Date((l as any).date || Date.now()) <= new Date(endDate));
            const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
            const safePage = Math.min(page, totalPages);
            const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
            const from = filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
            const to = Math.min(safePage * PAGE_SIZE, filtered.length);

            return (
              <>
                {filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 border border-dashed border-border rounded-xl bg-card">
                    <p className="text-sm text-muted-foreground">No leads found{(startDate || endDate) ? ' for this date range' : ' yet. Run the generator to find creators.'}.</p>
                  </div>
                ) : (
                  <LeadsTable leads={paginated} onViewMessage={onViewMessage} />
                )}

                {totalPages > 1 && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-muted-foreground">
                      Mostrando {from}–{to} de {filtered.length} leads
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={safePage <= 1}
                        className="p-1.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      {Array.from({ length: totalPages }, (_, i) => i + 1)
                        .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
                        .reduce<(number | '...')[]>((acc, p, idx, arr) => {
                          if (idx > 0 && (p as number) - (arr[idx - 1] as number) > 1) acc.push('...');
                          acc.push(p);
                          return acc;
                        }, [])
                        .map((p, idx) =>
                          p === '...' ? (
                            <span key={'ellipsis-' + idx} className="px-1 text-muted-foreground text-xs">…</span>
                          ) : (
                            <button
                              key={p}
                              onClick={() => setPage(p as number)}
                              className={`min-w-[32px] h-8 rounded-lg text-xs font-medium border transition-all ${
                                safePage === p
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'border-border hover:bg-secondary text-muted-foreground'
                              }`}
                            >
                              {p}
                            </button>
                          )
                        )}
                      <button
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                        disabled={safePage >= totalPages}
                        className="p-1.5 rounded-lg border border-border hover:bg-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
