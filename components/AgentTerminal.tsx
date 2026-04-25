import React, { useEffect, useRef } from 'react';
import { Terminal, ChevronDown, ChevronUp } from 'lucide-react';

interface AgentTerminalProps {
  logs: string[];
  isVisible: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

export function AgentTerminal({ logs, isVisible, isExpanded, onToggleExpand }: AgentTerminalProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, isExpanded]);

  if (!isVisible) return null;

  return (
    <div className={`mt-6 glass-terminal border border-border rounded-xl overflow-hidden shadow-2xl transition-all duration-500 ease-in-out`}>
      {/* Terminal Header */}
      <div 
        className="bg-secondary/30 backdrop-blur-sm px-4 py-2 border-b border-white/5 flex items-center justify-between cursor-pointer"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary animate-pulse" />
          <span className="text-xs font-mono font-medium text-muted-foreground">
            FLOWNEXT_AGENT_V1.0 <span className="text-primary mx-2">●</span> LIVE EXECUTION
          </span>
        </div>
        <button className="text-muted-foreground hover:text-foreground">
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {/* Terminal Content */}
      <div className={`transition-all duration-300 ${isExpanded ? 'h-64' : 'h-0'}`}>
        <div className="h-full overflow-y-auto p-4 font-mono text-xs md:text-sm space-y-1.5 scrollbar-hide" style={{ color: '#e4e4e7' }}>
          {logs.map((log, index) => {
            const isError = log.includes('Error') || log.includes('ERROR') || log.includes('FATAL');
            const isSuccess = log.includes('SUCCESS') || log.includes('[email]') || log.includes('Complete') || log.includes('creators found');
            const isSystem = log.includes('[INIT]') || log.includes('[DEDUP]') || log.includes('[APIFY]') || log.includes('[AUTOPILOT]') || log.includes('[SETTER]');
            const isIncoming = log.includes('Entrante:');
            
            return (
              <div key={index} className="flex gap-3 opacity-0 animate-[fadeIn_0.3s_ease-out_forwards]">
                <span className="text-muted-foreground min-w-[80px]">
                  {new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className={
                  isError ? 'text-destructive' :
                  isSuccess ? 'text-green-400' :
                  isIncoming ? 'text-purple-400' :
                  isSystem ? 'text-primary' : 'text-zinc-300'
                }>
                  {log}
                </span>
              </div>
            );
          })}
          <div ref={bottomRef} />
          
          <div className="flex items-center gap-2 text-primary/50 mt-2">
            <span className="animate-pulse">_</span>
          </div>
        </div>
      </div>
    </div>
  );
}