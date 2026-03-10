import React, { useState } from 'react';
import { Play, Zap, Clock, Calendar } from 'lucide-react';
import { SearchConfigState } from '../lib/types';
import { PROJECT_CONFIG } from '../config/project';

interface SearchConfigProps {
  config: SearchConfigState;
  onChange: (updates: Partial<SearchConfigState>) => void;
  onSearch: () => void;
  isSearching: boolean;
  onOpenCriteria?: () => void;
  // Autopilot props
  autopilotEnabled: boolean;
  autopilotTime: string;
  autopilotQuantity: number;
  onAutopilotToggle: (enabled: boolean) => void;
  onAutopilotTimeChange: (time: string) => void;
  onAutopilotQuantityChange: (quantity: number) => void;
  autopilotRanToday: boolean;
  totalLeadsGenerated: number;
}

export function SearchConfig({ config, onChange, onSearch, onStop, isSearching, onOpenCriteria, autopilotEnabled, autopilotTime, autopilotQuantity, onAutopilotToggle, onAutopilotTimeChange, onAutopilotQuantityChange, autopilotRanToday, totalLeadsGenerated }: SearchConfigProps & { onStop: () => void }) {
  const [showTimePicker, setShowTimePicker] = useState(false); // Default 10 for auto-pilot

  // Helper to handle manual number input clearly
  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = parseInt(e.target.value);
    if (isNaN(val)) val = 1;
    if (val < 1) val = 1;
    if (val > 20) val = 20;

    // Hard limit per limits
    const maxAllowed = Math.max(0, 150 - totalLeadsGenerated);
    if (val > maxAllowed) val = maxAllowed;

    onChange({ maxResults: val });
  };

  // Generate hours (00-23)
  const hours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0'));
  // Generate minutes (00, 15, 30, 45) for cleaner UI
  const minutes = ['00', '15', '30', '45'];

  const handleTimeSelect = (type: 'hour' | 'minute', value: string) => {
    const [h, m] = (autopilotTime || '10:00').split(':');
    if (type === 'hour') {
      onAutopilotTimeChange(`${value}:${m || '00'}`);
    } else {
      onAutopilotTimeChange(`${h || '10'}:${value}`);
      // Optional: Close picker after selecting minutes if you want auto-close
    }
  };

  const isLimitReached = totalLeadsGenerated >= 150;
  const maxAllowedInput = Math.max(1, Math.min(20, 150 - totalLeadsGenerated));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

      {/* Generador Manual */}
      <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col justify-between group hover:border-primary/20 transition-all">
        <div>
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg group-hover:scale-105 transition-transform">
              <Zap className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <h3 className="font-semibold text-lg">Generador Manual</h3>
              <p className="text-sm text-muted-foreground">Creación bajo demanda</p>
            </div>
          </div>

          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Cantidad de Leads
                </label>
                <div className="bg-secondary/50 rounded-md px-2 py-1">
                  <span className="text-xs font-mono text-muted-foreground">MAX: 20</span>
                </div>
              </div>

              <div className="flex items-center gap-4 bg-secondary/20 p-2 rounded-xl border border-border/50">
                <input
                  type="range"
                  min="1"
                  max={maxAllowedInput}
                  step="1"
                  value={config.maxResults || 1}
                  onChange={(e) => onChange({ maxResults: parseInt(e.target.value) })}
                  className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary hover:accent-primary/80 transition-all"
                  disabled={isSearching}
                />

                {/* Clickable Number Input */}
                <input
                  type="number"
                  min="1"
                  max={maxAllowedInput}
                  value={config.maxResults}
                  onChange={handleNumberChange}
                  onClick={(e) => e.currentTarget.select()}
                  className="w-16 text-center font-bold text-lg bg-background border-2 border-input rounded-lg py-1 focus:ring-2 focus:ring-primary focus:border-primary transition-all shadow-sm"
                  disabled={isSearching || isLimitReached}
                />
              </div>

              {/* Progress Tracker */}
              <div className="mt-4 bg-secondary/30 rounded-lg border border-border/50 p-3">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold text-foreground">Consumo Total</span>
                  <span className={`text-xs font-mono ${isLimitReached ? 'text-destructive' : 'text-primary'}`}>
                    {totalLeadsGenerated} / 150
                  </span>
                </div>
                <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${isLimitReached ? 'bg-destructive' : 'bg-primary'}`}
                    style={{ width: `${Math.min(100, (totalLeadsGenerated / 150) * 100)}%` }}
                  />
                </div>
                {isLimitReached && (
                  <p className="text-xs text-destructive mt-2 font-medium">Has alcanzado el límite máximo permitido.</p>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 space-y-3">
            <button
              onClick={onOpenCriteria}
              disabled={isSearching}
              className="w-full h-[40px] flex items-center justify-center rounded-lg font-bold text-sm transition-all shadow-md bg-slate-200/50 text-slate-700 hover:bg-slate-200 dark:bg-slate-800/50 dark:text-slate-300 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              ✎ Criterio de Búsqueda
            </button>

            {isSearching ? (
              <button
                onClick={onStop}
                className="w-full h-[48px] flex items-center justify-center rounded-lg font-bold text-sm transition-all shadow-lg bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 active:scale-[0.98]"
              >
                <div className="w-2 h-2 bg-red-500 rounded-sm animate-pulse mr-2" />
                DETENER GENERACIÓN
              </button>
            ) : (
              <button
                onClick={onSearch}
                disabled={isLimitReached}
                className="w-full h-[48px] flex items-center justify-center rounded-lg font-bold text-sm transition-all shadow-lg shadow-primary/20 bg-primary text-primary-foreground hover:brightness-110 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Play className="w-4 h-4 mr-2 fill-current" />
                Generar Ahora
              </button>
            )}
          </div>
        </div>

        {/* Piloto Automático */}
        <div className="bg-card border border-border rounded-xl p-6 shadow-sm flex flex-col relative overflow-hidden group hover:border-green-500/20 transition-all">
          {/* Status Indicator */}
          <div className={`absolute top-0 right-0 p-6 transition-opacity ${autopilotEnabled ? 'opacity-100' : 'opacity-50'}`}>
            <div className={`w-3 h-3 rounded-full shadow-[0_0_10px_currentColor] ${autopilotEnabled ? 'bg-green-500 text-green-500' : 'bg-gray-300 text-gray-300'}`} />
          </div>

          <div className="flex items-center gap-3 mb-8">
            <div className={`p-2 rounded-lg transition-colors ${autopilotEnabled ? 'bg-green-100 dark:bg-green-900/30' : 'bg-secondary'}`}>
              <Clock className={`w-5 h-5 ${autopilotEnabled ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`} />
            </div>
            <div>
              <h3 className="font-semibold text-lg">Piloto Automático</h3>
              <p className="text-sm text-muted-foreground">{autopilotEnabled ? (autopilotRanToday ? 'Ejecutado hoy ✅' : 'Activo diariamente') : 'Desactivado'}</p>
            </div>
          </div>

          <div className="flex-1 flex flex-col items-center justify-center space-y-6 relative">
            <div className="text-center w-full z-10">
              {/* Time Display Trigger */}
              <div
                className={`relative cursor-pointer transition-all ${autopilotEnabled ? 'opacity-100' : 'opacity-50 pointer-events-none'
                  }`}
                onClick={() => { onAutopilotToggle(true); setShowTimePicker(!showTimePicker); }}
              >
                <div
                  className="text-6xl font-bold tracking-tight mb-2 select-none hover:scale-105 transition-transform"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (autopilotEnabled) setShowTimePicker(!showTimePicker);
                  }}
                >
                  {autopilotTime}
                </div>
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest bg-secondary/50 px-3 py-1 rounded-full inline-block group-hover:bg-secondary transition-colors">
                  {showTimePicker ? 'Cerrar Selector' : 'Cambiar Hora'}
                </p>

                {/* Custom Dropdown Picker */}
                {showTimePicker && autopilotEnabled && (
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-4 bg-popover text-popover-foreground border border-border shadow-xl rounded-xl p-4 flex gap-4 z-50 animate-in fade-in zoom-in-95 duration-200 min-w-[200px]">

                    {/* Hours Column */}
                    <div className="flex-1">
                      <span className="text-xs font-bold text-muted-foreground mb-2 block uppercase text-center">Hora</span>
                      <div className="h-48 overflow-y-auto space-y-1 scrollbar-thin scrollbar-thumb-secondary pr-2">
                        {hours.map(h => (
                          <button
                            key={h}
                            onClick={() => handleTimeSelect('hour', h)}
                            className={`w-full py-1.5 rounded-md text-sm font-medium transition-colors ${autopilotTime.startsWith(h)
                              ? 'bg-primary text-primary-foreground'
                              : 'hover:bg-secondary'
                              }`}
                          >
                            {h}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="w-[1px] bg-border my-2" />

                    {/* Minutes Column */}
                    <div className="flex-1">
                      <span className="text-xs font-bold text-muted-foreground mb-2 block uppercase text-center">Min</span>
                      <div className="h-48 overflow-y-auto space-y-1 scrollbar-thin scrollbar-thumb-secondary">
                        {minutes.map(m => (
                          <button
                            key={m}
                            onClick={() => handleTimeSelect('minute', m)}
                            className={`w-full py-1.5 rounded-md text-sm font-medium transition-colors ${autopilotTime.endsWith(m)
                              ? 'bg-primary text-primary-foreground'
                              : 'hover:bg-secondary'
                              }`}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Backdrop to close picker */}
            {showTimePicker && (
              <div
                className="fixed inset-0 z-0 bg-transparent"
                onClick={() => setShowTimePicker(false)}
              />
            )}

            {/* Scheduler Quantity Selector */}
            <div className={`mt-8 w-full max-w-[200px] transition-all duration-300 ${autopilotEnabled ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block mb-2">
                Leads por día
              </label>
              <div className="flex items-center gap-2 bg-secondary/30 p-1.5 rounded-lg border border-border/50">
                <input
                  type="range"
                  min="5"
                  max="50"
                  step="5"
                  value={autopilotQuantity}
                  onChange={(e) => onAutopilotQuantityChange(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-green-500 hover:accent-green-600 transition-all"
                />
                <span className="font-mono text-sm font-bold w-6 text-center">{autopilotQuantity}</span>
              </div>
            </div>
          </div>

          <div className="mt-8 flex items-center justify-between pt-6 border-t border-border relative z-0">
            <span className="text-sm font-medium text-muted-foreground">Estado del Sistema</span>
            <button
              onClick={() => onAutopilotToggle(!autopilotEnabled)}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${autopilotEnabled ? 'bg-green-500 shadow-[0_0_15px_-3px_rgba(34,197,94,0.6)]' : 'bg-secondary'
                }`}
            >
              <span
                className={`${autopilotEnabled ? 'translate-x-6' : 'translate-x-1'
                  } inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform`}
              />
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
