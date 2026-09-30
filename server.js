const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const countryBounds = require('./data/country-bounds');
const Parser = require('rss-parser');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { point } = require('@turf/helpers');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
}

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Please try again later.' }
});

/* ------------------------------------------------------------------
   ICAO24 hex prefix → Country of registration
   ------------------------------------------------------------------ */
const ICAO_COUNTRY_PREFIXES = {
    A0: 'United States', A1: 'United States', A2: 'United States', A3: 'United States',
    A4: 'United States', A5: 'United States', A6: 'United States', A7: 'United States',
    A8: 'United States', A9: 'United States', AA: 'United States', AB: 'United States',
    AC: 'United States', AD: 'United States', AE: 'United States', AF: 'United States',
    C0: 'Canada', C1: 'Canada', C2: 'Canada', C3: 'Canada',
    C4: 'Canada', C5: 'Canada', C6: 'Canada', C7: 'Canada',
    C8: 'Canada', C9: 'Canada', CA: 'Canada', CB: 'Canada',
    CC: 'Canada', CD: 'Canada', CE: 'Canada', CF: 'Canada',
    '0D': 'Mexico',
    E0: 'Argentina', E1: 'Argentina', E2: 'Argentina', E3: 'Argentina',
    E4: 'Brazil', E5: 'Brazil', E6: 'Brazil', E7: 'Brazil',
    '30': 'Italy', '31': 'Italy', '32': 'Italy', '33': 'Italy',
    '34': 'Spain', '35': 'Spain', '36': 'Spain', '37': 'Spain',
    '38': 'France', '39': 'France', '3A': 'France', '3B': 'France',
    '3C': 'Germany', '3D': 'Germany', '3E': 'Germany', '3F': 'Germany',
    '40': 'United Kingdom', '41': 'United Kingdom', '42': 'United Kingdom',
    '43': 'United Kingdom', '44': 'United Kingdom',
    '45': 'Denmark', '46': 'Denmark',
    '48': 'Netherlands', '49': 'Netherlands', '4A': 'Netherlands',
    '4B': 'Switzerland', '4C': 'Switzerland', '4D': 'Switzerland',
    '50': 'Ireland', '51': 'Ireland',
    '58': 'Austria', '59': 'Austria',
    '68': 'Sweden', '69': 'Sweden', '6A': 'Sweden',
    '6B': 'Norway', '6C': 'Norway', '6D': 'Norway',
    '70': 'Pakistan',
    '71': 'Bangladesh', '72': 'Bangladesh', '73': 'Bangladesh',
    '74': 'India', '75': 'India', '76': 'India', '77': 'India',
    '78': 'Portugal', '79': 'Portugal',
    '7A': 'China', '7B': 'Mongolia',
    '7C': 'Australia', '7D': 'Australia',
    '7E': 'China', '7F': 'China',
    '80': 'South Korea', '81': 'South Korea', '82': 'South Korea',
    '83': 'South Korea', '84': 'South Korea', '85': 'South Korea',
    '86': 'Japan', '87': 'Japan',
    '88': 'South Korea', '89': 'South Korea',
    '8A': 'Japan', '8B': 'Japan', '8C': 'Japan', '8D': 'Japan',
    '8E': 'Japan', '8F': 'Japan',
    '10': 'Russia', '11': 'Russia', '12': 'Russia', '13': 'Russia',
    '14': 'Russia', '15': 'Russia', '16': 'Russia', '17': 'Russia',
    '18': 'Russia', '19': 'Russia',
    '00': 'South Africa', '01': 'South Africa', '02': 'South Africa',
    '03': 'South Africa', '04': 'South Africa', '05': 'South Africa',
    '06': 'South Africa', '07': 'South Africa',
    '08': 'Egypt', '09': 'Egypt', '0A': 'Egypt', '0B': 'Egypt', '0C': 'Egypt',
    '20': 'Cuba', '21': 'Cuba', '22': 'Cuba', '23': 'Cuba',
    '24': 'Cuba', '25': 'Cuba', '26': 'Cuba', '27': 'Cuba',
    '28': 'Czech Republic', '29': 'Czech Republic',
    '2A': 'Czech Republic', '2B': 'Czech Republic',
    '2C': 'Czech Republic', '2D': 'Czech Republic',
    '2E': 'Czech Republic', '2F': 'Czech Republic',
};

function countryFromHex(hex) {
    if (!hex || hex.length < 2) return 'Unknown';
    const prefix = hex.substring(0, 2).toUpperCase();
    return ICAO_COUNTRY_PREFIXES[prefix] || 'Unknown';
}

/* ------------------------------------------------------------------
   Geospatial: load country polygons + point-in-polygon border check
   ------------------------------------------------------------------ */
const GEOJSON_PATH = path.join(__dirname, 'data', 'countries.geojson');
let countryPolygons = [];

