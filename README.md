# Expense Claim Policy Review Assistant

A demo-oriented full-stack MVP for reviewing employee expense claims against internal policy sections. It combines deterministic checks with an optional server-side Gemini review. The default local setup uses in-memory storage and explicitly labels deterministic mock AI results.

## Requirements

- Node.js 20 or newer
- npm
- MongoDB is optional for the default demo; it is required for persistent storage and for the standalone seed command

## Install and configure (Windows PowerShell)

From the project root:

```powershell
Copy-Item .env.example apps/backend/.env -Force
```

An empty, ignored `apps/backend/.env` is included for local use, so you can skip the copy step if it already exists. Open `apps/backend/.env` in an editor and configure values as needed:

```dotenv
PORT=4000
MONGO_URI=
GEMINI_API_KEY=
DEMO_MODE=true
JWT_SECRET=
```

Keep secrets in `apps/backend/.env` or the backend process environment. Never put them in a frontend `.env` file or commit them. The checked-in template deliberately contains no API key.

For MongoDB Atlas, paste the connection URI copied from Atlas into `MONGO_URI` (usually it starts with `mongodb+srv://`). Replace any username/password placeholders in that URI with the database user's credentials; URL-encode special characters in the password. In Atlas, also allow your current IP address in Network Access. Add your Gemini API key to `GEMINI_API_KEY` and set `DEMO_MODE=false` to request live AI. `PORT`, `MONGO_URI`, `GEMINI_API_KEY`, `DEMO_MODE`, and `JWT_SECRET` are the backend settings currently read by this project; adding unrelated variables will not enable unsupported services. `MONGODB_URI` remains supported as an alias for existing local deployments.

Install dependencies:

```powershell
Set-Location apps/backend
npm install
Set-Location ..\frontend
npm install
```

## Run the demo

In one terminal, start the backend:

```powershell
Set-Location apps/backend
npm run dev
```

In a second terminal, start the frontend:

```powershell
Set-Location apps/frontend
npm run dev
```

Open `http://localhost:5173`. The frontend proxies API requests to `http://localhost:4000`.

The backend loads `apps/backend/.env` relative to its own configuration module, so it uses the same file when started from the backend directory or from the project root. A `MONGO_URI` set in the backend process environment takes precedence over the file; startup logs which source is active and, when configured, only the cluster hostname and database name. Credentials and the full URI are never logged.

When `MONGO_URI` is configured, the backend requires a successful database connection before starting. If Atlas rejects authentication, denies database permissions, or cannot be reached, startup fails rather than accepting changes that would not persist. Startup reports a sanitized connection category and nested driver code where available; it does not log the raw driver error. With `MONGO_URI` empty, it uses in-memory demo storage and displays that status in the UI.

If startup reports Atlas error code `8000`, Atlas rejected the database credentials/access. Verify the database user under Atlas **Security → Database Access**, reset its password, and grant read/write permission on the target database. Use that database user's password, not the Atlas website login password. URL-encode reserved characters in the password in the URI. Network/IP access failures usually show up as connection timeouts instead.

## Deploy the backend to Render and frontend to Vercel

The root `render.yaml` configures a Node web service rooted at `apps/backend`. Render installs the backend lockfile dependencies, compiles TypeScript to `apps/backend/dist/server.js`, and starts that file through `npm start`. Set `MONGO_URI`, `GEMINI_API_KEY`, and `FRONTEND_URL` in the Render service dashboard when prompted; keep the Atlas URI and Gemini key in Render's secret environment settings. The Blueprint generates `JWT_SECRET`, but the current demo role-header authorization does not use JWT authentication.

The backend CORS policy allows `https://ai-powered-expense-manage-app.vercel.app` and any origins configured in `FRONTEND_URL`. In the Vercel project settings, set `VITE_API_URL` to `https://ai-powered-expense-manage-app.onrender.com` (or the same URL ending in `/api`) and redeploy the frontend. The frontend normalizes this to a single `/api` prefix; when unset, it uses the Vite development proxy. Atlas must allow connections from Render; configure Atlas Network Access appropriately for your deployment before starting the service.

## Seed demo data

The backend seeds its in-memory demo data automatically at startup. For persistent seed data, start MongoDB, set `MONGO_URI` in `apps/backend/.env`, then run:

```powershell
Set-Location apps/backend
npm run seed
```

The command connects to MongoDB, inserts the built-in policies and sample claims only when those collections are empty, and exits with an error if the database cannot be reached. It does not overwrite existing claims or policies.

## Optional live Gemini mode

Set `GEMINI_API_KEY` in `apps/backend/.env` without echoing it in a terminal or sharing it in chat, then set:

```dotenv
DEMO_MODE=false
```

Restart the backend. Gemini requests are made using Google's official `@google/genai` SDK; the key remains server-side and is never sent to the browser. The backend lists models available to the configured key and selects one advertising `generateContent` support (preferring Gemini Flash models), so it does not assume that a model is available to every project. Live AI responses are schema-validated and policy citations are restricted to retrieved policy sections. Missing keys in explicitly requested live mode, malformed responses, invalid citations, and API failures return an `unavailable` review requiring human attention. They do not fall back to a mock result.

Check key configuration and make a minimal synthetic Gemini request (no claim or employee data is sent) after starting the backend:

```powershell
Invoke-RestMethod http://localhost:4000/api/health/ai
```

Success returns `configured: true`, `connected: true`, and `provider: gemini`. Failures return only a safe category and status code. When `DEMO_MODE=true`, mock review is used even if a key is present. Each AI review includes a source (`mock`, `gemini`, `unavailable`, or `pending`); historical OpenAI reviews remain labeled as legacy. Mock summaries and limitations identify the result as deterministic demo output.

## Tests and production builds

Backend tests and TypeScript build:

```powershell
Set-Location apps/backend
npm test
npm run build
```

Frontend production build:

```powershell
Set-Location apps/frontend
npm run build
```

## Implemented workflows

- Claim submission with request-shape, date, amount, category, and currency checks
- Deterministic duplicate, receipt, category-limit, and high-amount checks
- Mock review and optional server-side Gemini review with validated policy citations
- Reviewer approval, rejection, clarification requests, and classification overrides
- Claim review history and separate audit events
- Seeded policy and claim examples
- Optional MongoDB storage for policies, claims, and audit events; startup hydrates the in-memory working set from MongoDB and writes mutations back to MongoDB

## Limits and demo security

- Role checks use the `x-user-role` header as a demo mechanism, not authentication. Do not expose this service as a production application without real authentication, authorization, and audit controls.
- In-memory demo changes disappear on restart. MongoDB data persistence is only enabled when the database connection succeeds; it requires a configured and reachable MongoDB service.
- Currency conversion is not implemented. Category limits are applied only when the claim currency matches the policy limit currency.
- Receipt availability is a boolean demonstration field; receipt files are not uploaded or stored.
- The model-generated policy assessment is advisory. Deterministic checks and human reviewer decisions remain separate.
- A synthetic live Gemini diagnostic and end-to-end review were verified against the currently configured API project. The test used only synthetic claim and policy data; the review returned structured output with valid policy citations. Re-run the diagnostic after rotating any key that has been shared outside the local environment.
- Automated tests exercise live-AI request construction, model availability selection, response validation, and failure paths using dummy keys and mocked provider responses.
