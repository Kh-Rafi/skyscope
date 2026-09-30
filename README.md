# SkyScope

**Live demo:** https://skyscope-dgzc.onrender.com/api/health

SkyScope is a Node.js and Express aviation explorer...


# SkyScope

SkyScope is a Node.js and Express aviation explorer with country data, airport search, live aircraft data, aviation news, and user registration.

## Deployment architecture

- GitHub: source-code repository
- Render: Node.js web service and public HTTPS URL
- Turso: hosted SQLite-compatible database
- OpenSky Network: live aircraft data
- OpenStreetMap: map tiles
- OurAirports: airport dataset
- RSS feeds: aviation news

The project no longer uses the local SQLite file in `database/skyscope.db`. User accounts and airport data are stored in Turso.

## Security changes

- Passwords are stored as bcrypt hashes instead of plaintext.
- Turso credentials are read only from environment variables.
- `.env` files are excluded from Git.
- Authentication endpoints have a basic rate limit.
- The database connection is remote and does not depend on Render's temporary filesystem.
- The server binds to `0.0.0.0` and uses Render's `PORT`.
- No database credentials are included in this ZIP.

This is suitable for a student project and small public demo. It is not a full enterprise authentication system because the current frontend still uses a browser localStorage login gate and the application has no sensitive-user-data authorization layer.

## 1. Create the Turso database

Install the Turso CLI or use the Turso dashboard.

Create a database and obtain:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

Do not put the token in GitHub.

The current Turso Free plan is listed as $0/month with no credit card required, 5 GB storage, 500 million monthly row reads, and 10 million monthly row writes. Check the current pricing before relying on free-tier limits.

## 2. Initialize the database

From the project root, set the environment variables locally.

Windows PowerShell:

```powershell
$env:TURSO_DATABASE_URL="libsql://your-database.turso.io"
$env:TURSO_AUTH_TOKEN="your-token"
npm install
node -e "require('child_process').execSync('node server.js',{stdio:'inherit'})"
```

The server automatically creates the application tables.

You can also use a local `.env` with a dotenv package, but this project intentionally does not include dotenv. For local testing, set the variables in your terminal or VS Code launch configuration.

## 3. Import airport data

The repository includes `data/airports.csv`.

After setting the Turso variables:

```bash
npm install
npm run import
```

The import script recreates only the `airports` table and imports the CSV in batches.

Run this once for a new Turso database. Do not run it against a database containing airport changes you want to preserve.

## 4. Run locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

Health check:

```text
http://localhost:3000/api/health
```

## 5. Push to GitHub

Create a new GitHub repository and upload the project files.

Do not upload:

- `.env`
- Turso auth tokens
- `database/skyscope.db`
- `node_modules`

The included `.gitignore` protects these items.

Recommended commands:

```bash
git init
git add .
git commit -m "Prepare SkyScope for Turso and Render"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY
git push -u origin main
```

## 6. Deploy on Render

Create a new Render Web Service and connect the GitHub repository.

Use:

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`
- Plan: Free, if the current Render free offering fits your needs

Add these environment variables in Render:

```text
NODE_ENV=production
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-token
```

Never put the real token in `render.yaml` or source code.

Render can automatically deploy future pushes to the connected Git branch.

## 7. Important airport-data step after deployment

The Render service does not contain your local SQLite database. That is intentional.

The Turso database must contain the airport records before airport search and country airport lists can return data.

The easiest method is to run the import from your own PC once:

```bash
npm install
npm run import
```

with the same Turso environment variables used by the Render service.

## 8. What happens after deployment

Browser → Render → Express API → Turso

Live aircraft:

Browser → Render → OpenSky Network

Map:

Browser → OpenStreetMap tiles

News:

Browser → Render → RSS feeds

Country information:

Browser → Render → local `countries.json`

Airport data:

Browser → Render → Turso

## 9. GitHub and secrets

GitHub should contain code and public datasets only.

Render should contain the production secrets.

Turso should contain the database.

If a Turso token is ever accidentally committed to GitHub, revoke that token immediately and create a new one.

## 10. Important limitation

The current application was originally designed as a simple login demo. Registration and login are now protected with bcrypt password hashing, but the frontend still stores a small user object in localStorage and does not maintain a server-side authenticated session.

For a real production service containing private user data, the next security upgrade should be an HTTP-only secure session or JWT-based authentication with authorization checks on every private API route.

## 11. Files intentionally removed from the deployment package

The original local SQLite database and `node_modules` directory are not included.

They should not be committed to GitHub. Render installs dependencies from `package.json`, and Turso is the persistent database.

## 12. Render configuration

`render.yaml` is included as a deployment reference. Secret values remain `sync: false`, so you must enter them in the Render dashboard.