function loadCountryPolygons() {
    try {
        if (!fs.existsSync(GEOJSON_PATH)) {
            console.warn(`[geo] ${GEOJSON_PATH} not found — border filter disabled`);
            return;
        }
        const raw = fs.readFileSync(GEOJSON_PATH, 'utf8');
        const geojson = JSON.parse(raw);

        if (!geojson.features || !Array.isArray(geojson.features)) {
            console.warn('[geo] GeoJSON has no features array');
            return;
        }

        let loaded = 0;
        for (const feature of geojson.features) {
            if (!feature.geometry || !feature.properties) continue;

            const props = feature.properties;
            const name = props.ADMIN || props.name || props.NAME || null;

            const rawIso2 = props.ISO_A2 || props.iso_a2 || props.ISO2 ||
                            props.WB_A2 || props.POSTAL || props.ISO_A2_EH || null;
            const iso2 = rawIso2 && rawIso2 !== '-99' ? String(rawIso2).toUpperCase() : null;

            const rawIso3 = props.ADM0_A3 || props.SOV_A3 || props.ISO_A3 ||
                            props.iso_a3 || props.ISO3 || props.ADM0_A3_US || null;
            const iso3 = rawIso3 && rawIso3 !== '-99' ? String(rawIso3).toUpperCase() : null;

            if (!name) continue;

            countryPolygons.push({
                name,
                iso2,
                iso3,
                geometry: feature.geometry
            });
            loaded++;
        }
        console.log(`[geo] Loaded ${loaded} country polygons for border filtering`);
    } catch (err) {
        console.error('[geo] Failed to load countries.geojson:', err.message);
    }
}

function isInsideCountry(lat, lon, iso2, iso3) {
    if (countryPolygons.length === 0) return true;
    if (lat == null || lon == null) return false;

    const pt = point([lon, lat]);
    const iso2u = iso2 ? String(iso2).toUpperCase() : null;
    const iso3u = iso3 ? String(iso3).toUpperCase() : null;

    let entry = iso3u ? countryPolygons.find(e => e.iso3 === iso3u) : null;
    if (!entry && iso2u) {
        entry = countryPolygons.find(e => e.iso2 === iso2u);
    }

    if (!entry && iso2u) {
        const countryObj = countriesData.find(c => c.cca2 === iso2u);
        if (countryObj) {
            const nameLower = countryObj.name.common.toLowerCase();
            entry = countryPolygons.find(e =>
                e.name && e.name.toLowerCase() === nameLower
            );
        }
    }

    if (!entry) {
        return true;
    }

    try {
        return booleanPointInPolygon(pt, entry.geometry);
    } catch {
        return true;
    }
}

loadCountryPolygons();

const countriesPath = path.join(__dirname, 'data', 'countries.json');
let countriesData = [];

function countryFlagEmoji(code) {
    if (!code || code.length !== 2) return '🏳️';
    try {
        return code.toUpperCase().split('')
            .map(char => 127397 + char.charCodeAt(0))
            .map(cp => String.fromCodePoint(cp)).join('');
    } catch {
        return '🏳️';
    }
}

try {
    if (fs.existsSync(countriesPath)) {
        const raw = fs.readFileSync(countriesPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            countriesData = parsed
                .filter(c => c && c.name && c.name.common && c.cca2)
                .map(c => ({
                    name: { common: c.name.common, official: c.name.official || c.name.common },
                    cca2: c.cca2,
                    cca3: c.cca3 || '',
                    flag: countryFlagEmoji(c.cca2),
                    flags: {
                        png: `https://flagcdn.com/w320/${c.cca2.toLowerCase()}.png`,
                        svg: `https://flagcdn.com/${c.cca2.toLowerCase()}.svg`
                    },
                    capital: c.capital || [],
                    region: c.region || '',
                    subregion: c.subregion || '',
                    population: c.population || 0,
                    area: c.area || 0,
                    currencies: c.currencies || {},
                    languages: c.languages || {},
                    latlng: c.latlng || [],
                    timezones: c.timezones || []
                }))
                .sort((a, b) => a.name.common.localeCompare(b.name.common));
        }
    }
} catch (err) {
    console.error('countries.json error:', err.message);
}

const schemaPath = path.join(__dirname, 'schema.sql');
const schemaStatements = fs.readFileSync(schemaPath, 'utf8')
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);

async function initializeDatabase() {
    for (const statement of schemaStatements) {
        await db.execute(statement);
    }
}

const rssParser = new Parser();

app.get('/api/health', async (req, res) => {
    try {
        await db.execute('SELECT 1 AS ok');
        res.json({
            status: 'ok',
            app: 'SkyScope',
            database: 'connected',
            time: new Date().toISOString(),
            countriesLoaded: countriesData.length,
            countryPolygons: countryPolygons.length,
            cachedCountries: Object.keys(planesCache).length
        });
    } catch (err) {
        res.status(503).json({
            status: 'error',
            app: 'SkyScope',
            database: 'unavailable'
        });
    }
});

app.get('/api/ping', (req, res) => {
    res.type('text/plain').send('OK');
});

app.get('/api/geo/countries', (req, res) => {
    const bd = countryPolygons.find(p =>
        p.iso2 === 'BD' || p.iso3 === 'BGD' ||
        (p.name && p.name.toLowerCase().includes('bangladesh'))
    );

    res.json({
        totalLoaded: countryPolygons.length,
        bangladesh: bd || null,
        sample: countryPolygons.slice(0, 5).map(p => ({
            name: p.name,
            iso2: p.iso2,
            iso3: p.iso3
        }))
    });
});

