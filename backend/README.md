Hosted deployment: see [DEPLOYMENT.md](DEPLOYMENT.md). `npm start` uses Supabase Auth/Postgres and persistent API allowances; `npm run dev` retains the local workbench. The current suite passes 63 tests. Hosted account setup, migration application, existing local-owner mapping and real-device acceptance remain pending.

# Voyage backend

Implemented core flow: save a user brief → queue researched destination options → choose one → queue a detailed itinerary and researched stays/commute → validate costs/dates → save a version. Includes revocable, view-only destination shortlist links and plan shares. Group voting has been retired.

Run `npm run dev` and open http://127.0.0.1:4173/ for the local feature workbench. It uses embedded Postgres, the actual SQL migrations and shared research pipeline. Local sessions simulate sign-in; this does not verify Supabase Auth. See [LOCAL_TESTING.md](LOCAL_TESTING.md) for the guided checks.

The Supabase project has not been deployed. The supplied frontend remains design HTML; `frontend/api-client.mjs` is the integration adapter for an authenticated Supabase JS client. The workbench is a separate development interface, not a production application bundle.

## Runtime and cost boundaries

Destination discovery begins with three transport-corridor searches before the candidate model call. Candidates compare cross-state reachability, return schedules, station access, overnight rest and usable trip time instead of distance alone. Up to four candidates then receive three searches each, keeping normal concept research at 15 search calls with one recovery call remaining under the existing 16-call ceiling. Timetables retrieved through web search still require operator confirmation; this is not a live railway inventory integration. Existing saved options are not regenerated automatically.

Missing date-specific room prices do not disqualify sourced accommodation suggestions. Concepts retain unknown cost lines and `needs_research` status. If synthesis returns no concepts, the worker performs one bounded recovery pass with up to one broader property search per candidate and resynthesizes. The same 16-search/five-model-call job ceilings apply. If named accommodation, routes or structured fields remain unsupported, the destination is retained as a provisional research hypothesis with unknown costs. Unsupported property details and citations are omitted; no prices or properties are fabricated.

- Node.js 24+ for development/tests and the worker; built-in fetch; PDFKit and bundled Noto Sans fonts generate itinerary PDFs.
- Supabase Postgres/Auth and one Edge Function (`trip-api`).
- External worker process on your computer for development, or an always-on service/container when deployed. **Supabase does not automatically run this Node worker.** Closing the computer stops processing; saved jobs survive and resume when a worker returns.
- Pinned model: `nvidia/nemotron-3-super-120b-a12b:free`, from the saved benchmark config. Worker checks model-catalog token pricing and JSON capability before calling it; no paid fallback or search plugin.
- Tavily basic search: up to twelve queries for concepts (routes, stays, local experiences/access per candidate) and seven for a detailed plan in normal execution. Retries share a persisted ceiling of 16 search requests and five LLM requests per job. Failed calls may still consume provider quota. Earlier live checkpoints may contain the initial eight-query search policy.
- Database allows three destination searches and three itinerary builds per user per rolling day, and one active job per trip. Anonymous accounts need CAPTCHA and provider/account quotas before public launch; per-user limits alone do not prevent signup abuse.
- Free inference can rate-limit or fail. A retryable provider failure is delayed; a job gets at most three claims. A crash can repeat an external request if it happened after charging and before checkpointing; no exactly-once billing guarantee is possible here.

## 1. Server credentials

