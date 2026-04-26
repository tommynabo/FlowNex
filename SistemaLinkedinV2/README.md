# Sistema LinkedIn 🎯

Módulo especializado para búsqueda y gestión de candidatos en LinkedIn usando la metodología LinkedIn Radar.

## Estructura

```
SistemaLinkedin/
├── lib/
│   └── LinkedInSearchEngine.ts     # Motor de búsqueda LinkedIn Radar
└── components/
    └── DetailView.tsx              # Panel principal de búsqueda y gestión
```

## Uso Básico

```typescript
import { DetailView } from './SistemaLinkedin/components/DetailView';
import { Campaign } from '../types/database';

// En tu componente padre
const campaign: Campaign = { /* ... */ };
<DetailView campaign={campaign} onBack={() => navigate(-1)} />
```

## Características

- **LinkedIn Radar**: Búsqueda avanzada de perfiles en LinkedIn
- **API Search**: Google Custom Search via Apify para resultados de LinkedIn
- **IA Analysis**: Análisis inteligente con OpenAI/GPT-4o-mini
- **Deduplicación**: Evita duplicados automáticamente
- **Persistencia**: Almacenamiento en Supabase
- **Múltiples vistas**: Listado, Kanban, Pipeline
- **Unbreakable Execution**: Continúa la búsqueda incluso si se cambia de pestaña

## URL Principal

```
https://tuapp.com/tablero/linkedin/:campaignId
```

## Variables de Entorno Requeridas

```
VITE_APIFY_API_KEY=your_apify_key      # Para búsquedas en Google/LinkedIn
VITE_OPENAI_API_KEY=your_openai_key    # Para análisis IA de perfiles
```

## Metodología LinkedIn Radar

1. **Google Search Scraping**: Busca perfiles de LinkedIn usando Google Search
2. **Query Variation**: 10 variaciones de búsqueda para maximizar cobertura
3. **URL Deduplication**: Elimina duplicados antes de análisis IA
4. **Batch AI Analysis**: Procesa 8 perfiles en paralelo para mayor velocidad
5. **Score Filtering**: Filtra por simetría de perfil (score >= 70)