app.get('/api/planes/debug', (req, res) => {
    const country = String(req.query.country || 'BD').toUpperCase();
    let bounds = countryBounds[country];
    let source = 'country-bounds.js';

    if (!bounds) {
        const countryObj = countriesData.find(c => c.cca2 === country || c.cca3 === country);
        if (countryObj && countryObj.latlng && countryObj.latlng.length === 2) {
            const [lat, lng] = countryObj.latlng;
            const area = countryObj.area || 100000;
            const sizeDeg = Math.max(2.5, Math.sqrt(area) / 60);
            bounds = [lat - sizeDeg, lat + sizeDeg, lng - sizeDeg, lng + sizeDeg];
            source = 'fallback from countries.json';
        } else {
            bounds = [-60, 75, -180, 180];
            source = 'global fallback';
        }
    }

    const [lamin, lamax, lomin, lomax] = bounds;
    const centerLat = (lamin + lamax) / 2;
    const centerLon = (lomin + lomax) / 2;
    const radiusNM = Math.min(1000, Math.max(150, (lamax - lamin) * 60));

    res.json({
        country,
        bounds: { lamin, lamax, lomin, lomax },
        center: { lat: centerLat, lon: centerLon },
        radiusNM,
        source,
        polygonsLoaded: countryPolygons.length,
        url: `https://api.adsb.lol/v2/lat/${centerLat}/lon/${centerLon}/dist/${radiusNM}`
    });
});

app.get('/api/planes/cached', (req, res) => {
    const entries = Object.entries(planesCache).map(([country, v]) => ({
        country,
        planes: v.data.length,
        ageSeconds: Math.round((Date.now() - v.timestamp) / 1000)
    }));
    res.json(entries);
});

app.post('/api/register', authLimiter, async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    if (name.length > 100 || email.length > 254) {
        return res.status(400).json({ error: 'Input is too long' });
    }

    if (password.length < 8 || password.length > 128) {
        return res.status(400).json({ error: 'Password must be 8 to 128 characters' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 12);
        const result = await db.execute({
            sql: 'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
            args: [name, email, passwordHash]
        });

        res.json({ success: true, userId: Number(result.lastInsertRowid) });
    } catch (err) {
        if (String(err.message).toLowerCase().includes('unique')) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        res.status(500).json({ error: 'Unable to create account' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    try {
        const result = await db.execute({
            sql: 'SELECT id, name, email, password, country_code FROM users WHERE email = ?',
            args: [email]
        });

        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        await db.execute({
            sql: 'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
            args: [user.id]
        });

        delete user.password;
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: 'Unable to sign in' });
    }
});

app.get('/api/airports/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q}%`;

    try {
        const result = await db.execute({
            sql: `
                SELECT id, ident, name, type, latitude_deg, longitude_deg,
                       municipality, iata_code, iso_country
                FROM airports
                WHERE (name LIKE ? OR municipality LIKE ? OR iata_code LIKE ? OR ident LIKE ?)
                AND latitude_deg IS NOT NULL AND longitude_deg IS NOT NULL
                ORDER BY CASE type WHEN 'large_airport' THEN 1 WHEN 'medium_airport' THEN 2 WHEN 'small_airport' THEN 3 ELSE 4 END, name
                LIMIT 30
            `,
            args: [like, like, like, like]
        });
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Airport search failed' });
    }
});

app.get('/api/airports/stats/:country', async (req, res) => {
    const country = req.params.country.toUpperCase();

    try {
        const result = await db.execute({
            sql: `
                SELECT COUNT(*) as total,
                    SUM(CASE WHEN type = 'large_airport' THEN 1 ELSE 0 END) as large,
                    SUM(CASE WHEN type = 'medium_airport' THEN 1 ELSE 0 END) as medium,
                    SUM(CASE WHEN type = 'small_airport' THEN 1 ELSE 0 END) as small,
                    SUM(CASE WHEN scheduled_service = 'yes' THEN 1 ELSE 0 END) as scheduled
                FROM airports WHERE iso_country = ?
            `,
            args: [country]
        });
        res.json(result.rows[0] || { total: 0, large: 0, medium: 0, small: 0, scheduled: 0 });
    } catch (err) {
        res.status(500).json({ error: 'Airport statistics failed' });
    }
});

app.get('/api/airports', async (req, res) => {
    const country = String(req.query.country || 'BD').toUpperCase();
    const requestedLimit = Number.parseInt(req.query.limit, 10) || 200;
    const limit = Math.min(Math.max(requestedLimit, 1), 1000);

    try {
        const result = await db.execute({
            sql: `
                SELECT id, ident, name, type, latitude_deg, longitude_deg,
                       municipality, iata_code, iso_country, scheduled_service
                FROM airports
                WHERE iso_country = ? AND latitude_deg IS NOT NULL AND longitude_deg IS NOT NULL
                ORDER BY CASE type WHEN 'large_airport' THEN 1 WHEN 'medium_airport' THEN 2 WHEN 'small_airport' THEN 3 ELSE 4 END, name
                LIMIT ?
            `,
            args: [country, limit]
        });
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Airports could not be loaded' });
    }
});