Root `.env` is ignored by Git. Credentials were moved out of the frontend directory. The local loader temporarily accepts the original labeled-key format as well as standard dotenv. Use `.env.example` as the canonical format:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_KEY
OPENROUTER_API_KEY=YOUR_KEY
TAVILY_API_KEY=YOUR_KEY
OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free
```

Never put service-role, OpenRouter or Tavily credentials in browser JavaScript, `VITE_*` variables, frontend assets, messages or committed files. Serve only the frontend application, never the repository root or `backend/local-research`.

## 2. Create/connect a development Supabase project

In the Supabase dashboard:

1. Create a development project or use an existing dedicated development project.
2. Record the project URL and browser publishable/anon key. The browser key is public; the service-role key is server-only.
3. Save the project URL/service-role key in root `.env` for the worker.
4. Enable anonymous sign-ins in Auth. Configure CAPTCHA/rate controls before making guest access public.
5. For later email access, configure email delivery and approved application redirects. Guest-to-existing-account transfer needs an explicit verified merge flow; do not merge by email string.

With the Supabase CLI available:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
npx supabase secrets set ALLOWED_ORIGINS=http://localhost:5173
npx supabase functions deploy trip-api
```

`db push` applies both migrations. CLI login/project link require access to the intended project; they have not been performed automatically. Use a development project first. Set `ALLOWED_ORIGINS` to the exact deployed origin before using a hosted frontend; comma-separated origins are supported, wildcards are not.

Alternative: run the migration files **in filename order** in a clean development project's SQL editor, then deploy `trip-api` with the CLI. Do not run the same create-table migration twice. Future schema changes should be new migrations.

Optional local Supabase stack (requires Docker): `npx supabase start`, then `npx supabase db reset`, then `npx supabase functions serve trip-api --env-file supabase/functions/.env`. Create that ignored function env file from its example. The automated tests below do not require Docker.

## 3. Start the worker

```powershell
npm ci
npm test
npm run worker
```

For a single eligible job, use `npm run worker:once`. Optionally set `ONLY_JOB_ID` in root `.env` to restrict that invocation to a specific job UUID. No eligible job exits cleanly in once mode. Database state, not a process-local list, owns jobs and progress.

The worker uses service-role-only SQL RPCs, a 180-second lease, a 30-second heartbeat and fencing tokens. It checkpoints candidate generation, each completed search, model output and repair attempts. Stale/cancelled workers cannot publish results. A new brief revision cancels active work and clears selection; historical outputs remain pinned.

The live prototype exposed slow/truncated full responses with optional reasoning enabled. Provider requests therefore disable reasoning when the model catalog says it is optional; mandatory reasoning uses a supported bounded token budget where available. This is independent of source validation and never enables a paid fallback.

## 4. Connect the frontend

Install/use `@supabase/supabase-js` in the future frontend application, configure its project URL and **publishable/anon key only**, and pass that client to the included adapter:

```javascript
import { createClient } from '@supabase/supabase-js';
import { createTravelApi } from './api-client.mjs';

const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_KEY);
const api = createTravelApi(supabase);
await api.startGuest();

const trip = await api.saveBrief({
  departure_location: userDeparture,
  start_date: userStartDate,
  end_date: userEndDate,
  number_of_days: userDays, // includes both arrival and return days
  budget_per_person_minor: Math.round(userBudget * 100),
  currency: 'INR',
  adults: userAdults,
  child_ages: userChildAges,
  rooms: userRooms,
  moods: userMoodKeywords,
  intent: userIntent,
  constraints: userConstraints
});

// Preserve this request ID on retries of the same action.
const requestId = crypto.randomUUID();
const job = await api.researchOptions(trip.id, trip.current_revision, requestId);
const completed = await api.waitForJob(job.id, { onProgress: updateProgress });
if (completed.status !== 'completed') throw new Error(completed.error_code || completed.progress);
const options = await api.getOptions(job.id);
const sources = await api.getSources(job.id);

// Run only after actual user choice; do not automatically choose the first card.
await api.selectOption(trip.id, trip.current_revision, chosenOption.id);
const planJob = await api.buildItinerary(trip.id, trip.current_revision);
await api.waitForJob(planJob.id, { onProgress: updateProgress });
const plans = await api.getPlans(trip.id);
```

