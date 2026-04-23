import React from 'react';
import { SearchSession } from '../lib/types';
import { Calendar, Search, Mail, Instagram, ArrowRight, User } from 'lucide-react';

interface CampaignsViewProps {
  history: SearchSession[];
  onSelectSession: (session: SearchSession) => void;
}

export function CampaignsView({ history, onSelectSession }: CampaignsViewProps) {
  if (history.length === 0) {
    return (
      <div className="text-center py-20 animate-[fadeIn_0.5s_ease-out]">
        <div className="w-16 h-16 bg-secondary rounded-full flex items-center justify-center mx-auto mb-4">
          <Search className="w-8 h-8 text-muted-foreground" />
        </div>
        <h3 className="text-xl font-semibold mb-2">No search history yet</h3>
        <p className="text-muted-foreground">Your recent searches will appear here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-[fadeIn_0.5s_ease-out]">
       <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Campaign History</h2>
            <p className="text-muted-foreground">Your recent creator searches saved as campaigns.</p>
          </div>
       </div>

       <div className="grid gap-4">
          {history.map((session) => (
             <div 
                key={session.id} 
                onClick={() => onSelectSession(session)}
                className="bg-card border border-border rounded-xl p-5 hover:border-primary/50 transition-all cursor-pointer group shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4"
             >
                <div className="flex items-start gap-4">
                   <div className="w-12 h-12 bg-secondary/50 rounded-lg flex items-center justify-center border border-border group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                      {session.source === 'instagram' ? <Instagram className="w-6 h-6" /> : <Mail className="w-6 h-6" />}
                   </div>
                   
                   <div>
                      <h3 className="font-semibold text-lg group-hover:text-primary transition-colors">
                        {session.date.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })} - {session.query}
                      </h3>
                      <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                         <div className="flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5" />
                            <span>{session.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
                         </div>
                         <div className="flex items-center gap-1.5">
                            <User className="w-3.5 h-3.5" />
                            <span>{session.resultsCount} creators found</span>
                         </div>
                      </div>
                   </div>
                </div>

                <div className="flex items-center justify-end">
                   <button className="flex items-center text-sm font-medium text-muted-foreground group-hover:text-primary transition-colors">
                      View Results <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                   </button>
                </div>
             </div>
          ))}
       </div>
    </div>
  );
}
