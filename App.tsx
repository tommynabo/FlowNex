import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Header } from './components/Header';
import { SearchConfig } from './components/SearchConfig';
import { AgentTerminal } from './components/AgentTerminal';
import { LeadsTable } from './components/LeadsTable';
import { MessageModal } from './components/MessageModal';
import { LoginPage } from './components/LoginPage';
import { CampaignsView } from './components/CampaignsView';
import { CampaignDetailsView } from './components/CampaignDetailsView';
import { CampaignCreatorModal } from './components/CampaignCreatorModal';
import { HistoryModal } from './components/HistoryModal';
import { SetterDashboard } from './components/SetterDashboard';
import { Lead, SearchConfigState, PageView, SearchSession, Campaign } from './lib/types';
import { PROJECT_CONFIG } from './config/project';
import { searchService } from './services/search/SearchService';
import { supabase } from './lib/supabase';

function App() {
  // Navigation & Auth State

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>('');
  // Routing logic replaces currentPage state

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
  // activeCampaign derived from URL
  const [showCampaignCreator, setShowCampaignCreator] = useState(false);
  const [campaignLeads, setCampaignLeads] = useState<Lead[]>([]);
  const [lastSearchCount, setLastSearchCount] = useState(0);

  // AI Setter State
  const [setterLogs, setSetterLogs] = useState<string[]>([]);
  const [setterTerminalVisible, setSetterTerminalVisible] = useState(false);
  const [setterTerminalExpanded, setSetterTerminalExpanded] = useState(true);

  const navigate = useNavigate();
  const location = useLocation();

  let currentPage: PageView = 'login';
  if (location.pathname === '/' && isAuthenticated) currentPage = 'dashboard';
  else if (location.pathname === '/login') currentPage = 'login';
  else if (location.pathname.startsWith('/campa')) currentPage = 'campaigns';
  else if (location.pathname.startsWith('/setter')) currentPage = 'setter';

  const activeCampaignName = location.pathname.startsWith('/campa') ? decodeURIComponent(location.pathname.split('/')[2] || '') : null;
  const activeCampaign = activeCampaignName ? campaigns.find(c => c.name === activeCampaignName) || null : null;

  const handleNavigate = (page: PageView) => {
    switch (page) {
      case 'dashboard': navigate('/'); break;
      case 'campaigns': navigate('/campa\u00f1as'); break;
      case 'setter': navigate('/setter'); break;
      case 'login': navigate('/login'); break;
    }
  };

  const handleSelectCampaign = (c: Campaign | null) => {
    if (c) {
      navigate('/campa\u00f1as/' + encodeURIComponent(c.name));
    } else {
      navigate('/campa\u00f1as');
    }
  };

  const addSetterLog = (message: string) => {
    setSetterLogs(prev => [...prev, message]);
    setSetterTerminalVisible(true);
  };




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
        handleNavigate('dashboard');
        loadProfile(session.user.id);
        loadHistory(session.user.id);
        loadCampaigns(session.user.id);
      }
    });

    return () => {
      searchService.stop();
    };
  }, []);

  // Sync config and load leads when entering a campaign
  useEffect(() => {
    if (activeCampaign) {
      const hashtags = activeCampaign.hashtags.map(h => `#${h}`).join(' OR ');
      setConfig(prev => ({
        ...prev,
        query: hashtags || prev.query,
        icpFilters: activeCampaign.icpFilters
      }));
      if (userId) loadCampaignLeads(activeCampaign.id);
    } else {
      setCampaignLeads([]);
    }
  }, [activeCampaign?.id]);

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
            icpType: (r.icp_type as import('./lib/types').ICPType) ?? 'personal_brand',
          },
          totalLeads: r.total_leads ?? 0,
          createdAt: new Date(r.created_at),
          userId: r.user_id,
          instantlyCampaignId: r.instantly_campaign_id ?? undefined,
        })));
      }
    } catch (e) {
      console.error('[CAMPAIGNS] Exception:', e);
    }
  };

  const loadCampaignLeads = async (campaignId: string) => {
    try {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false });
      if (error) { console.warn('[CAMPAIGN_LEADS] Load error:', error.message); return; }
      if (data) {
        const mapped: Lead[] = data.map(l => ({
          id: l.id,
          source: 'instagram' as const,
          ig_handle: l.ig_handle || '',
          follower_count: l.follower_count || 0,
          niche: l.niche || '',
          audience_tier: (l.audience_tier || 'nano') as any,
          vsl_sent_status: (l.vsl_sent_status || 'pending') as any,
          email_status: (l.email_status || 'pending') as any,
          location: l.location,
          website: l.website || '',
          decisionMaker: {
            name: l.name || '',
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
          status: (l.status || 'scraped') as any,
          icp_verified: l.icp_verified ?? false
        }));
        setCampaignLeads(mapped);
      }
    } catch (e) {
      console.error('[CAMPAIGN_LEADS] Exception:', e);
    }
  };

  // Auth Handlers
  const handleLogin = () => {
    // Called after successful Supabase login
    setIsAuthenticated(true);
    handleNavigate('dashboard');
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
    handleNavigate('login');
    setLogs([]);
    setLeads([]);
    setTerminalVisible(false);
    searchService.stop();
  };

  const addLog = (message: string) => {
    setLogs(prev => [...prev, message]);
  };

  // Search Logic
  const handleSearch = async () => {
    if (!config.query) return;

    setIsSearching(true);
    setTerminalVisible(true);
    setTerminalExpanded(true);
    setLogs([]);
    setLeads([]);

    // ── Create search_history record BEFORE the search starts (Streaming — Pilar 4) ──
    // Having the searchId upfront allows each lead to be saved to Supabase as soon
    // as it's found, rather than waiting for the full run to complete.
    let activeSearchId: string | null = null;
    if (userId) {
      try {
        const { data: shData, error: shErr } = await supabase
          .from('search_history')
          .insert({
            user_id: userId,
            search_query: config.query,
            source: config.source,
            mode: config.mode,
            total_results: 0,
            results_extracted: 0,
            status: 'running',
            executed_at: new Date().toISOString(),
            ...(activeCampaign ? { campaign_id: activeCampaign.id } : {})
          })
          .select();
        if (!shErr && shData && shData.length > 0) {
          activeSearchId = shData[0].id as string;
          addLog('[DB] Search iniciado (ID: ' + activeSearchId + ')');
        }
      } catch { /* non-fatal — search continues, falls back to bulk save in onComplete */ }
    }

    // Helper: maps a Lead to the leads table row shape
    const leadToRow = (lead: Lead, searchId: string) => ({
      user_id: userId!,
      search_id: searchId,
      ...(activeCampaign ? { campaign_id: activeCampaign.id } : {}),
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
      status: 'scraped',
      icp_verified: lead.icp_verified ?? false
    });

    // Streaming counter — tracks how many leads arrived via onLeadFound
    let streamedCount = 0;

    searchService.startSearch(
      { ...config, ...(activeCampaign?.instantlyCampaignId ? { instantlyCampaignId: activeCampaign.instantlyCampaignId } : {}) },
      // onLog
      (message) => addLog(message),
      // onComplete
      async (results) => {
        setIsSearching(false);
        setLeads(results);
        setLastSearchCount(results.length);

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
        // Only add to total if not already counted by onLeadFound
        if (streamedCount === 0) {
          setTotalLeadsGenerated(prev => prev + results.length);
        }

        // Save to Supabase (Cloud)
        if (userId) {
          console.log('[DB] onComplete: userId:', userId, '| activeSearchId:', activeSearchId, '| results:', results.length);
          try {
            if (activeSearchId) {
              // Streaming path: search_history already exists — update final stats
              await supabase
                .from('search_history')
                .update({
                  total_results: results.length,
                  results_extracted: results.length,
                  status: 'completed',
                  completed_at: new Date().toISOString(),
                })
                .eq('id', activeSearchId);
              addLog('[DB] ✅ ' + results.length + ' creators saved (streaming).');
              if (activeCampaign) {
                loadCampaignLeads(activeCampaign.id);
                loadCampaigns(userId);
              }
            } else {
              // Fallback bulk path: search_history creation failed earlier —
              // create it now and save all leads at once (old behavior)
              console.warn('[DB] No activeSearchId — falling back to bulk save');
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
                  completed_at: new Date().toISOString(),
                  ...(activeCampaign ? { campaign_id: activeCampaign.id } : {})
                })
                .select();

              if (searchError) {
                console.error('[DB] ❌ search_history INSERT failed:', searchError);
                addLog(`[DB] Error saving search: ${searchError.message}`);
              } else if (data && data.length > 0) {
                const searchId = data[0].id as string;
                addLog(`[DB] Search registered (ID: ${searchId})`);
                const leadsToInsert = results.map(lead => leadToRow(lead, searchId));
                const { error: leadsError } = await supabase.from('leads').insert(leadsToInsert);
                if (leadsError) {
                  addLog(`[DB] Error saving ${results.length} leads: ${leadsError.message}`);
                } else {
                  addLog(`[DB] ${results.length} creators saved.`);
                  if (activeCampaign) {
                    loadCampaignLeads(activeCampaign.id);
                    loadCampaigns(userId);
                  }
                }
              }
            }
          } catch (err) {
            console.error('Failed to save results to DB', err);
            addLog(`[ERROR] Excepción al guardar: ${err}`);
          }
        } else {
          console.warn('[DB] ⚠ userId is null — lead NOT saved to Supabase!');
          addLog('[WARNING] Not saved to cloud (user not authenticated).');
        }

        playGlassSound();
        setTimeout(() => setTerminalExpanded(false), 1500);
      },
      // userId para deduplicación
      userId,
      // onLeadFound — Streaming (Pilar 4): display and save each lead as it arrives.
      // The screen starts populating within seconds while the engine continues working.
      async (lead: Lead) => {
        streamedCount++;
        setLeads(prev => [...prev, lead]);
        setTotalLeadsGenerated(prev => prev + 1);
        if (userId && activeSearchId) {
          try {
            await supabase.from('leads').insert(leadToRow(lead, activeSearchId));
          } catch (e) {
            console.warn('[DB] onLeadFound: save failed for @' + lead.ig_handle, e);
          }
        }
      }
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
        onNavigate={handleNavigate}
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

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              <div className="glass-card border border-border rounded-xl p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">Mails Mandados</p>
                <p className="text-3xl font-bold text-primary">{vslStats.emailsDelivered}</p>
              </div>
              <div className="glass-card border border-border rounded-xl p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">Leads Encontrados</p>
                <p className="text-3xl font-bold" style={{ color: '#7c3aed' }}>{totalLeadsGenerated}</p>
              </div>
              <div className="glass-card border border-border rounded-xl p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">Respondidos</p>
                <p className="text-3xl font-bold text-primary">{vslStats.conversions}</p>
              </div>
              <div className="glass-card border border-border rounded-xl p-4 text-center">
                <p className="text-xs text-muted-foreground mb-1">Total Campañas</p>
                <p className="text-3xl font-bold" style={{ color: '#10b981' }}>{campaigns.length}</p>
              </div>
            </div>
          </div>
        )}



        {currentPage === 'campaigns' && (
          <div className="animate-[fadeIn_0.3s_ease-out] space-y-6">
            <div className="bg-card border border-border rounded-xl p-6">
              {activeCampaign ? (
                <CampaignDetailsView 
                  campaign={activeCampaign}
                  onBack={() => handleSelectCampaign(null)}
                  config={config}
                  onChangeConfig={handleConfigChange}
                  onSearch={handleSearch}
                  onStop={handleStop}
                  isSearching={isSearching}
                  totalLeadsGenerated={totalLeadsGenerated}
                  terminalVisible={terminalVisible}
                  terminalExpanded={terminalExpanded}
                  onToggleTerminal={() => setTerminalExpanded(!terminalExpanded)}
                  logs={logs}
                  leads={(() => {
                    const sessionHandles = new Set(leads.map(l => l.ig_handle));
                    const historical = campaignLeads.filter(cl => !sessionHandles.has(cl.ig_handle));
                    return [...leads, ...historical];
                  })()}
                  onViewMessage={setSelectedLead}
                  lastSearchCount={lastSearchCount}
                />
              ) : (
                <CampaignsView
                  campaigns={campaigns}
                  onSelectCampaign={handleSelectCampaign}
                  onCreateCampaign={() => setShowCampaignCreator(true)}
                />
              )}
            </div>
          </div>
        )}



        {currentPage === 'setter' && userId && (
          <div className="animate-[fadeIn_0.3s_ease-out] space-y-6">
            <SetterDashboard
              userId={userId}
              onLog={addSetterLog}
            />
            <AgentTerminal
              logs={setterLogs}
              isVisible={setterTerminalVisible}
              isExpanded={setterTerminalExpanded}
              onToggleExpand={() => setSetterTerminalExpanded(!setterTerminalExpanded)}
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
