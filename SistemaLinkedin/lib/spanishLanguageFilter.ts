/**
 * SPANISH LANGUAGE FILTER
 * 
 * Multi-signal detection to ensure candidates are Spanish-speaking.
 * A candidate passes if they match AT LEAST ONE strong signal:
 *   1. Hispanic first name or surname
 *   2. Spanish-speaking country/city in location
 *   3. Spanish-language text in title/description
 */

// ─── Common Hispanic first names (~200) ──────────────────────────────────────
const SPANISH_FIRST_NAMES = new Set([
    // Male
    'alejandro', 'alfonso', 'alfredo', 'álvaro', 'alvaro', 'andrés', 'andres', 'angel', 'ángel',
    'antonio', 'arturo', 'bernardo', 'carlos', 'césar', 'cesar', 'claudio', 'cristian', 'cristóbal',
    'daniel', 'david', 'diego', 'eduardo', 'emilio', 'enrique', 'ernesto', 'esteban', 'fabián', 'fabian',
    'federico', 'felipe', 'fernando', 'francisco', 'gabriel', 'gerardo', 'gonzalo', 'guillermo',
    'gustavo', 'héctor', 'hector', 'hugo', 'ignacio', 'iván', 'ivan', 'javier', 'jesús', 'jesus',
    'joaquín', 'joaquin', 'jorge', 'josé', 'jose', 'juan', 'julio', 'leonardo', 'lorenzo', 'lucas',
    'luis', 'manuel', 'marcos', 'mario', 'martín', 'martin', 'mateo', 'matías', 'matias', 'mauricio',
    'miguel', 'nicolás', 'nicolas', 'óscar', 'oscar', 'pablo', 'patricio', 'pedro', 'rafael', 'ramiro',
    'ramón', 'ramon', 'raúl', 'raul', 'ricardo', 'roberto', 'rodrigo', 'rubén', 'ruben', 'salvador',
    'samuel', 'santiago', 'sebastián', 'sebastian', 'sergio', 'tomás', 'tomas', 'valentín', 'valentin',
    'víctor', 'victor', 'xavier', 'armando', 'agustín', 'agustin', 'benjamín', 'benjamin', 'beltrán',
    'beltran', 'breogán', 'kike', 'pelayo', 'nazar', 'emerson', 'erik', 'israel', 'jeduan', 'moaz',
    'edgar', 'iñaki', 'inaki', 'asier', 'koldo', 'unai', 'gorka', 'aitor', 'iker', 'pol', 'arnau',
    'albert', 'oriol', 'pere', 'jordi', 'adrián', 'adrian', 'álvaro', 'alonso',
    // Female
    'adriana', 'alejandra', 'alicia', 'ana', 'andrea', 'ángela', 'angela', 'beatriz', 'camila',
    'carmen', 'carolina', 'catalina', 'claudia', 'constanza', 'cristina', 'daniela', 'diana',
    'elena', 'elisa', 'emilia', 'esperanza', 'estela', 'eugenia', 'eva', 'fernanda', 'florencia',
    'gabriela', 'gloria', 'graciela', 'guadalupe', 'inés', 'ines', 'irene', 'isabel', 'javiera',
    'jimena', 'josefina', 'juana', 'julia', 'laura', 'leonor', 'leticia', 'lorena', 'lucía', 'lucia',
    'luisa', 'luz', 'magdalena', 'marcela', 'margarita', 'maría', 'maria', 'mariana', 'marta',
    'mercedes', 'miriam', 'mónica', 'monica', 'natalia', 'noemí', 'noemi', 'nuria', 'olga', 'paloma',
    'patricia', 'paula', 'pilar', 'raquel', 'rebeca', 'rocío', 'rocio', 'rosa', 'rosario', 'ruth',
    'sandra', 'sara', 'silvia', 'sofía', 'sofia', 'soledad', 'sonia', 'susana', 'teresa', 'valentina',
    'valeria', 'vanessa', 'verónica', 'veronica', 'virginia', 'ximena', 'yolanda', 'agustina',
    'rochi', 'macarena', 'ainara', 'nerea', 'leire', 'ainhoa', 'alba', 'laia', 'berta', 'clara',
    'montserrat', 'concha', 'amparo', 'inmaculada', 'dolores', 'lourdes', 'milagros', 'remedios'
]);