Show structured fields as text, not injected HTML. Display sources next to claims. Preserve `null` prices as unavailable, never zero. `needs_research` or `over_budget` concepts must not appear as confirmed affordable recommendations. `indicative_fit` means only that the known estimate arithmetic fits the cap, not verified availability or safety. The API never books anything.

**Price grounding:** numeric totals supplied by the model are ignored. A supported estimate requires an exact excerpt present in the retrieved source, the matching currency/unit price range, and an explicit quantity. Code converts major-unit rates to minor units, multiplies quantities, then sums and allocates party costs. Unsupported excerpts, missing rates, invented free inclusions and “from” tariffs degrade that component to `unknown`, so budget feasibility stays unresolved and the plan cannot be locked. This prevents the factor-of-ten/citation errors found during live testing. It cannot prove source accuracy or that a model chose the right occupancy/quantity; assumptions still need review and date-specific quotes require an inventory integration.

`getOptions()` returns database rows; card values are in each row's `content`. Each stay has an exact retrieved `lookup_url`. Commute source IDs resolve through the job's sources; these are lookup/reference links rather than guaranteed bookable itinerary URLs.

The initial release accepts 2–15 inclusive calendar days, explicit adults/rooms, INR/USD/EUR/GBP budgets and all-in scope. The design's “stays and commute only” budget wording must be updated or explicitly expanded in a later version; it must not be silently interpreted as all-in. Money is stored in minor units. Child tariffs must be reflected in whole-party costs; displayed per-person allocation is an equal share, not a claim that each child's fare equals an adult fare.

## 5. API commands

POST `/functions/v1/trip-api` with the current user bearer token and JSON `{ action, ...input }`. Response: `{ data, error, requestId }`.

| Action | Input | Result |
|---|---|---|
| `save-brief` | `brief`, `tripId` or null, `expectedRevision` | Trip with incremented revision; stale save returns 409 |
| `research-options` | `tripId`, `revision`, `requestId` UUID | 202 with durable job |
| `select-option` | `tripId`, `revision`, `optionId` database UUID | Updated trip |
| `build-itinerary` | `tripId`, `revision`, `requestId` UUID | 202 with durable job |
| `cancel-research` | `jobId` | Cancelled work cannot publish |
| `lock-plan` | `planId` | Locks current selected affordable complete version |
| `create-options-share` | `tripId`, completed current `jobId` | `{ id, token }`, 30-day immutable shortlist snapshot |
| `resolve-options-share` | `token` | View-only option content and public source links |
| `revoke-options-share` | `shareId` | Owner revokes immediately |
| `create-share` | `planId` | `{ id, token }`, 30-day expiry |
| `resolve-share` | `token` | Pinned plan and sanitized source metadata |
| `revoke-share` | `shareId` | Immediate access revocation |

Invite/share recipients start a guest Auth session; they need no visible account signup. The token is a 256-bit random bearer secret, hashed in storage. Build links with tokens in the **URL fragment**, remove from browser history after reading, and send tokens in the POST body. Do not put them in analytics or referrers. These are access-controlled links, not end-to-end encryption.

## 6. Testing

Current verification: 32 automated checks pass. A real Tavily/OpenRouter fixture run retrieved 31 sources for a preliminary destination option and 26 sources for a three-day detailed plan. Cached output also resumed successfully with zero additional provider calls. Review exposed unsupported price arithmetic, so the final validators now discard ungrounded prices; the live sample is correctly marked **budget unresolved**, not a confirmed affordable trip. These are prototype integration results, not a travel-quality or safety certification.

`npm test` runs deterministic domain/provider/worker/Edge tests plus actual Postgres schema/RPC/RLS tests using the development-only PGlite dependency. The Postgres tests stub the minimal Auth schema; they do not replace a real Supabase deployment smoke test. They exercise cross-owner reads/writes, direct mutation denial, stale revisions, quota/idempotency, worker leases, crash checkpoint recovery, private polls, sharing/revocation and plan locking.

