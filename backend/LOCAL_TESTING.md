# Local feature checks

From the project root, run `npm ci` once, then `npm run dev`. Open http://127.0.0.1:4173/. Keep the terminal running. Local records persist in `backend/.local/database`; keys stay in root `.env` and are never served as static files.

## Walk through the product

1. Keep **Synthetic · no API calls** selected for the first pass. Load sample inputs or enter your own brief. Save it. Confirm the revision and reload the page to check persistence. Edit the budget and confirm autosave creates another revision.
2. Click **Research options**. Wait for completion and inspect the three destination cards. Synthetic names and prices exercise the backend but are not travel recommendations.
3. Choose one option explicitly. Build its itinerary. Check that the destination, dates, duration, moods and intent follow your saved brief.
4. In **Detailed plan**, inspect daily activities, stays, commute, source links, cost ledger and uncertainties. Lock a complete synthetic version. Live plans with unresolved required costs must remain unconfirmed.
5. In **Destination options**, click **Share destination options**. Copy or open the link. A viewer can inspect all returned options and their public sources but cannot vote, select, edit, or start research. Revoke the link and confirm it fails. The link pins this option set even if the brief changes later. Localhost links open only on this computer; remote sharing needs deployment.
6. Create a plan share, open its link in another profile, then revoke it and check that it no longer opens. Links work only while the local server is running and are bound to localhost on this computer.
7. Use **Feature checklist** as a record of successful actions in the workbench. It does not certify hosted authentication or provider quality.

## Try real research

Select **Live · OpenRouter + Tavily**, acknowledge API quota use, save a real brief and research again. Keys are read by the server from root `.env`. Free model availability and provider quota can cause failures. The local instance permits at most 20 live destination searches and 20 live itinerary builds per rolling day by default, with separate configurable allowances. Synthetic options cannot be used to generate a live itinerary.

Read every retrieved link and estimate before relying on a result. Web search is not a booking inventory API and cannot guarantee fares, availability or safety. Missing costs remain unknown rather than being filled with invented prices.

## Automated verification

Run `npm test` for the full suite or `npm run test:local` for HTTP feature checks. The HTTP suite creates a temporary in-memory database and does not change your saved local trips or call providers.

Covered: brief validation and revisions; owner isolation; job idempotency and cancellation; three synthetic options; explicit selection; itinerary generation; mode consistency; locking; view-only shortlist snapshots, expiration and revocation; sanitized shares and revocation; stale revisions; quotas; static-file and origin protections.

Browser verified: sample brief save, three options, selection of Test Region B, itinerary rendering, version locking and brief restoration after reload.

Still separate acceptance checks: current live model/search quality, real Supabase Auth and email, hosted permissions, deployment and production frontend integration. PDF export and a local email-verification/delivery workflow are implemented; see DELIVERY_TESTING.md. Real inbox receipt needs provider configuration and testing. Direct bookings are not implemented. JSON download remains available.

## Development details

This workbench runs the same database functions under simulated users, using PGlite rather than a Docker Supabase stack. It is bound to 127.0.0.1. Do not expose this development server publicly.

For isolated browser QA, `node backend/local/server.mjs --qa` uses port 4174 and a separate database. Open http://127.0.0.1:4174/?isolated=1 to keep that tab's simulated identity in session storage without replacing the ordinary session cookie.

Local testing allowance: `LOCAL_DAILY_RESEARCH_LIMIT=20` in root `.env` controls both the local database per-user allowance and the instance-wide live allowance, independently for destination searches and itinerary builds per rolling 24 hours. Restart `npm run dev` after changes. Allowed values: 1–100. Failed and cancelled attempts still count. This local override does not change hosted Supabase quotas or provider-side limits; per-job search/model ceilings remain unchanged.
