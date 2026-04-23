import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { SearchConfig } from './components/SearchConfig';
import { AgentTerminal } from './components/AgentTerminal';
import { LeadsTable } from './components/LeadsTable';
import { MessageModal } from './components/MessageModal';
import { LoginPage } from './components/LoginPage';
import { CampaignsView } from './components/CampaignsView';
import { CampaignCreatorModal } from './components/CampaignCreatorModal';
import { HistoryModal } from './components/HistoryModal';
import { Lead, SearchConfigState, PageView, SearchSession, Campaign } from './lib/types';
import { PROJECT_CONFIG } from './config/project';
import { searchService } from './services/search/SearchService';
import { supabase } from './lib/supabase';

function App() {
  // Navigation & Auth State
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>('');
  const [currentPage, setCurrentPage] = useState<PageView>('login');

  // Search State
  const [config, setConfig] = useState<SearchConfigState>({
    query: '#fitnesscoach OR #personaldevelopment OR #mindset',
    source: 'instagram',
    mode: 'fast',
    maxResults: 1
  });

  const [isSearching, setIsSearching] = useState(false);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalExpanded, setTerminalExpanded] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  // History State
  const [history, setHistory] = useState<SearchSession[]>([]);
  const [selectedHistorySession, setSelectedHistorySession] = useState<SearchSession | null>(null);
  const [totalLeadsGenerated, setTotalLeadsGenerated] = useState(0);

  // Campaigns State
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [showCampaignCreator, setShowCampaignCreator] = useState(false);




  // VSL Stats State
  const [vslStats, setVslStats] = useState({ emailsDelivered: 0, vslClicks: 0, conversions: 0 });



  // Sound Effect
  const playGlassSound = () => {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(1100, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(1600, audioContext.currentTime + 0.1);

      gainNode.gain.setValueAtTime(0, audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.05);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 1.5);

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.start();
      oscillator.stop(audioContext.currentTime + 1.5);
    } catch (e) {
      console.error("Audio play failed", e);
    }
  };

  // Check Session on Mount
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setIsAuthenticated(true);
        setUserId(session.user.id);
        setCurrentPage('dashboard');
        loadProfile(session.user.id);
        loadHistory(session.user.id);
        loadCampaigns(session.user.id);
      }
    });

    return () => {
      searchService.stop();
    };
  }, []);

  const loadProfile = async (uid: string) => {
    try {
      // First, get user email from auth session
      const { data: { session } } = await supabase.auth.getSession();
      const userEmail = session?.user?.email || '';

      // DEFENSIVE: Ensure profile exists (upsert)
      // This fixes the case where the user was created BEFORE the trigger existed
      const { error: upsertError } = await supabase
        .from('profiles')
        .upsert({
          id: uid,
          email: userEmail,
          full_name: userEmail.split('@')[0], // fallback name from email
          updated_at: new Date().toISOString()
        }, { onConflict: 'id' });

      if (upsertError) {
        console.warn('[Profile] Upsert warning:', upsertError.message);
      }

      // Now load the profile
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .eq('id', uid)
        .single();

      if (data) {
        if (data.full_name) {
          setUserName(data.full_name);
        }
      }
    } catch (e) {
      console.error('Error loading profile', e);
    }
  };

  const loadHistory = async (uid: string) => {
    try {
      // Load search history first
      const { data: searchData, error: searchError } = await supabase
        .from('search_history')
        .select('*')
        .eq('user_id', uid)
        .order('executed_at', { ascending: false });

      if (searchError) {
        console.error('DB Error loading history:', searchError);
        addLog(`[DB] ⚠️ Error cargando historial: ${searchError.message}`);
        return;
      }

      if (searchData && searchData.length > 0) {
        // For each search session, load associated leads
        const sessions: SearchSession[] = await Promise.all(
          searchData.map(async (row) => {
            // Load leads for this search session
            const { data: leadsData, error: leadsError } = await supabase
              .from('leads')
              .select('*')
              .eq('search_id', row.id);

            let leads: Lead[] = [];
            if (leadsError) {
              console.warn(`[HISTORY] Error loading leads for session ${row.id}:`, leadsError);
            } else if (leadsData && leadsData.length > 0) {
              // Transform DB leads to Lead interface
              leads = leadsData.map(l => ({
                id: l.id,
                source: row.source as any || 'instagram',
                ig_handle: l.ig_handle || '',
                follower_count: l.follower_count || 0,
                niche: l.niche || '',
                audience_tier: l.audience_tier as any || 'nano',
                vsl_sent_status: l.vsl_sent_status as any || 'pending',
                email_status: l.email_status || 'pending',
                location: l.location,
                decisionMaker: {
                  name: l.name,
                  role: l.job_title || 'Content Creator',
                  email: l.email || '',
                  instagram: l.ig_handle ? 'https://instagram.com/' + l.ig_handle : ''
                },
                aiAnalysis: {
                  summary: l.ai_summary || '',
                  painPoints: l.ai_pain_points || [],
                  generatedIcebreaker: '',
                  coldEmailSubject: l.cold_email_subject || '',
                  coldEmailBody: l.cold_email_body || '',
                  vslPitch: l.vsl_pitch || '',
                  fullAnalysis: l.ai_summary || '',
                  psychologicalProfile: '',
                  engagementSignal: '',
                  salesAngle: ''
                },
                status: l.status as any || 'scraped'
              }));
            }

            return {
              id: row.id,
              date: new Date(row.executed_at),
              query: row.search_query || '',
              source: row.source as any || 'linkedin',
              resultsCount: leads.length || row.results_extracted || 0,
              leads: leads
            };
          })
        );

        setHistory(sessions);
        const leadsSum = sessions.reduce((sum, s) => sum + s.leads.length, 0);
        setTotalLeadsGenerated(leadsSum);
        console.log(`[HISTORY] Cargadas ${sessions.length} búsquedas con ${leadsSum} leads del cloud`);
      }
    } catch (e) {
      console.error('Error loading history', e);
    }
  };

  const loadCampaigns = async (uid: string) => {
    try {
      const { data, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: false });
      if (error) { console.warn('[CAMPAIGNS] Load error:', error.message); return; }
      if (data) {
        setCampaigns(data.map(r => ({
          id: r.id,
          name: r.name,
          description: r.description,
          status: r.status,
          hashtags: r.hashtags ?? [],
          icpFilters: {
            minFollowers: r.icp_min_followers ?? 0,
            maxFollowers: r.icp_max_followers ?? 99_000_000,
            regions: r.icp_regions ?? [],
            contentTypes: r.icp_content_types ?? [],
            campaignName: r.name,
          },
          totalLeads: r.total_leads ?? 0,
          createdAt: new Date(r.created_at),
          userId: r.user_id,
        })));
      }
    } catch (e) {
      console.error('[CAMPAIGNS] Exception:', e);
    }
  };

  // Auth Handlers
  const handleLogin = () => {
    // Called after successful Supabase login
    setIsAuthenticated(true);
    setCurrentPage('dashboard');
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setUserId(session.user.id);
        loadProfile(session.user.id);
        loadHistory(session.user.id);
        loadCampaigns(session.user.id);
      }
    });
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setIsAuthenticated(false);
    setUserId(null);
    setUserName('');
    setCurrentPage('login');
    setLogs([]);
    setLeads([]);
    setTerminalVisible(false);
    searchService.stop();
  };

  const addLog = (message: string) => {
    setLogs(prev => [...prev, message]);
  };

  // Search Logic
  const handleSearch = () => {
    if (!config.query) return;

    setIsSearching(true);
    setTerminalVisible(true);
    setTerminalExpanded(true);
    setLogs([]);
    setLeads([]);

    searchService.startSearch(
      config,
      // onLog
      (message) => addLog(message),
      // onComplete
      async (results) => {
        setIsSearching(false);
        setLeads(results);

        // Add to history (Local)
        const newSession: SearchSession = {
          id: Date.now().toString(),
          date: new Date(),
          query: config.query,
          source: config.source,
          resultsCount: results.length,
          leads: results
        };
        setHistory(prev => [newSession, ...prev]);
        setTotalLeadsGenerated(prev => prev + results.length);

        // Save to Supabase (Cloud)
        if (userId) {
          try {
            // 1. Insert search record and get ID
            const { data, error: searchError } = await supabase
              .from('search_history')
              .insert({
                user_id: userId,
                search_query: config.query,
                source: config.source,
                mode: config.mode,
                total_results: results.length,
                results_extracted: results.length,
                status: 'completed',
                executed_at: new Date().toISOString(),
                completed_at: new Date().toISOString()
              })
              .select();

            if (searchError) {
              console.error('DB Error saving search_history:', searchError);
              addLog(`[DB] Error saving search: ${searchError.message}`);
              return;
            }

            if (!data || data.length === 0) {
              addLog('[DB] No search ID returned.');
              return;
            }

            const searchId = data[0].id;
addLog(`[DB] Search registered (ID: ${searchId})`);

            // 2. Save each lead to the leads table with search_id reference
            const leadsToInsert = results.map(lead => ({
              user_id: userId,
              search_id: searchId,
              name: lead.decisionMaker?.name || ('@' + lead.ig_handle) || '',
              ig_handle: lead.ig_handle || '',
              follower_count: lead.follower_count || 0,
              niche: lead.niche || '',
              audience_tier: lead.audience_tier || 'nano',
              job_title: lead.decisionMaker?.role || 'Content Creator',
              email: lead.decisionMaker?.email || '',
              location: lead.location || '',
              ai_summary: lead.aiAnalysis?.summary || '',
              ai_pain_points: lead.aiAnalysis?.painPoints || [],
              cold_email_subject: lead.aiAnalysis?.coldEmailSubject || '',
              cold_email_body: lead.aiAnalysis?.coldEmailBody || '',
              vsl_pitch: lead.aiAnalysis?.vslPitch || '',
              vsl_sent_status: lead.vsl_sent_status || 'pending',
              email_status: lead.email_status || 'pending',
              status: 'scraped'
            }));

            const { error: leadsError } = await supabase
              .from('leads')
              .insert(leadsToInsert);

            if (leadsError) {
              console.error('DB Error saving leads:', leadsError);
              addLog(`[DB] Error saving ${results.length} leads: ${leadsError.message}`);
            } else {
              addLog(`[DB] ${results.length} creators saved.`);
            }
          } catch (err) {
            console.error('Failed to save results to DB', err);
            addLog(`[ERROR] Excepción al guardar: ${err}`);
          }
        } else {
          addLog('[WARNING] Not saved to cloud (user not authenticated).');
        }

        playGlassSound();
        setTimeout(() => setTerminalExpanded(false), 1500);
      },
      // userId para deduplicación
      userId
    );
  };

  const handleStop = () => {
    if (isSearching) {
      searchService.stop();
      setIsSearching(false);
      setTerminalExpanded(false);
      addLog('[STOP] Search stopped manually.');
    }
  };

  const handleConfigChange = (updates: Partial<SearchConfigState>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  };

  const handleViewSessionResults = (session: SearchSession) => {
    setSelectedHistorySession(session);
  };

  // --- Views ---

  if (!isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/30">
      <Header
        currentPage={currentPage}
        onNavigate={setCurrentPage}
        onLogout={handleLogout}
        userName={userName}
      />

      <main className="max-w-7xl mx-auto px-6 py-8">

        {currentPage === 'dashboard' && (
          <div className="animate-[fadeIn_0.3s_ease-out]">
            <div className="max-w-4xl mx-auto mb-10 text-center space-y-2">
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
                Flow<span className="text-primary">Next</span>
              </h1>
              <p className="text-muted-foreground text-sm">Find. Connect. Convert.</p>
            </div>

            {/* VSL Stats Widget */}
            <div className="grid grid-cols-3 gap-4 mb-8">
              <div className="glass-card border border-border rounded-xl p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">Emails Delivered</p>
                <p className="text-3xl font-bold text-primary">{vslStats.emailsDelivered}</p>
              </div>
              <div className="glass-card border border-border rounded-xl p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">VSL Clicks</p>
                <p className="text-3xl font-bold" style={{ color: '#7c3aed' }}>{vslStats.vslClicks}</p>
              </div>
              <div className="glass-card border border-border rounded-xl p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">Conversions</p>
                <p className="text-3xl font-bold text-primary">{vslStats.conversions}</p>
              </div>
            </div>
          </div>
        )}

        {currentPage === 'campaigns' && (
          <div className="animate-[fadeIn_0.3s_ease-out] space-y-6">
            <SearchConfig
              config={config}
              onChange={handleConfigChange}
              onSearch={handleSearch}
              onStop={handleStop}
              isSearching={isSearching}
              totalLeadsGenerated={totalLeadsGenerated}
            />

            <AgentTerminal
              logs={logs}
              isVisible={terminalVisible}
              isExpanded={terminalExpanded}
              onToggleExpand={() => setTerminalExpanded(!terminalExpanded)}
            />

            <LeadsTable
              leads={leads}
              onViewMessage={setSelectedLead}
            />

            <CampaignsView
              history={history}
              campaigns={campaigns}
              onSelectSession={handleViewSessionResults}
              onCreateCampaign={() => setShowCampaignCreator(true)}
            />
          </div>
        )}

      </main>

      {/* Message Draft Modal */}
      {selectedLead && (
        <MessageModal
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
        />
      )}

      {/* Search History Results Popup */}
      {selectedHistorySession && (
        <HistoryModal
          session={selectedHistorySession}
          onClose={() => setSelectedHistorySession(null)}
          onViewMessage={setSelectedLead}
        />
      )}

      {/* Campaign Creator Modal */}
      {showCampaignCreator && userId && (
        <CampaignCreatorModal
          userId={userId}
          onClose={() => setShowCampaignCreator(false)}
          onCreated={(campaign) => {
            setCampaigns(prev => [campaign, ...prev]);
            setShowCampaignCreator(false);
          }}
        />
      )}
    </div>
  );
}

export default App;