app.get('/api/airports/:ident', async (req, res) => {
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM airports WHERE ident = ?',
            args: [req.params.ident]
        });
        const row = result.rows[0];
        if (!row) return res.status(404).json({ error: 'Airport not found' });
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: 'Airport could not be loaded' });
    }
});

/* ------------------------------------------------------------------
   Live planes with cache + neighbor prefetch
   ------------------------------------------------------------------ */
let planesCache = {};
const PLANES_CACHE_DURATION = 180000; // 3 minutes

const NEIGHBORS = {
    // South Asia
    IN: ['PK', 'BD', 'NP', 'LK', 'MM', 'BT', 'AF'],
    PK: ['IN', 'AF', 'IR', 'CN', 'TJ'],
    BD: ['IN', 'MM'],
    NP: ['IN', 'CN'],
    LK: ['IN'],
    BT: ['IN', 'CN'],
    AF: ['PK', 'IR', 'TJ', 'UZ', 'TM', 'CN'],
    MV: ['LK', 'IN'],
    // North America
    US: ['CA', 'MX', 'CU'],
    CA: ['US'],
    MX: ['US', 'GT', 'BZ'],
    CU: ['US', 'MX', 'JM', 'HT'],
    JM: ['CU', 'HT'],
    HT: ['DO', 'CU', 'JM'],
    DO: ['HT', 'PR'],
    PR: ['DO', 'VI'],
    BS: ['US', 'CU'],
    // Europe
    GB: ['IE', 'FR', 'NL', 'BE', 'DE'],
    IE: ['GB'],
    FR: ['GB', 'BE', 'DE', 'CH', 'IT', 'ES', 'LU'],
    DE: ['FR', 'NL', 'BE', 'DK', 'PL', 'CZ', 'AT', 'CH', 'LU'],
    NL: ['GB', 'DE', 'BE'],
    BE: ['FR', 'NL', 'DE', 'LU'],
    LU: ['BE', 'FR', 'DE'],
    ES: ['FR', 'PT', 'MA'],
    PT: ['ES'],
    IT: ['FR', 'CH', 'AT', 'SI', 'SM', 'VA'],
    CH: ['FR', 'DE', 'IT', 'AT', 'LI'],
    AT: ['DE', 'CH', 'IT', 'CZ', 'SK', 'HU', 'SI'],
    CZ: ['DE', 'AT', 'SK', 'PL'],
    SK: ['CZ', 'AT', 'HU', 'PL', 'UA'],
    HU: ['AT', 'SK', 'UA', 'RO', 'RS', 'HR', 'SI'],
    PL: ['DE', 'CZ', 'SK', 'UA', 'BY', 'LT', 'RU'],
    DK: ['DE', 'SE', 'NO'],
    SE: ['DK', 'NO', 'FI'],
    NO: ['DK', 'SE', 'FI', 'RU'],
    FI: ['SE', 'NO', 'RU', 'EE'],
    EE: ['FI', 'LV', 'RU'],
    LV: ['EE', 'LT', 'BY', 'RU'],
    LT: ['LV', 'PL', 'BY', 'RU'],
    BY: ['PL', 'LT', 'LV', 'RU', 'UA'],
    UA: ['PL', 'SK', 'HU', 'RO', 'MD', 'RU', 'BY'],
    MD: ['RO', 'UA'],
    RO: ['HU', 'UA', 'MD', 'BG', 'RS'],
    BG: ['RO', 'RS', 'MK', 'GR', 'TR'],
    GR: ['BG', 'MK', 'AL', 'TR'],
    AL: ['GR', 'MK', 'ME', 'XK'],
    MK: ['BG', 'GR', 'AL', 'RS', 'XK'],
    RS: ['HU', 'RO', 'BG', 'MK', 'XK', 'ME', 'BA', 'HR'],
    ME: ['AL', 'RS', 'BA', 'HR', 'XK'],
    BA: ['HR', 'RS', 'ME'],
    HR: ['SI', 'HU', 'RS', 'BA', 'ME'],
    SI: ['IT', 'AT', 'HR', 'HU'],
    // Middle East
    AE: ['SA', 'OM', 'QA'],
    SA: ['AE', 'OM', 'YE', 'JO', 'IQ', 'KW', 'QA'],
    QA: ['SA', 'AE', 'BH'],
    BH: ['SA', 'QA'],
    KW: ['SA', 'IQ'],
    OM: ['AE', 'SA', 'YE'],
    YE: ['SA', 'OM'],
    JO: ['SA', 'IQ', 'SY', 'IL', 'PS', 'EG'],
    IL: ['JO', 'LB', 'SY', 'PS', 'EG'],
    LB: ['SY', 'IL', 'JO'],
    SY: ['TR', 'IQ', 'JO', 'IL', 'LB'],
    IQ: ['TR', 'IR', 'KW', 'SA', 'JO', 'SY'],
    IR: ['IQ', 'TR', 'AM', 'AZ', 'TM', 'AF', 'PK'],
    TR: ['GR', 'BG', 'GE', 'AM', 'AZ', 'IR', 'IQ', 'SY'],
    GE: ['RU', 'TR', 'AM', 'AZ'],
    AM: ['GE', 'TR', 'AZ', 'IR'],
    AZ: ['GE', 'AM', 'IR', 'RU'],
    // Central Asia
    KZ: ['RU', 'CN', 'KG', 'UZ', 'TM'],
    UZ: ['KZ', 'KG', 'TJ', 'TM', 'AF'],
    TM: ['KZ', 'UZ', 'AF', 'IR'],
    KG: ['KZ', 'UZ', 'TJ', 'CN'],
    TJ: ['UZ', 'KG', 'CN', 'AF'],
    // East Asia
    CN: ['HK', 'TW', 'KR', 'JP', 'MN', 'IN', 'RU', 'KZ', 'KG', 'TJ', 'AF', 'PK', 'NP', 'BT', 'MM', 'LA', 'VN'],
    JP: ['KR', 'TW', 'CN', 'RU'],
    KR: ['JP', 'CN', 'KP'],
    KP: ['KR', 'CN', 'RU'],
    TW: ['CN', 'JP', 'PH'],
    HK: ['CN', 'MO'],
    MO: ['HK', 'CN'],
    MN: ['CN', 'RU'],
    // Southeast Asia
    TH: ['MM', 'LA', 'KH', 'MY'],
    MM: ['IN', 'BD', 'CN', 'LA', 'TH'],
    LA: ['TH', 'VN', 'KH', 'MM', 'CN'],
    KH: ['TH', 'LA', 'VN'],
    VN: ['CN', 'LA', 'KH', 'TH'],
    MY: ['SG', 'ID', 'TH', 'BN'],
    SG: ['MY', 'ID'],
    ID: ['MY', 'SG', 'PG', 'TL', 'PH'],
    PH: ['TW', 'VN', 'MY', 'ID'],
    BN: ['MY', 'ID'],
    TL: ['ID'],
    // Oceania
    AU: ['NZ', 'ID', 'PG'],
    NZ: ['AU'],
    PG: ['ID', 'AU'],
    FJ: ['NZ', 'AU'],
    // South America
    BR: ['AR', 'CO', 'PE', 'VE', 'PY', 'UY', 'BO', 'GY', 'SR', 'GF'],
    AR: ['BR', 'CL', 'UY', 'PY', 'BO'],
    CL: ['AR', 'PE', 'BO'],
    CO: ['BR', 'VE', 'EC', 'PE', 'PA'],
    PE: ['BR', 'CO', 'EC', 'BO', 'CL'],
    VE: ['BR', 'CO', 'GY'],
    EC: ['CO', 'PE'],
    BO: ['BR', 'AR', 'CL', 'PE', 'PY'],
    PY: ['BR', 'AR', 'BO'],
    UY: ['BR', 'AR'],
    GY: ['BR', 'VE', 'SR'],
    SR: ['BR', 'GY', 'GF'],
    GF: ['BR', 'SR', 'GY'],
    // Africa
    ZA: ['BW', 'NA', 'ZW', 'MZ', 'SZ', 'LS'],
    EG: ['LY', 'SD', 'IL', 'JO'],
    LY: ['EG', 'TN', 'DZ', 'TD', 'NE', 'SD'],
    TN: ['LY', 'DZ'],
    DZ: ['TN', 'LY', 'NE', 'ML', 'MR', 'MA'],
    MA: ['DZ', 'ES', 'PT'],
    NG: ['BJ', 'NE', 'TD', 'CM'],
    NE: ['NG', 'DZ', 'LY', 'TD', 'ML', 'BF', 'BJ'],
    TD: ['NG', 'NE', 'LY', 'SD', 'CF', 'CM'],
    CM: ['NG', 'TD', 'CF', 'CG', 'GQ', 'GA'],
    KE: ['TZ', 'UG', 'ET', 'SO', 'SS'],
    TZ: ['KE', 'UG', 'RW', 'BI', 'CD', 'ZM', 'MW', 'MZ'],
    UG: ['KE', 'TZ', 'RW', 'SS', 'CD'],
    ET: ['KE', 'SO', 'SS', 'SD', 'ER', 'DJ'],
    SO: ['KE', 'ET', 'DJ'],
    DJ: ['ET', 'SO', 'ER'],
    ER: ['ET', 'SD', 'DJ'],
    SD: ['EG', 'LY', 'TD', 'CF', 'SS', 'ET', 'ER'],
    SS: ['SD', 'ET', 'KE', 'UG', 'CD', 'CF'],
};

