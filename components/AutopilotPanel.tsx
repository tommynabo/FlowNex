import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Campaign, AutopilotRun, TikTokQueueStats } from '../lib/types';
import { supabase } from '../lib/supabase';
import {
  Bot,
  Clock,
  TrendingUp,
  CheckCircle,
  XCircle,
  Loader2,
  Save,
  ToggleLeft,
  ToggleRight,
  AlertCircle,
  Globe,
  Upload,
  Inbox,
  Trash2,
} from 'lucide-react';

interface AutopilotPanelProps {
  campaign: Campaign;
  onUpdate: (updates: Partial<Campaign>) => void;
}

// Curated IANA timezone list — covers Spain + main EN-speaking markets
const TIMEZONES: { label: string; value: string }[] = [
  { label: 'UTC (Universal)',             value: 'UTC' },
  { label: 'Europa / Madrid (CET/CEST)',  value: 'Europe/Madrid' },
  { label: 'Europa / London (GMT/BST)',   value: 'Europe/London' },
  { label: 'Europa / Paris',             value: 'Europe/Paris' },
  { label: 'Europa / Berlin',            value: 'Europe/Berlin' },
  { label: 'Europa / Lisbon',            value: 'Europe/Lisbon' },
  { label: 'América / New York (ET)',     value: 'America/New_York' },
  { label: 'América / Chicago (CT)',      value: 'America/Chicago' },
  { label: 'América / Denver (MT)',       value: 'America/Denver' },
  { label: 'América / Los Angeles (PT)', value: 'America/Los_Angeles' },
  { label: 'América / Toronto',          value: 'America/Toronto' },
  { label: 'América / Vancouver',        value: 'America/Vancouver' },
  { label: 'América / México City',      value: 'America/Mexico_City' },
  { label: 'América / Bogotá',           value: 'America/Bogota' },
  { label: 'América / Lima',             value: 'America/Lima' },
  { label: 'América / Buenos Aires',     value: 'America/Argentina/Buenos_Aires' },
  { label: 'América / Santiago',         value: 'America/Santiago' },
  { label: 'América / São Paulo',        value: 'America/Sao_Paulo' },
  { label: 'América / Caracas',          value: 'America/Caracas' },
  { label: 'Australia / Sydney (AEST)',  value: 'Australia/Sydney' },
  { label: 'Pacific / Auckland (NZST)', value: 'Pacific/Auckland' },
  { label: 'Asia / Dubai (GST)',         value: 'Asia/Dubai' },
];

// Detect browser's IANA timezone, fallback to Europe/Madrid
function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid';
  } catch {
    return 'Europe/Madrid';
  }
}

// Get current hour (0–23) in a given IANA timezone
function getCurrentHourInTz(timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
    return h % 24;
  } catch {
    return new Date().getUTCHours();
  }
}

const fmt24 = (h: number, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

const parseTime = (s: string): { hour: number; minute: number } => {
  const [h, m] = (s || '00:00').split(':').map(Number);
  return { hour: isNaN(h) ? 0 : h % 24, minute: isNaN(m) ? 0 : m % 60 };
};

// Quick-select preset times shown as pill buttons under each time input
const TIME_PRESETS = [
  '07:00', '08:00', '09:00', '10:00', '12:00',
  '14:00', '16:00', '18:00', '20:00', '21:00',
  '22:00', '22:30', '23:00', '00:00', '02:00', '04:00',
];

// Shared dark input/select classNames
const INPUT_TIME_CLS =
  'w-full bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm focus:border-primary outline-none [color-scheme:dark]';
const SELECT_CLS = INPUT_TIME_CLS;

function estimateNextRun(
  startTime: string,
  endTime: string,
  leadsToday: number,
  dailyLimit: number,
  timezone: string,
): string {
  if (leadsToday >= dailyLimit) return 'Límite diario alcanzado';
  const { hour: sh, minute: sm } = parseTime(startTime);
  const { hour: eh, minute: em } = parseTime(endTime);
  const startMins = sh * 60 + sm;
  const endMins   = eh * 60 + em;
  if (startMins === endMins) return 'Siempre activo'; // no window restriction

  // Current time in the campaign timezone (minutes from midnight)
  let localHour = 0, localMinute = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    localHour   = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10) % 24;
    localMinute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  } catch { /* use 0,0 */ }
  const localMins = localHour * 60 + localMinute;

  // Cron runs every 10 min — find the next :00 / :10 / :20 / :30 / :40 / :50 slot inside the window
  for (let offset = 1; offset <= 144; offset++) {
    const checkMins = (localMins + offset * 10) % (24 * 60);
    const inside = startMins <= endMins
      ? checkMins >= startMins && checkMins < endMins
      : checkMins >= startMins || checkMins < endMins;
    if (inside) {
      const h = Math.floor(checkMins / 60) % 24;
      const m = checkMins % 60;
      return `~${fmt24(h, m)} (local)`;
    }
  }
  return '—';
}

