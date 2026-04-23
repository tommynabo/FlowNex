import { Lead } from './types';

export const MOCK_SCENARIO_WELLNESS: Lead[] = [
  {
    id: 'mock-1',
    source: 'instagram',
    ig_handle: 'fitnesswithsarah',
    follower_count: 45000,
    niche: 'Fitness',
    audience_tier: 'micro',
    location: 'Los Angeles, USA',
    decisionMaker: {
      name: 'Sarah Mitchell',
      role: 'Content Creator',
      email: 'sarah@fitnesswithsarah.com',
      instagram: 'https://instagram.com/fitnesswithsarah'
    },
    aiAnalysis: {
      summary: 'Fitness micro-influencer with 45K engaged followers and email in bio. High conversion potential.',
      painPoints: ['Relies only on brand deals', 'No own digital product'],
      generatedIcebreaker: 'Your transformation content is genuinely inspiring — the community you have built is real.',
      coldEmailSubject: 'Quick question about your fitness brand',
      coldEmailBody: "Hey Sarah,\n\nYour transformation content is some of the most genuine in the fitness space right now.\n\nI've been working with coaches at your follower level on something that quietly adds 5-6 figures without posting more.\n\nShort 4-min video: https://flownext.io/vsl\n\nWorth a watch if you're thinking about scaling.",
      vslPitch: 'Turn your 45K audience into a revenue stream without extra content',
      fullAnalysis: 'High trust micro-influencer with active community. Monetization gap = no digital product.',
      psychologicalProfile: 'Achievement-driven creator focused on helping others transform. Values authenticity.',
      engagementSignal: 'Email in bio signals comfort with direct outreach. Likely open to collaboration.',
      salesAngle: 'Passive income from existing audience without posting more'
    },
    vsl_sent_status: 'pending',
    email_status: 'pending',
    status: 'ready'
  },
  {
    id: 'mock-2',
    source: 'instagram',
    ig_handle: 'mindsetmastery_john',
    follower_count: 120000,
    niche: 'Personal Dev',
    audience_tier: 'mid',
    location: 'New York, USA',
    decisionMaker: {
      name: 'John Rivera',
      role: 'Content Creator',
      email: 'john@mindsetmastery.com',
      instagram: 'https://instagram.com/mindsetmastery_john'
    },
    aiAnalysis: {
      summary: 'Mid-tier personal development creator with 120K followers and proven email list. Strong sales angle.',
      painPoints: ['Sporadic posting schedule', 'Revenue tied to speaking gigs only'],
      generatedIcebreaker: "Your breakdown on identity-level change was one of the clearest I've seen.",
      coldEmailSubject: 'Scaling your mindset brand passively',
      coldEmailBody: "Hey John,\n\nThat breakdown on identity-level change you posted last week was seriously sharp.\n\nI work with personal development creators at your level on a model that adds consistent revenue without the grind of more content.\n\n4-min video that explains it: https://flownext.io/vsl\n\nLet me know what you think.",
      vslPitch: 'Add consistent 5-figure revenue to your 120K audience without more content',
      fullAnalysis: 'Strong mid-tier creator with high-value audience. Ready for digital product or licensing deal.',
      psychologicalProfile: 'Thought leader positioning. Values depth over volume. Likely tired of trading time for money.',
      engagementSignal: 'Published email and professional tone in bio suggest openness to B2B conversation.',
      salesAngle: 'Recurring revenue model that does not require more content creation'
    },
    vsl_sent_status: 'pending',
    email_status: 'pending',
    status: 'ready'
  }
];