async function fetchAndCachePlanes(country) {
    const cached = planesCache[country];
    if (cached && Date.now() - cached.timestamp < PLANES_CACHE_DURATION) {
        return cached.data;
    }

    let bounds = countryBounds[country];
    let boundsSource = 'country-bounds';

    if (!bounds) {
        const countryObj = countriesData.find(c => c.cca2 === country || c.cca3 === country);
        if (countryObj && countryObj.latlng && countryObj.latlng.length === 2) {
            const [lat, lng] = countryObj.latlng;
            const area = countryObj.area || 100000;
            const sizeDeg = Math.min(20, Math.max(2.5, Math.sqrt(area) / 60));
            bounds = [lat - sizeDeg, lat + sizeDeg, lng - sizeDeg, lng + sizeDeg];
            boundsSource = 'fallback';
        } else {
            bounds = [-60, 75, -180, 180];
            boundsSource = 'global';
        }
    }

    const [lamin, lamax, lomin, lomax] = bounds;
    const centerLat = (lamin + lamax) / 2;
    const centerLon = (lomin + lomax) / 2;
    const latSpan = lamax - lamin;
    const radiusNM = Math.min(1000, Math.max(150, latSpan * 60));

    const url = `https://api.adsb.lol/v2/lat/${centerLat}/lon/${centerLon}/dist/${radiusNM}`;

    const fetch = (await import('node-fetch')).default;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let response;
    try {
        response = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        throw new Error(`adsb.lol HTTP ${response.status}`);
    }

    const data = await response.json();
    const rawCount = (data.ac || []).length;

    const planes = (data.ac || [])
        .filter(a => a.lat != null && a.lon != null)
        .filter(a => isInsideCountry(a.lat, a.lon, country, null))
        .map(a => ({
            icao24: a.hex || 'unknown',
            callsign: (a.flight || '').trim() || a.r || 'Unknown',
            origin_country: countryFromHex(a.hex),
            longitude: a.lon,
            latitude: a.lat,
            altitude: a.alt_baro ? Math.round(a.alt_baro) : 0,
            on_ground: a.ground || false,
            velocity: a.gs ? Math.round(a.gs * 1.852) : 0,
            heading: a.track ? Math.round(a.track) : 0,
            vertical_rate: a.baro_rate || 0,
            geo_altitude: a.alt_geom ? Math.round(a.alt_geom) : 0,
            squawk: a.squawk || null
        }));

    console.log(
        `[planes] ${country} [${boundsSource}] → raw ${rawCount}, inside borders ${planes.length}`
    );

    planesCache[country] = { data: planes, timestamp: Date.now() };
    return planes;
}

