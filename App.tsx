import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { SearchConfig } from './components/SearchConfig';
import { SearchCriteriaModal } from './components/SearchCriteriaModal';
import { AgentTerminal } from './components/AgentTerminal';
import { LeadsTable } from './components/LeadsTable';
import { MessageModal } from './components/MessageModal';
import { LoginPage } from './components/LoginPage';
import { CampaignsView } from './components/CampaignsView';
import { HistoryModal } from './components/HistoryModal';
import { Lead, SearchConfigState, PageView, SearchSession } from './lib/types';
import { PROJECT_CONFIG } from './config/project';
import { searchService } from './services/search/SearchService';
import { autopilotService } from './services/autopilot/AutopilotService';
import { supabase } from './lib/supabase';

function App() {
  // Navigation & Auth State
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>('');
  const [currentPage, setCurrentPage] = useState<PageView>('login');

  // Search State
  const [config, setConfig] = useState<SearchConfigState>({
    query: "",
    source: 'linkedin',
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

  // Autopilot State
  const [autopilotEnabled, setAutopilotEnabled] = useState(autopilotService.getConfig().enabled);
  const [autopilotTime, setAutopilotTime] = useState(autopilotService.getConfig().scheduledTime);
  const [autopilotQuantity, setAutopilotQuantity] = useState(autopilotService.getConfig().leadsQuantity);

  // Modal State
  const [isCriteriaModalOpen, setIsCriteriaModalOpen] = useState(false);

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
      }
    });

    // Initialize autopilot monitoring
    autopilotService.initialize();

    return () => {
      searchService.stop();
      autopilotService.destroy();
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
                source: row.source as any || 'linkedin',
                companyName: l.company_name || 'Sin Nombre',
                website: l.company_website,
                location: l.location,
                decisionMaker: {
                  name: l.name,
                  role: l.job_title || '',
                  email: l.email || '',
                  phone: l.phone,
                  linkedin: l.linkedin_url,
                  facebook: l.facebook_url,
                  instagram: l.instagram_url
                },
                aiAnalysis: {
                  summary: l.ai_summary || '',
                  painPoints: l.ai_pain_points || [],
                  generatedIcebreaker: '',
                  fullMessage: '',
                  fullAnalysis: l.ai_summary || '',
                  psychologicalProfile: '',
                  businessMoment: l.ai_business_moment || '',
                  salesAngle: ''
                },
                isNPLPotential: l.ai_is_npl_potential || false,
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
              addLog(`[DB] ⚠️ Error al guardar búsqueda: ${searchError.message}`);
              return;
            }

            if (!data || data.length === 0) {
              addLog(`[DB] ⚠️ No se obtuvo ID de búsqueda.`);
              return;
            }

            const searchId = data[0].id;
            addLog(`[DB] ✅ Búsqueda registrada (ID: ${searchId})`);

            // 2. Save each lead to the leads table with search_id reference
            const leadsToInsert = results.map(lead => ({
              user_id: userId,
              search_id: searchId,
              name: lead.decisionMaker?.name || lead.companyName || '',
              company_name: lead.companyName || '',
              job_title: lead.decisionMaker?.role || '',
              linkedin_url: lead.decisionMaker?.linkedin || '',
              email: lead.decisionMaker?.email || '',
              phone: lead.decisionMaker?.phone || '',
              company_website: lead.website || '',
              location: lead.location || '',
              ai_summary: lead.aiAnalysis?.summary || '',
              ai_pain_points: lead.aiAnalysis?.painPoints || [],
              ai_business_moment: lead.aiAnalysis?.businessMoment || '',
              ai_is_npl_potential: lead.isNPLPotential || false,
              status: 'scraped'
            }));

            const { error: leadsError } = await supabase
              .from('leads')
              .insert(leadsToInsert);

            if (leadsError) {
              console.error('DB Error saving leads:', leadsError);
              addLog(`[DB] ⚠️ Error al guardar ${results.length} contactos: ${leadsError.message}`);
            } else {
              addLog(`[DB] ✅ ${results.length} contactos guardados correctamente.`);
            }
          } catch (err) {
            console.error('Failed to save results to DB', err);
            addLog(`[ERROR] Excepción al guardar: ${err}`);
          }
        } else {
          addLog('[⚠️] No se guardó en la nube (usuario no autenticado).');
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
      addLog('[USUARIO] 🛑 Generación detenida manualmente.');
      autopilotService.markSearchComplete();
    }
  };

  // --- Lead Actions (removed - no longer needed) ---

  // --- Autopilot Logic ---

  const executeAutopilotSearch = (quantity: number) => {
    const autopilotConfig = { ...config, maxResults: quantity };

    setIsSearching(true);
    setTerminalVisible(true);
    setTerminalExpanded(true);
    setLogs([]);
    setLeads([]);

    searchService.startSearch(
      autopilotConfig,
      (message) => addLog(message),
      async (results) => {
        setIsSearching(false);
        setLeads(results);

        const newSession: SearchSession = {
          id: Date.now().toString(),
          date: new Date(),
          query: autopilotConfig.query,
          source: autopilotConfig.source,
          resultsCount: results.length,
          leads: results
        };
        setHistory(prev => [newSession, ...prev]);
        setTotalLeadsGenerated(prev => prev + results.length);

        if (userId) {
          try {
            // 1. Insert search record and get ID
            const { data, error: searchError } = await supabase
              .from('search_history')
              .insert({
                user_id: userId,
                search_query: autopilotConfig.query,
                source: autopilotConfig.source,
                mode: autopilotConfig.mode,
                total_results: results.length,
                results_extracted: results.length,
                status: 'completed',
                executed_at: new Date().toISOString(),
                completed_at: new Date().toISOString()
              })
              .select();

            if (searchError) {
              console.error('DB Error saving search_history:', searchError);
              addLog(`[AUTOPILOT] ⚠️ Error al guardar búsqueda: ${searchError.message}`);
              return;
            }

            if (!data || data.length === 0) {
              addLog(`[AUTOPILOT] ⚠️ No se obtuvo ID de búsqueda.`);
              return;
            }

            const searchId = data[0].id;
            addLog(`[AUTOPILOT] ✅ Búsqueda registrada (ID: ${searchId})`);

            // 2. Save each lead to the leads table with search_id reference
            const leadsToInsert = results.map(lead => ({
              user_id: userId,
              search_id: searchId,
              name: lead.decisionMaker?.name || lead.companyName || '',
              company_name: lead.companyName || '',
              job_title: lead.decisionMaker?.role || '',
              linkedin_url: lead.decisionMaker?.linkedin || '',
              email: lead.decisionMaker?.email || '',
              phone: lead.decisionMaker?.phone || '',
              company_website: lead.website || '',
              location: lead.location || '',
              ai_summary: lead.aiAnalysis?.summary || '',
              ai_pain_points: lead.aiAnalysis?.painPoints || [],
              ai_business_moment: lead.aiAnalysis?.businessMoment || '',
              ai_is_npl_potential: lead.isNPLPotential || false,
              status: 'scraped'
            }));

            const { error: leadsError } = await supabase
              .from('leads')
              .insert(leadsToInsert);

            if (leadsError) {
              console.error('DB Error saving leads:', leadsError);
              addLog(`[AUTOPILOT] ⚠️ Error al guardar ${results.length} contactos: ${leadsError.message}`);
            } else {
              addLog(`[AUTOPILOT] ✅ ${results.length} contactos guardados correctamente.`);
            }
          } catch (err) {
            console.error('Failed to save autopilot results to DB', err);
            addLog(`[AUTOPILOT] ❌ Excepción al guardar: ${err}`);
          }
        }

        autopilotService.markSearchComplete();
        playGlassSound();
        setTimeout(() => setTerminalExpanded(false), 1500);
      },
      userId
    );
  };

  useEffect(() => {
    autopilotService.setCallbacks(executeAutopilotSearch, addLog);
  }, [userId, config]);

  const handleAutopilotToggle = (enabled: boolean) => {
    setAutopilotEnabled(enabled);
    if (enabled) {
      autopilotService.enable(autopilotTime, autopilotQuantity);
    } else {
      autopilotService.disable();
    }
  };

  const handleAutopilotTimeChange = (time: string) => {
    setAutopilotTime(time);
    autopilotService.updateTime(time);
    if (autopilotEnabled) {
      autopilotService.enable(time, autopilotQuantity);
    }
  };

  const handleAutopilotQuantityChange = (quantity: number) => {
    setAutopilotQuantity(quantity);
    autopilotService.updateQuantity(quantity);
    if (autopilotEnabled) {
      autopilotService.enable(autopilotTime, quantity);
    }
  };

  const handleConfigChange = (updates: Partial<SearchConfigState>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  };

  const handleOpenCriteria = () => {
    setIsCriteriaModalOpen(true);
  };

  const handleSaveCriteria = (newQuery: string, filters?: any) => {
    setConfig(prev => ({
      ...prev,
      query: newQuery,
      advancedFilters: filters
    }));
    setIsCriteriaModalOpen(false);
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
                Apex<span className="text-primary">Engine</span>
              </h1>
            </div>

            <SearchConfig
              config={config}
              onChange={handleConfigChange}
              onSearch={handleSearch}
              onStop={handleStop}
              isSearching={isSearching}
              onOpenCriteria={handleOpenCriteria}
              autopilotEnabled={autopilotEnabled}
              autopilotTime={autopilotTime}
              autopilotQuantity={autopilotQuantity}
              onAutopilotToggle={handleAutopilotToggle}
              onAutopilotTimeChange={handleAutopilotTimeChange}
              onAutopilotQuantityChange={handleAutopilotQuantityChange}
              autopilotRanToday={autopilotService.hasRunToday()}
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
          </div>
        )}

        {currentPage === 'campaigns' && (
          <CampaignsView
            history={history}
            onSelectSession={handleViewSessionResults}
          />
        )}

      </main>

      {/* Search Criteria Modal */}
      <SearchCriteriaModal
        isOpen={isCriteriaModalOpen}
        onClose={() => setIsCriteriaModalOpen(false)}
        currentQuery={config.query}
        onSave={handleSaveCriteria}
      />

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
    </div>
  );
}

export default App;
