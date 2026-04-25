import React, { useState, useEffect, useRef } from 'react';
import { Campaign, SearchConfigState, Lead } from '../lib/types';
import { ArrowLeft, Search, Table, Download } from 'lucide-react';
import { SearchConfig } from './SearchConfig';
import { AgentTerminal } from './AgentTerminal';
import { LeadsTable } from './LeadsTable';

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
  onViewMessage
}: CampaignDetailsViewProps) {
  const [activeTab, setActiveTab] = useState<'generator' | 'results'>('generator');

  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  // Auto-switch to Results tab when search finishes
  const prevIsSearching = useRef(false);
  useEffect(() => {
    if (prevIsSearching.current && !isSearching) {
      setActiveTab('results');
    }
    prevIsSearching.current = isSearching;
  }, [isSearching]);

  const exportCSV = () => {
    if (leads.length === 0) return;
    
  // Basic CSV Export
    let filteredLeads = leads;
    if (startDate) {
      filteredLeads = filteredLeads.filter(l => new Date((l as any).date || Date.now()) >= new Date(startDate));
    }
    if (endDate) {
      filteredLeads = filteredLeads.filter(l => new Date((l as any).date || Date.now()) <= new Date(endDate));
    }
    if (filteredLeads.length === 0) {
      alert('No leads found in this date range.');
      return;
    }

    const headers = ['Name', 'Instagram', 'Followers', 'Niche', 'Status', 'Email'];
    const rows = filteredLeads.map(l => [
      l.decisionMaker?.name || '',
      l.ig_handle || '',
      l.follower_count || 0,
      l.niche || '',
      l.status || '',
      l.decisionMaker?.email || ''
    ]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    
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
            <h3 className="font-bold text-lg">Results Pipeline</h3>
            <div className="flex items-center gap-3">
              <input 
                type="date" 
                value={startDate} 
                onChange={e => setStartDate(e.target.value)} 
                className="bg-white text-black text-sm px-3 py-2 rounded-lg border border-border focus:border-primary outline-none [color-scheme:light]"
                title="Start Date"
              />
              <span className="text-muted-foreground text-sm">to</span>
              <input 
                type="date" 
                value={endDate} 
                onChange={e => setEndDate(e.target.value)}
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
          <LeadsTable
            leads={leads}
            onViewMessage={onViewMessage}
          />
        </div>
      )}
    </div>
  );
}