export function AutopilotPanel({ campaign, onUpdate }: AutopilotPanelProps) {
  const ap = campaign.autopilot;

  const [enabled,    setEnabled]    = useState(ap?.enabled    ?? false);
  const [startTime,  setStartTime]  = useState(() => fmt24(ap?.startHour ?? 9,  ap?.startMinute ?? 0));
  const [endTime,    setEndTime]    = useState(() => fmt24(ap?.endHour   ?? 21, ap?.endMinute   ?? 0));
  const [batchSize,  setBatchSize]  = useState(ap?.batchSize  ?? 5);
  const [dailyLimit, setDailyLimit] = useState(ap?.dailyLimit ?? 50);
  const [timezone,   setTimezone]   = useState(ap?.timezone   || detectTimezone());
  const [saving,     setSaving]     = useState(false);
  const [saveOk,     setSaveOk]     = useState(false);
  const [runs,       setRuns]       = useState<AutopilotRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  // ── Cola Manual state ──────────────────────────────────────────────────────
  const [queueStats,    setQueueStats]    = useState<TikTokQueueStats | null>(null);
  const [importing,     setImporting]     = useState(false);
  const [importResult,  setImportResult]  = useState<{ queued: number; skipped_junk: number; skipped_duplicate: number } | null>(null);
  const [importError,   setImportError]   = useState<string | null>(null);
  const [clearing,      setClearing]      = useState(false);
  const [isDragOver,    setIsDragOver]    = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const leadsToday = ap?.leadsToday ?? 0;
  const lastRunAt  = ap?.lastRunAt  ?? null;

  // ── Load queue stats ───────────────────────────────────────────────────────
  const loadQueueStats = useCallback(async () => {
    const { data } = await supabase
      .from('tiktok_handle_queue')
      .select('status')
      .eq('campaign_id', campaign.id);
    if (!data) return;
    const counts: TikTokQueueStats = { pending: 0, processing: 0, passed_icp: 0, failed_icp: 0, no_email: 0, added: 0, total: 0 };
    for (const row of data as Array<{ status: string }>) {
      const s = row.status as keyof Omit<TikTokQueueStats, 'total'>;
      if (s in counts) (counts[s] as number)++;
      counts.total++;
    }
    setQueueStats(counts);
  }, [campaign.id]);

  useEffect(() => { loadQueueStats(); }, [loadQueueStats]);

  // ── Import handler ─────────────────────────────────────────────────────────
  const handleImport = useCallback(async (jsonText: string) => {
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const items: unknown[] = JSON.parse(jsonText);
      if (!Array.isArray(items)) throw new Error('El JSON debe ser un array []');

      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token ?? '';
      if (!jwt) throw new Error('No hay sesión activa. Recarga la página.');

      const res = await fetch('/api/import-tiktok-handles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
        body: JSON.stringify({ campaignId: campaign.id, items }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);

      setImportResult(json);
      await loadQueueStats();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [campaign.id, loadQueueStats]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { if (ev.target?.result) handleImport(ev.target.result as string); };
    reader.readAsText(file);
    e.target.value = '';
  }, [handleImport]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { if (ev.target?.result) handleImport(ev.target.result as string); };
    reader.readAsText(file);
  }, [handleImport]);

  const handleClearPending = useCallback(async () => {
    if (!confirm('¿Eliminar todos los handles pendientes de esta campaña? Esta acción no se puede deshacer.')) return;
    setClearing(true);
    await supabase.from('tiktok_handle_queue').delete().eq('campaign_id', campaign.id).eq('status', 'pending');
    await loadQueueStats();
    setClearing(false);
  }, [campaign.id, loadQueueStats]);

  // Load last 7 runs for this campaign
  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    const { data } = await supabase
      .from('autopilot_runs')
      .select('*')
      .eq('campaign_id', campaign.id)
      .order('started_at', { ascending: false })
      .limit(7);
    if (data) {
      setRuns(data.map((r: Record<string, unknown>) => ({
        id:                   r.id as string,
        campaignId:           r.campaign_id as string,
        userId:               r.user_id as string,
        startedAt:            r.started_at as string,
        finishedAt:           (r.finished_at as string) ?? null,
        leadsFound:           (r.leads_found as number) ?? 0,
        leadsAddedToInstantly: (r.leads_added_to_instantly as number) ?? 0,
        status:               r.status as AutopilotRun['status'],
        errorMessage:         (r.error_message as string) ?? null,
        batchSize:            (r.batch_size as number) ?? null,
        dailyTotalAfter:      (r.daily_total_after as number) ?? null,
        targetLeads:          (r.target_leads as number) ?? null,
      })));
    }
    setLoadingRuns(false);
  }, [campaign.id]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const handleSave = async () => {
    setSaving(true);
    setSaveOk(false);
    const start = parseTime(startTime);
    const end   = parseTime(endTime);
    const { error } = await supabase.from('campaigns').update({
      autopilot_enabled:      enabled,
      autopilot_start_hour:   start.hour,
      autopilot_start_minute: start.minute,
      autopilot_end_hour:     end.hour,
      autopilot_end_minute:   end.minute,
      autopilot_batch_size:   batchSize,
      autopilot_daily_limit:  dailyLimit,
      autopilot_timezone:     timezone,
    }).eq('id', campaign.id);

    setSaving(false);
    if (!error) {
      setSaveOk(true);
      onUpdate({
        autopilot: {
          enabled,
          startHour:   start.hour,
          startMinute: start.minute,
          endHour:     end.hour,
          endMinute:   end.minute,
          batchSize,
          dailyLimit,
          timezone,
          leadsToday,
          resetDate: ap?.resetDate ?? null,
          lastRunAt: ap?.lastRunAt ?? null,
        },
      });
      setTimeout(() => setSaveOk(false), 2500);
    }
  };

  const pct = dailyLimit > 0 ? Math.min(100, Math.round((leadsToday / dailyLimit) * 100)) : 0;
  const startMins = parseTime(startTime).hour * 60 + parseTime(startTime).minute;
  const endMins   = parseTime(endTime).hour   * 60 + parseTime(endTime).minute;

  // UTC offset label for the selected timezone
  const tzOffsetLabel = (() => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short',
      }).formatToParts(new Date());
      return parts.find(p => p.type === 'timeZoneName')?.value ?? '';
    } catch { return ''; }
  })();

  return (
    <div className="space-y-6 animate-[fadeIn_0.3s_ease-out]">

      {/* Toggle */}
      <div className="flex items-center justify-between bg-card border border-border rounded-xl p-5">
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-lg ${enabled ? 'bg-primary/15' : 'bg-secondary'}`}>
            <Bot className={`w-5 h-5 ${enabled ? 'text-primary' : 'text-muted-foreground'}`} />
          </div>
          <div>
            <p className="font-semibold text-sm">Autopilot</p>
            <p className="text-xs text-muted-foreground">
              {enabled ? 'Activo — genera leads automáticamente' : 'Inactivo'}
            </p>
          </div>
        </div>
        <button
          onClick={() => setEnabled(v => !v)}
          className="transition-colors"
          title={enabled ? 'Desactivar autopilot' : 'Activar autopilot'}
        >
          {enabled
            ? <ToggleRight className="w-9 h-9 text-primary" />
            : <ToggleLeft  className="w-9 h-9 text-muted-foreground" />
          }
        </button>
      </div>

      {/* Warning: Instantly Campaign ID not configured */}
      {enabled && !campaign.instantlyCampaignId && (
        <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-xl p-4">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-400">Instantly Campaign ID no configurado</p>
            <p className="text-xs text-muted-foreground mt-1">
              El autopilot encontrará leads pero no los añadirá a Instantly.
              Configura el ID de la campaña de Instantly en la pestaña de configuración de la campaña.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Schedule */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            <h3 className="font-semibold text-sm">Ventana horaria</h3>
          </div>

          {/* Timezone selector */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <Globe className="w-3 h-3" /> Zona horaria
              {tzOffsetLabel && (
                <span className="ml-1 text-primary font-medium">{tzOffsetLabel}</span>
              )}
            </label>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className={SELECT_CLS}
            >
              {TIMEZONES.map(tz => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
          </div>

          {/* Hour pickers */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">Hora inicio</label>
              <input
                type="time"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                className={INPUT_TIME_CLS}
              />
              <div className="flex flex-wrap gap-1 mt-2">
                {TIME_PRESETS.map(t => (
                  <button
                    key={`s-${t}`}
                    type="button"
                    onClick={() => setStartTime(t)}
                    className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                      startTime === t
                        ? 'border-primary text-primary bg-primary/10'
                        : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Hora fin</label>
            <input
              type="time"
              value={endTime}
              onChange={e => setEndTime(e.target.value)}
              className={INPUT_TIME_CLS}
            />
            <div className="flex flex-wrap gap-1 mt-2">
              {TIME_PRESETS.map(t => (
                <button
                  key={`e-${t}`}
                  type="button"
                  onClick={() => setEndTime(t)}
                  className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                    endTime === t
                      ? 'border-primary text-primary bg-primary/10'
                      : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          {startMins === endMins && (
            <p className="text-xs text-yellow-400 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" />
              Inicio y fin iguales: el autopilot nunca se activará.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {startMins > endMins
              ? `Ventana nocturna: ${startTime} → ${endTime} (cruza medianoche)`
              : `Ventana diurna: ${startTime} → ${endTime}`
            }
          </p>
        </div>

        {/* Batch / Limit */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <h3 className="font-semibold text-sm">Volumen</h3>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              Leads por run: <span className="text-foreground font-medium">{batchSize}</span>
            </label>
            <input
              type="range"
              min={1} max={20} step={1}
              value={batchSize}
              onChange={e => setBatchSize(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <div className="flex justify-between text-xs text-muted-foreground mt-0.5">
              <span>1</span><span>20</span>
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              Límite diario: <span className="text-foreground font-medium">{dailyLimit}</span>
            </label>
            <input
              type="range"
              min={5} max={200} step={5}
              value={dailyLimit}
              onChange={e => setDailyLimit(Number(e.target.value))}
              className="w-full accent-primary"
            />
            <div className="flex justify-between text-xs text-muted-foreground mt-0.5">
              <span>5</span><span>200</span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <p className="text-xs text-muted-foreground mb-1">Leads hoy</p>
          <p className="text-2xl font-bold text-primary">{leadsToday}</p>
          <p className="text-xs text-muted-foreground">/ {dailyLimit}</p>
          <div className="mt-2 h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <p className="text-xs text-muted-foreground mb-1">Último run</p>
          <p className="text-sm font-medium">
            {lastRunAt
              ? new Date(lastRunAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
              : '—'}
          </p>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <p className="text-xs text-muted-foreground mb-1">Próximo run</p>
          <p className="text-sm font-medium">
            {enabled
              ? estimateNextRun(startTime, endTime, leadsToday, dailyLimit, timezone)
              : 'Autopilot inactivo'}
          </p>
        </div>
      </div>

      {/* Save button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-60"
        >
          {saving
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : saveOk
              ? <CheckCircle className="w-4 h-4" />
              : <Save className="w-4 h-4" />
          }
          {saving ? 'Guardando…' : saveOk ? 'Guardado' : 'Guardar configuración'}
        </button>
      </div>

      {/* ── Cola Manual de Handles ─────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Inbox className="w-4 h-4 text-primary" />
            <h3 className="font-semibold text-sm">Cola Manual de Handles</h3>
            {queueStats && queueStats.total > 0 && (
              <span className="text-xs bg-primary/10 text-primary border border-primary/20 rounded-full px-2 py-0.5">
                {queueStats.pending} pendientes
              </span>
            )}
          </div>
          <button
            onClick={loadQueueStats}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Actualizar
          </button>
        </div>

        {/* Low-stock alert — shown when ≤ 10 handles remain and queue has been used */}
        {queueStats && queueStats.total > 0 && queueStats.pending <= 10 && (
          <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
            <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-400">
                {queueStats.pending === 0
                  ? 'Cola vacía — el autopilot usará búsquedas Serper'
                  : `Quedan ${queueStats.pending} handle${queueStats.pending === 1 ? '' : 's'} pendientes`
                }
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Sube un nuevo JSON para recargar la cola y no interrumpir el flujo.
              </p>
            </div>
          </div>
        )}

        {/* Drag & drop / click upload zone */}
        <div
          onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`relative flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl p-6 cursor-pointer transition-colors ${
            isDragOver
              ? 'border-primary bg-primary/10'
              : 'border-border hover:border-primary/50 hover:bg-secondary/50'
          } ${importing ? 'pointer-events-none opacity-60' : ''}`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            className="hidden"
          />
          {importing
            ? <Loader2 className="w-6 h-6 text-primary animate-spin" />
            : <Upload className="w-6 h-6 text-muted-foreground" />
          }
          <p className="text-sm text-muted-foreground text-center">
            {importing
              ? 'Procesando JSON…'
              : 'Arrastra el JSON del scraper aquí o haz clic para seleccionar'
            }
          </p>
          <p className="text-xs text-muted-foreground/60">
            dataset_tiktok-profile-scraper_*.json
          </p>
        </div>

        {/* Import result banner */}
        {importResult && (
          <div className="flex items-start gap-3 bg-green-500/10 border border-green-500/30 rounded-xl p-4">
            <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-green-400">{importResult.queued} handles encolados</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {importResult.skipped_duplicate} ya existían · {importResult.skipped_junk} descartados (junk)
              </p>
            </div>
          </div>
        )}

        {/* Import error banner */}
        {importError && (
          <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-xl p-4">
            <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-400">{importError}</p>
          </div>
        )}

        {/* Queue stats grid */}
        {queueStats && queueStats.total > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {([
              { label: 'Pendientes',   value: queueStats.pending,    color: 'text-amber-400'  },
              { label: 'Añadidos',     value: queueStats.added,      color: 'text-green-400'  },
              { label: 'Falló ICP',    value: queueStats.failed_icp, color: 'text-red-400'    },
              { label: 'Sin email',    value: queueStats.no_email,   color: 'text-orange-400' },
              { label: 'Procesando',   value: queueStats.processing, color: 'text-primary'    },
              { label: 'Total',        value: queueStats.total,      color: 'text-foreground' },
            ] as const).map(({ label, value, color }) => (
              <div key={label} className="bg-secondary/50 rounded-lg px-3 py-2 text-center">
                <p className={`text-lg font-bold ${color}`}>{value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Clear pending button */}
        {queueStats && queueStats.pending > 0 && (
          <div className="flex justify-end">
            <button
              onClick={handleClearPending}
              disabled={clearing}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-50"
            >
              {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              Limpiar pendientes
            </button>
          </div>
        )}
      </div>

      {/* Run history */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">Historial de runs</h3>
          <button
            onClick={loadRuns}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Actualizar
          </button>
        </div>

        {loadingRuns ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : runs.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No hay runs todavía. Activa el autopilot y espera a que el cron se active.
          </p>
        ) : (
          <div className="space-y-2">
            {runs.map(run => (
              <div
                key={run.id}
                className="flex items-center justify-between text-xs bg-secondary/50 rounded-lg px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  {run.status === 'success'
                    ? <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                    : run.status === 'error'
                      ? <XCircle    className="w-3.5 h-3.5 text-red-400    flex-shrink-0" />
                      : run.status === 'running'
                        ? <Loader2  className="w-3.5 h-3.5 text-primary animate-spin flex-shrink-0" />
                        : <Clock    className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  }
                  <span className="text-muted-foreground">
                    {new Date(run.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                  {run.errorMessage && (
                    <span className="text-red-400 truncate max-w-[180px]" title={run.errorMessage}>
                      {run.errorMessage}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span>{run.leadsFound}{run.targetLeads != null ? `/${run.targetLeads}` : ''} leads</span>
                  <span className="text-primary">{run.leadsAddedToInstantly} → Instantly</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