// ─── Common Hispanic surnames ────────────────────────────────────────────────
const SPANISH_SURNAMES = new Set([
    'aguilar', 'álvarez', 'alvarez', 'araya', 'arce', 'arias', 'barrera', 'blanco', 'bravo',
    'cabrera', 'calderón', 'calderon', 'campos', 'cárdenas', 'cardenas', 'carrasco', 'castillo',
    'castro', 'cervantes', 'chávez', 'chavez', 'contreras', 'córdoba', 'cordoba', 'cortés', 'cortes',
    'cruz', 'de la cruz', 'de la fuente', 'de león', 'del río', 'delgado', 'díaz', 'diaz',
    'domínguez', 'dominguez', 'duarte', 'espinosa', 'espinoza', 'estrada', 'fernández', 'fernandez',
    'figueroa', 'flores', 'fuentes', 'gallego', 'garcía', 'garcia', 'gómez', 'gomez', 'gonzález',
    'gonzalez', 'guerrero', 'gutiérrez', 'gutierrez', 'guzmán', 'guzman', 'hernández', 'hernandez',
    'herrera', 'ibáñez', 'ibañez', 'iglesias', 'jiménez', 'jimenez', 'lara', 'león', 'leon', 'lópez',
    'lopez', 'luna', 'marín', 'marin', 'márquez', 'marquez', 'martínez', 'martinez', 'medina',
    'mejía', 'mejia', 'méndez', 'mendez', 'mendoza', 'molina', 'montes', 'montoya', 'mora', 'morales',
    'moreno', 'muñoz', 'munoz', 'navarro', 'nieto', 'núñez', 'nunez', 'ochoa', 'olivares', 'ortega',
    'ortiz', 'palacios', 'paredes', 'pascual', 'peña', 'pena', 'peralta', 'pérez', 'perez', 'pineda',
    'prieto', 'quintero', 'ramírez', 'ramirez', 'ramos', 'reyes', 'ríos', 'rios', 'rivera', 'robles',
    'rodríguez', 'rodriguez', 'rojas', 'romero', 'rosales', 'ruiz', 'saavedra', 'salazar', 'salinas',
    'sánchez', 'sanchez', 'sandoval', 'santana', 'santos', 'serrano', 'silva', 'solís', 'solis',
    'soto', 'suárez', 'suarez', 'tapia', 'torres', 'trujillo', 'valdés', 'valdes', 'valencia',
    'valenzuela', 'vargas', 'vásquez', 'vasquez', 'vega', 'velasco', 'vera', 'vidal', 'villanueva',
    'zamora', 'zapata', 'zúñiga', 'zuniga',
    // Extended surnames (from real search false negatives)
    'diez', 'picón', 'picon', 'morgade', 'asensio', 'caballer', 'alonso', 'bruned', 'ottobre',
    'abad', 'leal', 'areán', 'arean', 'barrio', 'prados', 'cornejo', 'carreño', 'carreno',
    'torrijos', 'sagredo', 'pareja', 'urtecho', 'cuello', 'elgueta', 'campo', 'monsalve',
    'sorribes', 'ortuño', 'ortuno', 'salmerón', 'salmeron', 'pla', 'scasserra', 'giudice',
    'caballero', 'cebrian', 'cebrián', 'bermejo', 'bernabé', 'bernabe', 'bueno', 'calvo',
    'cano', 'castaño', 'castano', 'cuesta', 'dueñas', 'duenas', 'echeverría', 'echeverria',
    'fabre', 'ferrer', 'galan', 'galán', 'garrido', 'gil', 'gimeno', 'hidalgo', 'huertas',
    'izquierdo', 'jurado', 'lamas', 'largo', 'llopis', 'manzano', 'maqueda', 'mateo',
    'moya', 'naranjo', 'narváez', 'narvaez', 'oliva', 'orozco', 'pardo', 'pastor', 'pedraza',
    'plaza', 'portillo', 'pozo', 'prada', 'quesada', 'roca', 'rubio', 'saenz', 'sainz',
    'segura', 'sevilla', 'soler', 'tejada', 'toro', 'val', 'villar', 'vizoso', 'yáñez', 'yanez'
]);

