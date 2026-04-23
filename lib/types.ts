export type PlatformSource = 'gmail' | 'instagram' | 'tiktok';
export type SearchMode = 'fast' | 'deep';
export type PageView = 'login' | 'dashboard' | 'generator' | 'campaigns' | 'history';
export type VslSentStatus = 'pending' | 'sent' | 'opened' | 'clicked' | 'converted';
export type AudienceTier = 'nano' | 'micro' | 'mid' | 'macro';

export interface IcpFilters {
  minFollowers: number;        // 0 = no minimum
  maxFollowers: number;        // 0 = no maximum
  regions: string[];           // e.g. ['US', 'UK', 'CA']
  contentTypes: string[];      // e.g. ['Fitness', 'Wellness']
  campaignName: string;        // optional tag for this search
}

export interface Campaign {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'paused' | 'completed';
  hashtags: string[];
  icpFilters: IcpFilters;
  totalLeads: number;
  createdAt: Date;
  userId: string;
}

export interface FlowNextConfig {
  targetNiches: string[];
  targetHashtags: string[];
  followerRanges: { label: string; min: number; max: number }[];
  dailyEmailLimit: number;
  vslLink: string;
}

export interface ProjectConfig {
  clientId: string;
  clientName: string;
  primaryColor: string;
  targets: {
    icp: string;
    locations: string[];
  };
  enabledPlatforms: PlatformSource[];
  searchSettings: {
    defaultDepth: number;
    defaultMode: SearchMode;
  };
  flownextConfig?: FlowNextConfig;
}

export interface Lead {
  id: string;
  source: PlatformSource;
  ig_handle?: string;
  follower_count?: number;
  niche?: string;
  audience_tier?: AudienceTier;
  location?: string;
  decisionMaker?: {
    name: string;
    role: string;
    email: string;
    phone?: string;
    instagram?: string;
  };
  aiAnalysis: {
    summary: string;
    painPoints: string[];
    generatedIcebreaker: string;
    coldEmailSubject: string;
    coldEmailBody: string;
    vslPitch: string;
    fullAnalysis: string;
    psychologicalProfile: string;
    engagementSignal: string;
    salesAngle: string;
  };
  vsl_sent_status?: VslSentStatus;
  email_status?: 'pending' | 'sent' | 'bounced' | 'replied';
  status: 'scraped' | 'enriched' | 'ready' | 'contacted' | 'replied' | 'discarded';
}

export interface AdvancedFilter {
  locations: string[];
  jobTitles: string[];
  companySizes: string[];
  industries: string[];
  keywords: string[];
}

export interface SearchConfigState {
  query: string;
  source: PlatformSource;
  mode: SearchMode;
  maxResults: number;
  icpFilters?: IcpFilters;
  advancedFilters?: AdvancedFilter;
}

export interface SearchSession {
  id: string;
  date: Date;
  query: string;
  source: PlatformSource;
  resultsCount: number;
  leads: Lead[];
}

export interface VslStats {
  emailsDelivered: number;
  vslClicks: number;
  conversions: number;
}