/* ==================================================================
   PREFETCH — serialized with a global rate limiter
   
   adsb.lol allows ~1 request/second. We enforce a strict serial
   queue with a 1.5s minimum gap between ANY two outgoing requests.
   This prevents the 429 storm.
   ================================================================== */

const lastPrefetchAttempt = {};
const PREFETCH_COOLDOWN_MS = 60 * 1000;   // Don't prefetch same trigger country more than once/minute
const MIN_GAP_BETWEEN_REQUESTS_MS = 1500; // Minimum gap between ANY two adsb.lol requests

let isFlushingQueue = false;
const prefetchQueue = [];
let lastRequestTime = 0;
let currentPrefetchTarget = null;

function prefetchNeighbors(country) {
    const neighbors = NEIGHBORS[country];
    if (!neighbors || neighbors.length === 0) {
        console.log(`[prefetch] no neighbors configured for ${country}`);
        return;
    }

    const now = Date.now();
    if (lastPrefetchAttempt[country] && (now - lastPrefetchAttempt[country]) < PREFETCH_COOLDOWN_MS) {
        console.log(`[prefetch] skipping ${country} — cooldown active`);
        return;
    }
    lastPrefetchAttempt[country] = now;

    currentPrefetchTarget = country;

    const stale = neighbors.filter(n => {
        const c = planesCache[n];
        return !c || (Date.now() - c.timestamp > PLANES_CACHE_DURATION);
    });

    if (stale.length === 0) {
        console.log(`[prefetch] all neighbors of ${country} already fresh`);
        return;
    }

    console.log(`[prefetch] queueing ${stale.length} neighbors of ${country}: ${stale.join(',')}`);

    prefetchQueue.length = 0;

    stale.forEach(neighbor => {
        prefetchQueue.push({ country: neighbor, target: country });
    });

    flushPrefetchQueue();
}

async function flushPrefetchQueue() {
    if (isFlushingQueue) return;
    isFlushingQueue = true;

    try {
        while (prefetchQueue.length > 0) {
            const item = prefetchQueue.shift();

            if (item.target !== currentPrefetchTarget) {
                console.log(`[prefetch] discard ${item.country} — user switched away from ${item.target}`);
                continue;
            }

            const sinceLast = Date.now() - lastRequestTime;
            if (sinceLast < MIN_GAP_BETWEEN_REQUESTS_MS) {
                await new Promise(r => setTimeout(r, MIN_GAP_BETWEEN_REQUESTS_MS - sinceLast));
            }

            const cached = planesCache[item.country];
            if (cached && (Date.now() - cached.timestamp) < PLANES_CACHE_DURATION) {
                console.log(`[prefetch] skip ${item.country} — already fresh`);
                continue;
            }

            try {
                lastRequestTime = Date.now();
                await fetchAndCachePlanes(item.country);
                console.log(`[prefetch] ✅ ${item.country} cached`);
            } catch (err) {
                console.warn(`[prefetch] ❌ ${item.country}: ${err.message}`);

                if (String(err.message).includes('429')) {
                    console.warn(`[prefetch] rate-limited — backing off 30s`);
                    await new Promise(r => setTimeout(r, 30000));
                }
            }
        }
    } finally {
        isFlushingQueue = false;
    }
}

