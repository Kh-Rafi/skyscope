const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
}

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

const csvPath = path.join(__dirname, '..', 'data', 'airports.csv');

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    result.push(current);
    return result;
}

async function run() {
    if (!fs.existsSync(csvPath)) {
        throw new Error(`airports.csv not found at ${csvPath}`);
    }

    const csv = fs.readFileSync(csvPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = csv.split('\n').filter(line => line.trim());

    await db.execute('DROP TABLE IF EXISTS airports');
    await db.execute(`
        CREATE TABLE airports (
            id INTEGER,
            ident TEXT,
            type TEXT,
            name TEXT,
            latitude_deg REAL,
            longitude_deg REAL,
            elevation_ft INTEGER,
            continent TEXT,
            iso_country TEXT,
            iso_region TEXT,
            municipality TEXT,
            scheduled_service TEXT,
            icao_code TEXT,
            iata_code TEXT,
            gps_code TEXT,
            local_code TEXT,
            home_link TEXT,
            wikipedia_link TEXT,
            keywords TEXT
        )
    `);

    const rows = [];

    for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);
        if (fields.length !== 19) continue;

        rows.push({
            sql: `
                INSERT INTO airports (
                    id, ident, type, name, latitude_deg, longitude_deg,
                    elevation_ft, continent, iso_country, iso_region, municipality,
                    scheduled_service, icao_code, iata_code, gps_code, local_code,
                    home_link, wikipedia_link, keywords
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
                Number.parseInt(fields[0], 10) || null,
                fields[1] || null,
                fields[2] || null,
                fields[3] || null,
                Number.parseFloat(fields[4]) || null,
                Number.parseFloat(fields[5]) || null,
                Number.parseInt(fields[6], 10) || null,
                fields[7] || null,
                fields[8] || null,
                fields[9] || null,
                fields[10] || null,
                fields[11] || null,
                fields[12] || null,
                fields[13] || null,
                fields[14] || null,
                fields[15] || null,
                fields[16] || null,
                fields[17] || null,
                fields[18] || null
            ]
        });

        if (rows.length === 100) {
            await db.batch(rows, 'write');
            rows.length = 0;
        }
    }

    if (rows.length) await db.batch(rows, 'write');

    await db.execute('CREATE INDEX IF NOT EXISTS idx_airports_country ON airports(iso_country)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_airports_iata ON airports(iata_code)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_airports_name ON airports(name)');

    const result = await db.execute('SELECT COUNT(*) AS count FROM airports');
    console.log(`Imported ${result.rows[0].count} airports into Turso`);
}

run().catch(err => {
    console.error('Airport import failed:', err.message);
    process.exit(1);
});