// ─── Spanish-speaking locations ──────────────────────────────────────────────
const SPANISH_LOCATIONS = [
    // Countries
    'españa', 'spain', 'méxico', 'mexico', 'colombia', 'argentina', 'chile', 'perú', 'peru',
    'venezuela', 'ecuador', 'bolivia', 'paraguay', 'uruguay', 'costa rica', 'panamá', 'panama',
    'guatemala', 'honduras', 'el salvador', 'nicaragua', 'cuba', 'república dominicana',
    'dominican republic', 'puerto rico',
    // Major cities Spain
    'madrid', 'barcelona', 'valencia', 'sevilla', 'seville', 'málaga', 'malaga', 'bilbao',
    'zaragoza', 'murcia', 'palma', 'las palmas', 'alicante', 'córdoba', 'cordoba', 'valladolid',
    'vigo', 'gijón', 'gijon', 'granada', 'a coruña', 'coruña', 'vitoria', 'santander', 'pamplona',
    'san sebastián', 'san sebastian', 'donostia', 'salamanca', 'burgos', 'cádiz', 'cadiz',
    'tarragona', 'girona', 'toledo', 'badajoz', 'león', 'leon', 'lleida', 'castellón', 'castellon',
    'almería', 'almeria', 'huelva', 'jaén', 'jaen', 'logroño', 'lugo', 'ourense', 'pontevedra',
    'segovia', 'soria', 'teruel', 'zamora', 'ávila', 'avila', 'cuenca', 'huesca', 'palencia',
    // Major cities LATAM
    'buenos aires', 'bogotá', 'bogota', 'lima', 'santiago', 'ciudad de méxico', 'cdmx',
    'guadalajara', 'monterrey', 'medellín', 'medellin', 'cali', 'barranquilla', 'cartagena',
    'quito', 'guayaquil', 'la paz', 'cochabamba', 'santa cruz', 'asunción', 'asuncion',
    'montevideo', 'san josé', 'san jose', 'caracas', 'maracaibo', 'puebla', 'tijuana',
    'cancún', 'cancun', 'mérida', 'merida', 'rosario', 'mendoza', 'tucumán', 'tucuman',
    'arequipa', 'cusco', 'trujillo', 'valparaíso', 'valparaiso', 'concepción', 'concepcion',
    'temuco', 'antofagasta', 'santo domingo', 'san juan', 'la habana', 'havana',
    // Regions 
    'latam', 'latinoamérica', 'latinoamerica', 'hispanoamérica', 'hispanoamerica',
    'iberoamérica', 'iberoamerica', 'cataluña', 'catalonia', 'andalucía', 'andalucia',
    'castilla', 'galicia', 'país vasco', 'pais vasco', 'euskadi', 'asturias', 'cantabria',
    'aragón', 'aragon', 'extremadura', 'navarra', 'la rioja', 'canarias', 'baleares',
];

// ─── Spanish text indicators ────────────────────────────────────────────────
const SPANISH_TEXT_KEYWORDS = [
    // Job-related
    'desarrollador', 'ingeniero', 'ingeniera', 'programador', 'programadora', 'analista',
    'consultor', 'consultora', 'director', 'directora', 'gerente', 'jefe', 'jefa', 'líder',
    'coordinador', 'coordinadora', 'especialista', 'técnico', 'técnica', 'diseñador', 'diseñadora',
    'arquitecto', 'arquitecta', 'investigador', 'investigadora', 'responsable',
    // Common words in profiles
    'experiencia', 'empresa', 'trabajo', 'proyecto', 'proyectos', 'equipo', 'gestión', 'gestion',
    'implementación', 'implementacion', 'desarrollo', 'tecnología', 'tecnologia', 'soluciones',
    'actualmente', 'anteriormente', 'encargado', 'freelance autónomo', 'autónomo', 'autonomo',
    'disponible', 'remoto', 'presencial', 'híbrido', 'hibrido', 'startup', 'emprendedor',
    'emprendedora', 'cofundador', 'cofundadora', 'fundador', 'fundadora',
    // Education
    'universidad', 'licenciatura', 'máster', 'master', 'grado', 'ingeniería', 'ingenieria',
    'informática', 'informatica', 'telecomunicaciones', 'computación', 'computacion',
    // Connector words
    'años de experiencia', 'año', 'años', 'sobre mí', 'sobre mi', 'acerca de',
];

