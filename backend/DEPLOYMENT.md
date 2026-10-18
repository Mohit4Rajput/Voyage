# Supabase + Render deployment

## Implemented vs pending

`npm run dev` remains the local PGlite workbench. `npm start` is the separate hosted entry point: Supabase REST reads and user-scoped RPCs, verified Supabase email-code authentication, Secure/HttpOnly cookies, same-origin mutation checks, PDFs generated in memory, public read-only share links and a durable research worker. Hosted mode never opens PGlite or creates local identities. Email sharing remains disabled.

Code and mocked/local database tests do not establish a successful deployment. Applying hosted migrations, configuring Auth/CAPTCHA/SMTP, connecting GitHub/Render, migrating existing local records and testing a real second device remain pending until the intended accounts and URLs are available.

## 1. Prepare Supabase

Use a new staging Supabase project first. Set SUPABASE_URL, SUPABASE_ANON_KEY (the project's public anon key) and SUPABASE_SERVICE_ROLE_KEY in server secrets. Never place the service key in frontend code. No direct database connection string is required.

Review and apply every SQL migration in `supabase/migrations` in filename order using Supabase CLI migrations. Do not rerun migration SQL against an existing schema blindly. Back up any existing hosted data first. A CLI workflow is `supabase login`, `supabase link --project-ref YOUR_REF`, `supabase db push --dry-run`, then `supabase db push` after reviewing the pending list. Local PGlite migrations do not count as hosted migration history.

The final migration creates private hosting limits, a service-role-only API reservation RPC and anonymous read access only to token-scoped share resolvers. After configuring Auth, run this in the Supabase SQL editor:

```sql
update private.hosting_limits set enabled=true where id=true;
```

Defaults: three new jobs of each stage per user per rolling 24 hours; ten jobs globally per rolling 24 hours; 80 Tavily requests/day and 800/month; 25 model requests/day and 250/month (UTC calendar periods). Failed/cancelled jobs and attempted provider calls still count. SQL row/advisory locks enforce limits across restarts and concurrent instances. Requests are reserved before contacting a provider; crashes can consume capacity conservatively. The worker stops a job when the allowance is exhausted. Change limits only after checking your account quotas. These are request-count allowances, not a guarantee of currency billing; Tavily uses basic searches and OpenRouter still rejects paid models/fallbacks.

## 2. Configure real authentication

Enable Supabase email authentication; disable anonymous sign-ins for this deployment. Use an SMTP sender permitted to email your real test users. Supabase's built-in mail service is restricted and should not be treated as production mail delivery.

Create a Cloudflare Turnstile widget for your exact Render hostname. Put the public site key in TURNSTILE_SITE_KEY. Put its secret in **Supabase Auth CAPTCHA protection settings**, enable Turnstile there, and configure Auth rate limits. The app passes the token to Supabase, which validates it once; do not separately consume the same token with Siteverify. Without dashboard CAPTCHA protection, the public Auth endpoint can be called directly, bypassing the widget. Prove direct OTP calls without CAPTCHA fail before launch.

Set Supabase Auth Site URL to APP_ORIGIN and allow only the intended HTTPS deployment origin in redirects. Change the Magic Link email template to show the one-time code `{{ .Token }}`. The app intentionally uses **email codes instead of verification links**: enter the emailed code in the sign-in form. There is no callback URL, link-prefetch issue or recipient verification for PDF downloads. A user can request/enter a code on another device. Keep OTP expiry and email/IP rate limits conservative. SMTP settings here serve authentication; the retired itinerary-email feature stays disabled.

## 3. Existing local records

New hosted records persist in Supabase. Local records are not automatically uploaded: simulated local UUIDs cannot authenticate as real users. Keep backend/.local/database as a private backup. To import old trips safely, first create/verify the intended real accounts, provide an explicit mapping from local owner UUIDs to real Auth UUIDs, then perform a reviewed import of public travel tables and their dependencies. Never upload local session tokens, contact history, mail jobs or verification challenges. Compare row counts and test ownership before deleting any local copy. Do not copy the PGlite filesystem onto Render.

## 4. GitHub and Render

Create a private GitHub repository and connect it to Render using the included render.yaml Blueprint. Review the committed file list: source, migrations, lockfile and deployment configuration only. `.gitignore` excludes .env files, env.txt, node_modules and backend/.local. Also exclude private exports, PDFs and screenshots. Never use an unchecked `git add .`; inspect staged content and run a secret scan before the first push. Ignore rules cannot remove previously tracked secrets: if one was published, revoke it and clean the history.

Render build: `npm ci`; start: `npm start`; runtime: Node 24. The app binds 0.0.0.0 and Render's PORT. The HTTP process and worker run together; worker failure terminates the service so it can restart. Secrets are read from Render's environment. Configure APP_ORIGIN as the exact public HTTPS origin without a trailing slash, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, TURNSTILE_SITE_KEY, OPENROUTER_API_KEY and TAVILY_API_KEY. Do not configure local session or email-sharing settings. Never echo API keys to deployment logs.

Render provides TLS at its proxy. Cookies are Secure, HttpOnly, SameSite=Lax and use __Host- names; all mutations require the configured Origin. Share URLs use the browser's public HTTPS origin. PDFs are created in memory. Sessions and travel data persist at Supabase; no user data depends on Render's temporary filesystem.

Free Render web services sleep when idle. A sleeping service cannot process its queue; work resumes on wake and expired leases recover interrupted research. This is suitable for a prototype, not guaranteed background completion. Do not add an artificial keep-alive loop. Supabase/free-provider limits may change; review their dashboards before launch.

## 5. Acceptance on a second device

1. Open the HTTPS URL on mobile data. No localhost URLs should appear. Request a sign-in code after CAPTCHA, receive it and sign in. Check expired/wrong codes fail and sign-out removes both cookies. Test protected endpoints without cookies return 401.
2. Save a real brief, research options, select one, build an itinerary and download/open its PDF. Check dates, uncertainty labels, costs and source links. Use a small provider allowance during staging.
3. Refresh/redeploy the server and confirm the signed-in account's trip persists. Stop/restart during research and confirm the leased job recovers without repeating saved searches.
4. Open shortlist and plan share links on a second device/private browser without signing in. Verify private brief/account data is absent. Revoke each link and confirm it stops resolving.
5. Sign in as a second account and attempt the first account's trip/plan IDs. Reads, modifications and PDF access must fail. Check limits cannot be reset by logout, another process or restart. Check exhaustion blocks a provider request before it is sent.
6. Verify CAPTCHA is enforced at Supabase Auth itself and inspect actual SMTP delivery. No itinerary email-sharing controls should exist.

Record device/browser, timestamp, job IDs and results without recording tokens or private brief content. Automated mocked tests are not substitutes for these live acceptance checks.

References: https://render.com/docs/web-services ; https://render.com/docs/free ; https://supabase.com/docs/guides/auth/auth-captcha ; https://supabase.com/docs/guides/auth/auth-email-templates
