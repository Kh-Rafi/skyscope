const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});

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

async function main() {
    const csvPath = path.join(__dirname, '..', 'data', 'airports.csv');
    const raw = fs.readFileSync(csvPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());

    console.log(`Total lines: ${lines.length}`);

    // Skip header
    const header = parseCSVLine(lines[0]);
    console.log(`Columns: ${header.length}`);
    console.log(`Header: ${header.join(', ')}`);

    const dataLines = lines.slice(1);
    console.log(`Data rows: ${dataLines.length}`);

    const BATCH_SIZE = 500;
    let inserted = 0;

    for (let i = 0; i < dataLines.length; i += BATCH_SIZE) {
        const batch = dataLines.slice(i, i + BATCH_SIZE);
        const values = [];
        const placeholders = [];

        for (const line of batch) {
            const cols = parseCSVLine(line);
            if (cols.length < header.length) continue;

            placeholders.push('(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
            values.push(
                cols[0] || null,   // id
                cols[1] || null,   // ident
                cols[2] || null,   // type
                cols[3] || null,   // name
                cols[4] ? parseFloat(cols[4]) : null,  // latitude_deg
                cols[5] ? parseFloat(cols[5]) : null,  // longitude_deg
                cols[6] ? parseInt(cols[6]) : null,    // elevation_ft
                cols[7] || null,   // continent
                cols[8] || null,   // iso_country
                cols[9] || null,   // iso_region
                cols[10] || null,  // municipality
                cols[11] || null,  // scheduled_service
                cols[12] || null,  // icao_code
                cols[13] || null,  // iata_code
                cols[14] || null,  // gps_code
                cols[15] || null,  // local_code
                cols[16] || null,  // home_link
                cols[17] || null,  // wikipedia_link
                cols[18] || null   // keywords
            );
        }

        if (values.length === 0) continue;

        const sql = `INSERT INTO airports (id, ident, type, name, latitude_deg, longitude_deg, elevation_ft, continent, iso_country, iso_region, municipality, scheduled_service, icao_code, iata_code, gps_code, local_code, home_link, wikipedia_link, keywords) VALUES ${placeholders.join(',')}`;

        try {
            await db.execute({ sql, args: values });
            inserted += batch.length;
            console.log(`Inserted ${inserted} / ${dataLines.length}`);
        } catch (err) {
            console.error(`Batch failed at ${i}:`, err.message);
        }
    }

    console.log(`\n✅ Done. Inserted ${inserted} airports.`);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});