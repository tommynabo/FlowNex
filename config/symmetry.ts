/**
 * config/symmetry.ts
 *
 * The "Brain" of the AI Setter — Layer 1 & Layer 4 context.
 * Edit this file to update the AI's brand knowledge, offer details, and FAQ.
 * These values are imported server-side only (api/webhooks/instantly-reply.ts).
 */

export interface SymmetryFaq {
  question: string;
  answer: string;
}

export interface SymmetryContext {
  companyName: string;
  companyMission: string;
  offerDescription: string;
  jobDescription: string;
  toneGuidelines: string;
  copywritingRules: string;
  faq: SymmetryFaq[];
}

export const SYMMETRY_CONTEXT: SymmetryContext = {
  companyName: 'Symmetry',

  companyMission:
    'Symmetry is the #1 Health & Fitness app in the Spanish-speaking world, with millions of downloads ' +
    'and exponential growth driven by organic content at scale. ' +
    'We create high-volume vertical content (TikTok format) that turns views into real app downloads. ' +
    'We don\'t want pretty content with no impact — we want content that performs and scales. ' +
    'This is a high-performance environment where speed, iteration, and results are everything.',

  offerDescription:
    'We are hiring Content Creators (UGC / Vertical Format) to work directly with our Head of Content. ' +
    'The role is 100% remote and fully results-driven. ' +
    'Creators who hit targets earn between $4,000 and $20,000 USD/month — no cap. ' +
    'This is not a typical content job: we do x100 the volume of the competition, ' +
    'we iterate aggressively, and we double down on what works. ' +
    'The next step for interested candidates is to visit the role page, check all the details, ' +
    'and fill out the short form at the bottom (under 5 minutes) — ' +
    'our Head of Content reviews every application personally and reaches out fast.',

  jobDescription:
    'Position: Content Creator — Vertical Format (Remote)\n' +
    '- Function: Create daily high-volume vertical videos that drive app downloads; manage multiple TikTok accounts\n' +
    '- Location: Must be based in the United States or United Kingdom (firm requirement)\n' +
    '- Schedule: Minimum 4h/day, 6 days/week — highly available with immediate response times\n' +
    '- Compensation: $4,000–$20,000 USD/month, 100% results-based, no cap\n' +
    '- Key responsibilities: Find winning formats, scale what works, drop what doesn\'t convert, analyze metrics weekly\n' +
    '- Desired: Track record of viral vertical content, passion for fitness/health, startup experience\n' +
    '- Start: Immediate — once the application is reviewed, our Head of Content schedules an intro call that same week\n' +
    '- Performance target: 1M+ monthly views, actively scaling to 10M+',

  toneGuidelines:
    'Tono de voz: Casual-Profesional. Joven, cercano y directo.\n' +
    '- NUNCA uses emojis en exceso (máximo 1 por mensaje, y solo si aporta)\n' +
    '- NUNCA uses frases de relleno como "espero que te encuentres bien", "un placer", "estoy encantado de"\n' +
    '- Escribe como un colega que conoce el sector, no como un bot ni un vendedor de piso\n' +
    '- Usa frases cortas. CADA frase o idea va en su PROPIO párrafo, separado por una línea en blanco (\\n\\n). NUNCA agrupes varias frases en un mismo bloque de texto.\n' +
    '- El mensaje debe leerse en menos de 15 segundos',


  copywritingRules:
    'Reglas de Direct Response Marketing:\n' +
    '1. El objetivo del mensaje NO es cerrar la venta. Es conseguir el SIGUIENTE PASO (que rellenen el formulario o que respondan)\n' +
    '2. Responde PRIMERO a lo que preguntó el lead antes de ofrecer más información\n' +
    '3. Termina SIEMPRE con una pregunta o CTA claro (ej: "Here\'s the full role breakdown, short form at the bottom — takes under 5 min: [link]")\'\n' +
    '4. Si el lead muestra interés, comparte 1-2 datos clave del rol (salario, escala de la empresa) y dirige a la página del rol (el formulario está al final)\n' +
    '5. Si el lead pone una objeción, valídala brevemente y redirige hacia la solución\n' +
    '6. Nunca escribas mensajes de más de 5 líneas. Si necesitas más, algo está mal\n' +
    '7. No menciones condiciones exactas de contrato por email; eso lo gestiona el Head of Content en la llamada',

  faq: [
    {
      question: '¿Cuánto se paga? / What\'s the pay? / What\'s the salary?',
      answer:
        'La compensación es 100% basada en resultados: entre $4,000 y $20,000 USD al mes, sin tope. ' +
        'Cuanto mejor rinda el contenido, más se gana. ' +
        'Es de las compensaciones más altas del sector para creadores de contenido remoto. ' +
        'Si suena interesante, el siguiente paso es visitar la página del rol y rellenar el formulario al final (menos de 5 minutos) — ' +
        'nuestro Head of Content revisa cada solicitud personalmente y contacta rápido.',
    },
    {
      question: '¿Cuántas horas hay que trabajar? / How many hours? / Is it full-time?',
      answer:
        'Mínimo 4 horas al día, 6 días a la semana. ' +
        'El horario es flexible — tú eliges el bloque — pero la disponibilidad y la velocidad de respuesta son clave en este rol. ' +
        'Muchos creadores lo compaginan con otras actividades según su situación.',
    },
    {
      question: '¿Necesito experiencia? / Do I need experience in content creation?',
      answer:
        'Tener historial de contenido viral es un plus pero no es obligatorio. ' +
        'Lo que más valoramos es la obsesión por los resultados y la capacidad de iterar rápido. ' +
        'Lo que no buscamos es alguien que haga contenido bonito sin impacto — buscamos a alguien que entienda qué convierte y por qué.',
    },
    {
      question: '¿Es presencial o remoto? / Is it remote?',
      answer:
        '100% remoto y flexible. El único requisito de ubicación es estar basado en Estados Unidos o Reino Unido — es un requisito firme para este rol.',
    },
    {
      question: '¿De qué trata exactamente el trabajo? / What does the job involve?',
      answer:
        'Crearás videos verticales de alto volumen diariamente (formato TikTok) para impulsar descargas de la app. ' +
        'Trabajarás directamente con el Head of Content, gestionarás múltiples cuentas activas, ' +
        'analizarás métricas y iterarás sobre lo que funciona. ' +
        'El objetivo es alcanzar 1M+ de vistas mensuales escalando hasta 10M+. ' +
        'Symmetry es la app #1 de Health & Fitness en el mundo hispanohablante — es un rol con impacto real.',
    },
    {
      question: '¿Cuándo empieza? / How soon can I start? / What\'s the process?',
      answer:
        'Incorporación inmediata. El proceso es simple: visitas la página del rol, rellenas el formulario al final (5 minutos), ' +
        'y nuestro Head of Content te contacta esa misma semana. Si hay fit, arrancamos de inmediato.',
    },
    {
      question: '¿De qué empresa es? / What company is this? / What is Symmetry?',
      answer:
        'Symmetry es la app #1 de Health & Fitness en el mundo hispanohablante, con millones de descargas ' +
        'y en pleno periodo de crecimiento exponencial. ' +
        'El crecimiento está impulsado completamente por contenido orgánico a escala — por eso este rol existe y por eso la compensación es tan alta.',
    },
  ],
};
