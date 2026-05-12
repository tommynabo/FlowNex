import React, { useState, useEffect, useCallback } from 'react';
import { Campaign, AutopilotRun } from '../lib/types';
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
  ChevronRight,
  Globe,
} from 'lucide-react';

interface AutopilotPanelProps {
  campaign: Campaign;
  onUpdate: (updates: Partial<Campaign>) => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const fmt24 = (h: number) => `${String(h).padStart(2, '0')}:00`;

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

// Shared dark select className — fixes white-on-white on macOS
const SELECT_CLS =
  'w-full bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm focus:border-primary outline-none [color-scheme:dark]';

function estimateNextRun(
  startHour: number,
  endHour: number,
  leadsToday: number,
  dailyLimit: number,
  timezone: string,
): string {
  if (leadsToday >= dailyLimit) return 'Límite diario alcanzado';
  if (startHour === endHour) return 'Ventana inválida';
  const localHour = getCurrentHourInTz(timezone);
  for (let offset = 1; offset <= 24; offset++) {
    const h = (localHour + offset) % 24;
    const inside = startHour <= endHour
      ? h >= startHour && h < endHour
      : h >= startHour || h < endHour;
    if (inside) {
      const next = new Date();
      next.setHours(next.getHours() + offset, 0, 0, 0);
      return next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (local)';
    }
  }
  return '—';
}

export function AutopilotPanel({ campaign, onUpdate }: AutopilotPanelProps) {
  const ap = campaign.autopilot;

  const [enabled,    setEnabled]    = useState(ap?.enabled    ?? false);
  const [startHour,  setStartHour]  = useState(ap?.startHour  ?? 22);
  const [endHour,    setEndHour]    = useState(ap?.endHour    ?? 6);
  const [batchSize,  setBatchSize]  = useState(ap?.batchSize  ?? 5);
  const [dailyLimit, setDailyLimit] = useState(ap?.dailyLimit ?? 50);
  const [timezone,   setTimezone]   = useState(ap?.timezone   || detectTimezone());
  const [saving,     setSaving]     = useState(false);
  const [saveOk,     setSaveOk]     = useState(false);
  const [runs,       setRuns]       = useState<AutopilotRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  const leadsToday = ap?.leadsToday ?? 0;
  const lastRunAt  = ap?.lastRunAt  ?? null;

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
    const { error } = await supabase.from('campaigns').update({
      autopilot_enabled:     enabled,
      autopilot_start_hour:  startHour,
      autopilot_end_hour:    endHour,
      autopilot_batch_size:  batchSize,
      autopilot_daily_limit: dailyLimit,
      autopilot_timezone:    timezone,
    }).eq('id', campaign.id);

    setSaving(false);
    if (!error) {
      setSaveOk(true);
      onUpdate({
        autopilot: {
          enabled,
          startHour,
          endHour,
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
              <select
                value={startHour}
                onChange={e => setStartHour(Number(e.target.value))}
                className={SELECT_CLS}
              >
                {HOURS.map(h => (
                  <option key={h} value={h}>{fmt24(h)}</option>
                ))}
              </select>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground mt-5 flex-shrink-0" />
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">Hora fin</label>
              <select
                value={endHour}
                onChange={e => setEndHour(Number(e.target.value))}
                className={SELECT_CLS}
              >
                {HOURS.map(h => (
                  <option key={h} value={h}>{fmt24(h)}</option>
                ))}
              </select>
            </div>
          </div>
          {startHour === endHour && (
            <p className="text-xs text-yellow-400 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" />
              Inicio y fin iguales: el autopilot nunca se activará.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {startHour > endHour
              ? `Ventana nocturna: ${fmt24(startHour)} → ${fmt24(endHour)} (cruza medianoche)`
              : `Ventana diurna: ${fmt24(startHour)} → ${fmt24(endHour)}`
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
              ? estimateNextRun(startHour, endHour, leadsToday, dailyLimit, timezone)
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