// ─── Normalize text for matching ─────────────────────────────────────────────
function normalize(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // strip accents for matching
        .trim();
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SpanishDetectionResult {
    isSpanish: boolean;
    confidence: number; // 0-100
    signals: string[];
}

/**
 * Checks if a full name contains a common Hispanic first name.
 */
export function hasSpanishName(fullName: string): { match: boolean; matchedParts: string[] } {
    if (!fullName) return { match: false, matchedParts: [] };

    const normalized = normalize(fullName);
    const parts = normalized.split(/\s+/).filter(p => p.length > 1);
    const matchedParts: string[] = [];

    for (const part of parts) {
        if (SPANISH_FIRST_NAMES.has(part) || SPANISH_SURNAMES.has(part)) {
            matchedParts.push(part);
        }
    }

    return { match: matchedParts.length > 0, matchedParts };
}

/**
 * Checks if location or text contains Spanish-speaking signals.
 */
export function hasSpanishLocationOrText(
    location: string | null,
    title: string | null,
    description: string | null
): { locationMatch: boolean; textMatch: boolean; signals: string[] } {
    const signals: string[] = [];
    let locationMatch = false;
    let textMatch = false;

    // Check location
    if (location) {
        const normLoc = normalize(location);
        for (const loc of SPANISH_LOCATIONS) {
            if (normLoc.includes(normalize(loc))) {
                locationMatch = true;
                signals.push(`location:${loc}`);
                break;
            }
        }
    }

    // Check title and description for Spanish text
    const combinedText = normalize([title || '', description || ''].join(' '));
    if (combinedText.length > 5) {
        let spanishWordCount = 0;
        for (const keyword of SPANISH_TEXT_KEYWORDS) {
            if (combinedText.includes(normalize(keyword))) {
                spanishWordCount++;
                if (spanishWordCount >= 2) {
                    textMatch = true;
                    signals.push(`text:spanish_keywords(${spanishWordCount})`);
                    break;
                }
            }
        }
    }

    return { locationMatch, textMatch, signals };
}

/**
 * Main function: determines if a candidate is likely a Spanish speaker.
 * Returns true if AT LEAST ONE strong signal is detected.
 * 
 * Signals (any one is enough):
 *  - Hispanic first name OR surname
 *  - Location in a Spanish-speaking country/city
 *  - 2+ Spanish keywords in title/description
 */
export function isLikelySpanishSpeaker(
    name: string,
    title: string | null,
    description: string | null,
    location: string | null
): SpanishDetectionResult {
    const signals: string[] = [];
    let confidence = 0;

    // Signal 1: Name
    const nameResult = hasSpanishName(name);
    if (nameResult.match) {
        confidence += 50;
        signals.push(`nombre_hispano:${nameResult.matchedParts.join(',')}`);
    }

    // Signal 2: Location + Text
    const locTextResult = hasSpanishLocationOrText(location, title, description);
    if (locTextResult.locationMatch) {
        confidence += 40;
        signals.push(...locTextResult.signals.filter(s => s.startsWith('location:')));
    }
    if (locTextResult.textMatch) {
        confidence += 30;
        signals.push(...locTextResult.signals.filter(s => s.startsWith('text:')));
    }

    // Signal 3: Also scan description for location keywords (fallback when location is null)
    if (!locTextResult.locationMatch && description) {
        const normDesc = normalize(description);
        for (const loc of SPANISH_LOCATIONS) {
            if (normDesc.includes(normalize(loc))) {
                confidence += 35;
                signals.push(`desc_location:${loc}`);
                break;
            }
        }
    }

    // Cap at 100
    confidence = Math.min(confidence, 100);

    // Pass if ANY signal detected — threshold lowered to catch more valid candidates
    return {
        isSpanish: confidence >= 20,
        confidence,
        signals,
    };
}