Optional commands that use provider quota:

```powershell
npm run providers:check
node backend/live-smoke.mjs
node backend/live-smoke.mjs --itinerary
```

Live smoke uses `backend/examples/brief.json`, **not** a real user's trip. Its itinerary mode takes the first option solely as an automated test fixture selection. Local results/checkpoints are ignored by Git. Rerunning resumes saved work and retains request counters; use a new isolated directory or explicitly archive the old test files before changing the fixture brief. Do not reuse old checkpoints with a different brief.

## Current limitations / next work

- No Supabase URL/service-role credentials were available when implementation began, so hosted migration, Auth and Edge deployment remain to be completed.
- Model results are web-research estimates. No flight/hotel inventory provider, safety certification, live reservations, weather API, payments or booking fulfillment is integrated.
- Search coverage is bounded rather than exhaustive. Prompt instructions and structural evidence validation cannot prove every factual claim; review sources before booking.
- A day without citations is explicitly tagged `unverified_planning_suggestion`, suitable for generic rest/free-time suggestions; it must not be displayed as a researched factual activity or confirmed opening slot.
- Guest-to-email upgrade/existing-account merge, automated account deletion/retention and operational quota dashboards require additional implementation before production.
- Stay swaps currently require generating another plan; no separate repricing/swap command yet.
- PDF export is implemented in the local Node application. Production file storage and a production application interface are not yet implemented. Shortlist/plan sharing and browser adapters are available.
- Run a staging end-to-end flow, review Auth CAPTCHA/email settings, apply organization retention rules and restore/recovery procedures before opening public access.

Official implementation references: [Supabase Auth/function authentication](https://supabase.com/docs/guides/functions/auth), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [function secrets](https://supabase.com/docs/guides/functions/secrets), [OpenRouter reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search).

Local testing allowance: `LOCAL_DAILY_RESEARCH_LIMIT=20` in root `.env` controls both the local database per-user allowance and the instance-wide live allowance, independently for destination searches and itinerary builds per rolling 24 hours. Restart `npm run dev` after changes. Allowed values: 1–100. Failed and cancelled attempts still count. This local override does not change hosted Supabase quotas or provider-side limits; per-job search/model ceilings remain unchanged.

Destination retention: up to three researched hypotheses remain selectable even when their structured synthesis fails validation. Fallback cards clearly identify unverified ideas, preserve independently valid stay/commute details, and mark all cost categories unknown. Detailed itineraries and budget locking retain their stricter validation. Existing saved option sets are not rewritten automatically.

Travel preference and privacy: `travel_scope` is `domestic`, `international`, or `either` (default). Explicit international intent is inferred for older briefs; contradictory domestic-only constraints produce a clear validation error. Discovery compares transport modes without India-specific railway or domestic defaults. No passport/visa input is requested or forwarded from the legacy entry-eligibility field. General official entry requirements remain conditional traveler checks, not a reason to replace international destinations. Saved historical results are not rewritten.

## Email and future delivery

An optional contact email is saved through `save-contact-email` / `get-contact-email` in an owner-only private table. It is not part of the travel brief, model input, API state payload or share snapshots. Verification confirms the saved delivery contact, not account registration or sign-in. Clearing the field removes the contact.

The local Node application now serves owner-only PDF downloads and durable email jobs. See [DELIVERY_TESTING.md](DELIVERY_TESTING.md) for the workflow, test mode, provider setup and acceptance criteria. These Node endpoints have not been deployed to Supabase Edge Functions. Production email identity/sign-in integration remains separate.

Direct email sharing: email verification is no longer required. Destination options offer Email results (summary and expiring share link); detailed plans offer Email itinerary PDF. Enter the recipient for each send. Delivery is owner-scoped, rate-limited and idempotent. See DELIVERY_TESTING.md for outbox testing and Resend sender restrictions. The current automated suite passes 58 tests.
