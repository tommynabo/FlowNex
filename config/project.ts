import { ProjectConfig } from '../lib/types';

export const PROJECT_CONFIG: ProjectConfig = {
    clientId: 'flownext_global',
    clientName: 'FlowNext',
    primaryColor: 'hsl(152, 100%, 50%)', // Neon green – Flow State energy
    targets: {
        icp: 'English-speaking Fitness & Personal Development content creators on Instagram/TikTok (10K-1M followers)',
        locations: ['United States', 'United Kingdom', 'Canada', 'Australia'],
    },
    enabledPlatforms: ['instagram'],
    searchSettings: {
        defaultDepth: 20,
        defaultMode: 'fast'
    },
    flownextConfig: {
        targetNiches: ['fitness', 'gym', 'workout', 'personaldev', 'mindset', 'selfimprovement', 'motivation'],
        targetHashtags: [
            '#fitnesscoach', '#fitnessmotivation', '#personaltrainer',
            '#personaldevelopment', '#mindset', '#selfimprovement',
            '#gymlife', '#workout', '#healthylifestyle', '#lifecoach'
        ],
        followerRanges: [
            { label: 'Nano', min: 10_000, max: 50_000 },
            { label: 'Micro', min: 50_000, max: 200_000 },
            { label: 'Mid', min: 200_000, max: 1_000_000 },
        ],
        dailyEmailLimit: 100,
        vslLink: 'https://flownext.io/vsl',
    }
};
