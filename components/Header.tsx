import React from 'react';
import { LogOut, Zap, Bot } from 'lucide-react';
import { PageView } from '../lib/types';

interface HeaderProps {
  currentPage: PageView;
  onNavigate: (page: PageView) => void;
  onLogout: () => void;
  userName?: string;
}

export function Header({ currentPage, onNavigate, onLogout, userName }: HeaderProps) {
  const getLinkClass = (page: PageView) =>
    `cursor-pointer transition-colors ${currentPage === page ? 'text-primary font-semibold' : 'text-muted-foreground hover:text-foreground'}`;

  // Compute initials
  const initials = React.useMemo(() => {
    if (!userName) return 'JD';
    const parts = userName.trim().split(/\s+/);
    if (parts.length === 0) return 'JD';
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }, [userName]);

  return (
    <header className="border-b border-border bg-background/50 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => onNavigate('dashboard')}>
          <div className="w-8 h-8 bg-primary/20 rounded-lg flex items-center justify-center border border-primary/30">
            <Zap className="w-5 h-5 text-primary" />
          </div>
          <span className="font-bold text-lg tracking-tight">Flow<span className="text-primary">Next</span></span>
        </div>

        <nav className="hidden md:flex items-center gap-8 text-sm font-medium">
          <a onClick={() => onNavigate('dashboard')} className={getLinkClass('dashboard')}>Dashboard</a>
          <a onClick={() => onNavigate('campaigns')} className={getLinkClass('campaigns')}>Campaigns</a>
          <a onClick={() => onNavigate('setter')} className={`${getLinkClass('setter')} flex items-center gap-1.5`}>
            <Bot className="w-3.5 h-3.5" />
            AI Setter
          </a>
        </nav>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            {/* Separate Logout Button */}
            <button
              onClick={onLogout}
              className="p-2 hover:bg-destructive/10 hover:text-destructive rounded-full transition-colors text-muted-foreground"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