app.get('/api/planes/live', async (req, res) => {
    const country = String(req.query.country || 'BD').toUpperCase();

    const cached = planesCache[country];
    if (cached && Date.now() - cached.timestamp < PLANES_CACHE_DURATION) {
        setImmediate(() => {
            fetchAndCachePlanes(country)
                .then(() => prefetchNeighbors(country))
                .catch(() => {});
        });
        return res.json(cached.data);
    }

    try {
        const planes = await fetchAndCachePlanes(country);
        res.json(planes);
        setImmediate(() => prefetchNeighbors(country));
    } catch (err) {
        if (planesCache[country]) {
            console.warn(`[planes] ${country} fetch failed, using stale cache`);
            return res.json(planesCache[country].data);
        }
        res.status(502).json({
            error: err.name === 'AbortError' ? 'adsb.lol API timeout' : 'Flight data unavailable',
            hint: 'Try again in a moment.'
        });
    }
});

app.get('/api/planes/countries', (req, res) => {
    res.json(Object.keys(countryBounds));
});

/* ------------------------------------------------------------------
   Directions proxy — hides ORS API key from the frontend
   Uses the official OpenRouteService API (api.openrouteservice.org)

   3-tier fallback for finding a routable point:
     1. ORS /snap  → finds nearest road to a coordinate
     2. Nominatim reverse geocode  → finds nearest address (on a road)
     3. Use original coordinate (last resort, may fail)
   ------------------------------------------------------------------ */
const ORS_API_KEY = process.env.ORS_API_KEY;

async function snapToRoad(lat, lon) {
    const fetch = (await import('node-fetch')).default;
    const url = `https://api.openrouteservice.org/v2/snap/driving-car?lat=${lat}&lon=${lon}`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const res = await fetch(url, {
            headers: { 'Authorization': ORS_API_KEY },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) return null;

        const data = await res.json();
        if (data.locations && data.locations[0]) {
            return { lon: data.locations[0][0], lat: data.locations[0][1] };
        }
        return null;
    } catch {
        return null;
    }
}

