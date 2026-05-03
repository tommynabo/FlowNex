export type PlatformSource = 'gmail' | 'instagram' | 'tiktok';
export type SearchMode = 'fast' | 'deep';
export type PageView = 'login' | 'dashboard' | 'campaigns' | 'setter'; // 'generator' and 'history' are removed, 'campaigns' will handle details internally if needed, or we can use another state in App.
export type VslSentStatus = 'pending' | 'sent' | 'opened' | 'clicked' | 'converted';
export type AudienceTier = 'nano' | 'micro' | 'mid' | 'macro';
export type ICPType = 'personal_brand' | 'faceless_clipper';

// ── Content Verification ─────────────────────────────────────────────────────
/** A single video/post item collected from Instagram or TikTok for analysis */
export interface VideoItem {
  thumbnailUrl: string;
  transcript?: string;  // caption (IG) or description (TikTok) — best available proxy for audio content
  platform: 'instagram' | 'tiktok';
}

/** Result of deep multimodal content analysis for one creator */
export interface ContentVerificationResult {
  overall_score: number;        // 0–100 average across analyzed videos
  is_icp_match: boolean;        // overall_score >= SCORE_THRESHOLD (65)
  analyzed_videos: number;
  analyzed_at: string;          // ISO timestamp
  reasoning: string;            // brief explanation from the LLM
}
// ────────────────────────────────────────────────────────────────────────────

// ── AI Setter Module ────────────────────────────────────────────────────────
export type SetterStatus = 'pending_review' | 'approved' | 'rejected' | 'corrected' | 'sent';
export type IntentType = 'interested' | 'objection' | 'question' | 'not_interested' | 'unsubscribe' | 'unknown';

export interface LeadConversation {
  id: string;
  userId: string;
  workspaceId?: string;
  campaignId: string;
  campaignName?: string;
  leadEmail: string;
  emailId: string;          // reply_to_uuid from Instantly — used to send reply via Unibox API
  replySubject?: string;
  replyText: string;
  aiDraft?: string;
  intentClassification?: IntentType;
  confidenceScore?: number;
  status: SetterStatus;
  createdAt: string;
  processedAt?: string;
}

export interface SetterFeedback {
  id: string;
  conversationId: string;
  userId: string;
  decision: 'approved' | 'rejected' | 'corrected';
  originalDraft: string;
  correctedDraft?: string;
  reason: string;
  createdAt: string;
}
// ────────────────────────────────────────────────────────────────────────────

export interface IcpFilters {
  minFollowers: number;        // 0 = no minimum
  maxFollowers: number;        // 0 = no maximum
  regions: string[];           // e.g. ['US', 'UK', 'CA']
  contentTypes: string[];      // e.g. ['Fitness', 'Wellness']
  campaignName: string;        // optional tag for this search
  icpType: ICPType;            // 'personal_brand' | 'faceless_clipper'
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
  instantlyCampaignId?: string;
}

export interface FlowNextConfig {
  targetNiches: string[];
  targetHashtags: string[];
  followerRanges: { label: string; min: number; max: number }[];
  dailyEmailLimit: number;
  vslLink: string;
  /**
   * Model Tiering (Pilar 3): when true, runs a second enrichment pass
   * with gpt-4o after the fast gpt-4o-mini batch analysis.
   * Default: false — gpt-4o-mini is fast and cheap enough for most use cases.
   * Enable only when output quality must be maximized and cost is not a concern.
   */
  usePremiumModel?: boolean;
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
  website?: string;
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
  status: 'scraped' | 'enriched' | 'ready' | 'contacted' | 'replied' | 'discarded' | 'pending_content_verification';
  icp_verified?: boolean;
  content_alignment_score?: number;            // 0–100 set by ContentVerificationService
  content_verification_details?: ContentVerificationResult;
  /** Transient: populated during search, serialized into DB JSONB, consumed by cron job */
  _videoItemsForVerification?: VideoItem[];
  /** Transient: icpType stored alongside the lead so the cron job can use it without re-querying the campaign */
  _icpType?: ICPType;
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
  instantlyCampaignId?: string;
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
