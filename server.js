const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const countryBounds = require('./data/country-bounds');
const Parser = require('rss-parser');
const https = require('https');

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
            countriesLoaded: countriesData.length
        });
    } catch (err) {
        res.status(503).json({
            status: 'error',
            app: 'SkyScope',
            database: 'unavailable'
        });
    }
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

let planesCache = {};
const PLANES_CACHE_DURATION = 30000;

app.get('/api/planes/live', async (req, res) => {
    const country = String(req.query.country || 'BD').toUpperCase();
    let bounds = countryBounds[country];

    if (!bounds) {
        const countryObj = countriesData.find(c => c.cca2 === country || c.cca3 === country);
        if (countryObj && countryObj.latlng && countryObj.latlng.length === 2) {
            const [lat, lng] = countryObj.latlng;
            const area = countryObj.area || 100000;
            const sizeDeg = Math.max(1.5, Math.sqrt(area) / 100);
            bounds = [lat - sizeDeg, lat + sizeDeg, lng - sizeDeg, lng + sizeDeg];
        } else {
            bounds = [-60, 75, -180, 180];
        }
    }

    const now = Date.now();
    if (planesCache[country] && now - planesCache[country].timestamp < PLANES_CACHE_DURATION) {
        return res.json(planesCache[country].data);
    }

    // ================================================================
    // ADSB.LOL API (replaces OpenSky — no IP blocking, no API key)
    // ================================================================
    const [lamin, lamax, lomin, lomax] = bounds;
    const centerLat = (lamin + lamax) / 2;
    const centerLon = (lomin + lomax) / 2;
    // Convert degrees to nautical miles (1 degree ≈ 60 NM)
    const radiusNM = Math.min(250, Math.max(100, (lamax - lamin) * 60));

    const url = `https://api.adsb.lol/v2/lat/${centerLat}/lon/${centerLon}/dist/${radiusNM}`;

    try {
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
            if (planesCache[country]) return res.json(planesCache[country].data);
            return res.status(502).json({
                error: 'adsb.lol API error',
                status: response.status,
                hint: 'Try again soon.'
            });
        }

        const data = await response.json();

        // Map adsb.lol fields to the format your frontend expects
        const planes = (data.ac || [])
            .filter(a => a.lat != null && a.lon != null)
            .map(a => ({
                icao24: a.hex || 'unknown',
                callsign: (a.flight || '').trim() || a.r || 'Unknown',
                origin_country: 'Unknown', // adsb.lol doesn't provide this
                longitude: a.lon,
                latitude: a.lat,
                altitude: a.alt_baro ? Math.round(a.alt_baro) : 0,
                on_ground: a.ground || false,
                velocity: a.gs ? Math.round(a.gs * 1.852) : 0, // knots to km/h
                heading: a.track ? Math.round(a.track) : 0,
                vertical_rate: a.baro_rate || 0,
                geo_altitude: a.alt_geom ? Math.round(a.alt_geom) : 0,
                squawk: a.squawk || null
            }));

        planesCache[country] = { data: planes, timestamp: now };
        res.json(planes);
    } catch (err) {
        if (planesCache[country]) return res.json(planesCache[country].data);
        res.status(502).json({
            error: err.name === 'AbortError' ? 'adsb.lol API timeout' : 'Flight data unavailable',
            hint: 'Try again in a moment.'
        });
    }
});

app.get('/api/planes/countries', (req, res) => {
    res.json(Object.keys(countryBounds));
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
   Keep-alive self-ping
   - Works only while the process is already running on Render.
   - Does NOT wake a sleeping Render free-tier instance.
   - For real keep-alive, use UptimeRobot / cron-job.org on /api/health.
   ------------------------------------------------------------------ */
function startSelfPing() {
    const baseUrl =
        process.env.RENDER_EXTERNAL_URL ||
        process.env.SELF_URL ||
        null;

    if (!baseUrl) {
        console.log('[keep-alive] No RENDER_EXTERNAL_URL / SELF_URL set — self-ping disabled.');
        return;
    }

    const healthUrl = `${baseUrl.replace(/\/$/, '')}/api/health`;
    const INTERVAL_MS = 10 * 60 * 1000;

    const ping = () => {
        https.get(healthUrl, (res) => {
            console.log(`[keep-alive] ping ${healthUrl} → ${res.statusCode}`);
            res.resume();
        }).on('error', (err) => {
            console.warn('[keep-alive] ping failed:', err.message);
        });
    };

    setTimeout(ping, 30 * 1000);
    setInterval(ping, INTERVAL_MS);

    console.log(`[keep-alive] self-ping enabled for ${healthUrl} every 10 min`);
}

async function start() {
    await initializeDatabase();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`SkyScope listening on port ${PORT}`);
        startSelfPing();
    });
}

start().catch(err => {
    console.error('Startup failed:', err.message);
    process.exit(1);
});