async function reverseGeocode(lat, lon) {
    const fetch = (await import('node-fetch')).default;
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=16&addressdetails=1`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const res = await fetch(url, {
            headers: {
                'User-Agent': 'SkyScope/1.0 (https://github.com/)',
                'Accept': 'application/json'
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) return null;

        const data = await res.json();
        if (data.lat && data.lon) {
            return { lat: Number(data.lat), lon: Number(data.lon) };
        }
        return null;
    } catch {
        return null;
    }
}

async function findRoutablePoint(lat, lon, label) {
    const snapped = await snapToRoad(lat, lon);
    if (snapped) {
        console.log(`[directions] ${label}: ORS snap → (${snapped.lat}, ${snapped.lon})`);
        return snapped;
    }

    const geo = await reverseGeocode(lat, lon);
    if (geo) {
        console.log(`[directions] ${label}: Nominatim → (${geo.lat}, ${geo.lon})`);
        return geo;
    }

    console.log(`[directions] ${label}: using original (${lat}, ${lon})`);
    return { lat, lon };
}

async function tryDirectionsEndpoint(fromLon, fromLat, toLon, toLat) {
    const fetch = (await import('node-fetch')).default;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
        const response = await fetch(
            'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
            {
                method: 'POST',
                headers: {
                    'Authorization': ORS_API_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, application/geo+json'
                },
                body: JSON.stringify({
                    coordinates: [[fromLon, fromLat], [toLon, toLat]]
                }),
                signal: controller.signal
            }
        );

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            return { ok: false, status: response.status, body: errText };
        }

        const data = await response.json();
        return { ok: true, data };
    } finally {
        clearTimeout(timeoutId);
    }
}

app.get('/api/directions', async (req, res) => {
    if (!ORS_API_KEY) {
        return res.status(503).json({
            error: 'Directions service not configured',
            hint: 'Missing ORS_API_KEY environment variable'
        });
    }

    const fromLat = Number(req.query.fromLat);
    const fromLon = Number(req.query.fromLon);
    const toLat = Number(req.query.toLat);
    const toLon = Number(req.query.toLon);

    if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) {
        return res.status(400).json({
            error: 'Invalid coordinates',
            hint: 'Provide fromLat, fromLon, toLat, toLon'
        });
    }

    try {
        console.log(`[directions] resolving from (${fromLat}, ${fromLon})`);
        const finalFrom = await findRoutablePoint(fromLat, fromLon, 'from');

        console.log(`[directions] resolving to   (${toLat}, ${toLon})`);
        const finalTo = await findRoutablePoint(toLat, toLon, 'to');

        console.log('[directions] requesting route...');
        const result = await tryDirectionsEndpoint(
            finalFrom.lon, finalFrom.lat,
            finalTo.lon, finalTo.lat
        );

        if (result.ok) {
            const feature = result.data.features?.[0];
            if (!feature) {
                return res.status(502).json({ error: 'No route found' });
            }

            const summary = feature.properties?.summary || {};
            console.log('[directions] ✅ success');

            return res.json({
                distanceKm: Math.round((summary.distance || 0) / 100) / 10,
                durationMinutes: Math.round((summary.duration || 0) / 60),
                geometry: feature.geometry,
                bbox: feature.bbox || null,
                snappedFrom: finalFrom,
                snappedTo: finalTo
            });
        }

        console.warn(`[directions] ❌ ORS returned HTTP ${result.status}: ${result.body.slice(0, 200)}`);

        if (result.status === 404) {
            return res.status(404).json({
                error: 'No drivable route found',
                hint: 'The route may cross water, an unmapped border, or a region with no road data.',
                status: 404
            });
        }

        res.status(502).json({
            error: 'Directions service error',
            status: result.status,
            hint: 'ORS rejected the request. Check Render logs for details.'
        });

    } catch (err) {
        console.error('[directions] threw:', err.message);
        res.status(502).json({
            error: 'Directions service error',
            status: 500,
            hint: err.name === 'AbortError' ? 'ORS request timed out.' : err.message
        });
    }
});

let newsCache = { data: null, timestamp: 0 };
const NEWS_CACHE_DURATION = 60 * 60 * 1000;
const NEWS_FEEDS = [
    { name: 'Simple Flying', url: 'https://simpleflying.com/feed/' },
    { name: 'AeroTime', url: 'https://www.aerotime.aero/feed' }
];

app.get('/api/news', async (req, res) => {
    const now = Date.now();
    if (newsCache.data && now - newsCache.timestamp < NEWS_CACHE_DURATION) {
        return res.json(newsCache.data);
    }

    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 12, 30);
    const allArticles = [];

    const fetchWithTimeout = (url) => Promise.race([
        rssParser.parseURL(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);

    const results = await Promise.allSettled(
        NEWS_FEEDS.map(async feed => {
            const parsed = await fetchWithTimeout(feed.url);
            return (parsed.items || []).slice(0, 6).map(item => ({
                title: item.title || 'Untitled',
                link: item.link || '#',
                pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
                source: feed.name,
                snippet: (item.contentSnippet || '').substring(0, 180),
                image: item.enclosure?.url || null
            }));
        })
    );

    results.forEach(result => {
        if (result.status === 'fulfilled') allArticles.push(...result.value);
    });

    allArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    const finalNews = allArticles.slice(0, limit);

    if (finalNews.length > 0) newsCache = { data: finalNews, timestamp: now };
    res.json(finalNews);
});

app.get('/api/country-info/:code', async (req, res) => {
    const code = req.params.code.toUpperCase();
    const country = countriesData.find(c => c.cca2 === code || c.cca3 === code);

    if (!country) return res.status(404).json({ error: 'Country not found' });

    try {
        const result = await db.execute({
            sql: `
                SELECT COUNT(*) as total_airports,
                    SUM(CASE WHEN type = 'large_airport' THEN 1 ELSE 0 END) as large_airports,
                    SUM(CASE WHEN type = 'medium_airport' THEN 1 ELSE 0 END) as medium_airports,
                    SUM(CASE WHEN scheduled_service = 'yes' THEN 1 ELSE 0 END) as scheduled_airports
                FROM airports WHERE iso_country = ?
            `,
            args: [code]
        });

        const stats = result.rows[0] || {};
        res.json({
            country: {
                name: country.name,
                code: country.cca2,
                code3: country.cca3,
                flag: country.flag,
                flags: country.flags,
                capital: country.capital,
                region: country.region,
                subregion: country.subregion,
                population: country.population,
                area: country.area,
                languages: country.languages,
                currencies: country.currencies,
                latlng: country.latlng,
                timezones: country.timezones
            },
            airports: {
                total: stats.total_airports || 0,
                large: stats.large_airports || 0,
                medium: stats.medium_airports || 0,
                scheduled: stats.scheduled_airports || 0
            }
        });
    } catch (err) {
        res.json({
            country,
            airports: { total: 0, large: 0, medium: 0, scheduled: 0 }
        });
    }
});

app.get('/api/countries', (req, res) => {
    res.json(countriesData);
});

app.get('/api/countries/:code', (req, res) => {
    const code = req.params.code.toUpperCase();
    const found = countriesData.find(c => c.cca2 === code || c.cca3 === code);
    if (!found) return res.status(404).json({ error: 'Country not found' });
    res.json(found);
});

/* ------------------------------------------------------------------
   Server startup (NO self-ping — cron-job.org handles keep-alive
   externally with an HTTP request to /api/ping every 5 minutes)
   ------------------------------------------------------------------ */
async function start() {
    await initializeDatabase();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`SkyScope listening on port ${PORT}`);
    });
}

start().catch(err => {
    console.error('Startup failed:', err.message);
    process.exit(1);
});
