import React from 'react';
import { SearchSession } from '../lib/types';
import { Calendar, Search, Mail, Instagram, ArrowRight, User, History } from 'lucide-react';

interface CampaignsViewProps {
  history: SearchSession[];
  onSelectSession: (session: SearchSession) => void;
}

export function CampaignsView({ history, onSelectSession }: CampaignsViewProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 pt-2 pb-1 border-t border-border">
        <History className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Past Campaigns</h3>
        {history.length > 0 && (
          <span className="text-xs bg-secondary rounded-full px-2 py-0.5 text-muted-foreground">{history.length}</span>
        )}
      </div>

      {history.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <Search className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No campaigns yet. Run your first search above.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {history.map((session) => (
            <div
              key={session.id}
              onClick={() => onSelectSession(session)}
              className="bg-card border border-border rounded-xl p-4 hover:border-primary/50 transition-all cursor-pointer group flex flex-col md:flex-row md:items-center justify-between gap-3"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 bg-secondary/50 rounded-lg flex items-center justify-center border border-border group-hover:bg-primary/10 group-hover:text-primary transition-colors flex-shrink-0">
                  {session.source === 'instagram' ? <Instagram className="w-5 h-5" /> : <Mail className="w-5 h-5" />}
                </div>
                <div>
                  <h4 className="font-medium text-sm group-hover:text-primary transition-colors line-clamp-1">
                    {session.query}
                  </h4>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      <span>{session.date.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })} {session.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      <span>{session.resultsCount} creators found</span>
                    </div>
                  </div>
                </div>
              </div>
              <button className="flex items-center text-xs font-medium text-muted-foreground group-hover:text-primary transition-colors ml-auto">
                View Results <ArrowRight className="w-3.5 h-3.5 ml-1 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
