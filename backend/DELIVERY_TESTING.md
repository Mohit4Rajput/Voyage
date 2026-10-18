# PDF and direct email sharing

No email registration or verification is required. On Destination options, choose **Email results**, enter one recipient address and send. The email contains the shortlist summary and a view-only link expiring in 30 days. On a saved detailed plan, choose **Email itinerary PDF** to send its PDF attachment to the entered address. Send only to someone expecting the results.

PDF downloads remain available without an email address. The server checks ownership and caps PDFs at 5 MB.

## Local testing

Set MAIL_DELIVERY_MODE=outbox in root .env and restart npm run dev. Generate options, email results to a test address, then build a detailed itinerary and email its PDF. Refresh email status under Travel brief to inspect recipients and download the test attachment. Outbox messages never reach real inboxes and are owner-scoped.

## Real sending

Configure server-only MAIL_DELIVERY_MODE=resend, RESEND_API_KEY and MAIL_FROM in root .env, then restart. Resend's onboarding sender restricts recipients to the account email. Other recipients require a sender on a domain verified in Resend. This is separate from the removed recipient-verification flow.

Localhost shortlist links open only on the computer running the app; the emailed summary remains readable elsewhere. Deploy with a trusted HTTPS application origin for remote link access. Keep the worker running.

Inspect actual inbox receipt, Spam, recipient and PDF contents. Accepted means provider acceptance. Refresh status to query delivered/bounced/complained/failed events; delivered does not prove primary Inbox placement. A previous basic connectivity email was reported delivered. This changed sharing flow has automated outbox/provider-mock coverage, not a new real-inbox test.

## Reliability

Each identity can request five messages of each type per rolling 24 hours, including failures. Recipient and result IDs are pinned to each idempotent request. Jobs persist across restart, retry transient errors up to three claims, recover expired leases and use stable provider idempotency keys. Ambiguous jobs older than 23 hours stop before the provider deduplication window expires. Old queued verification messages are retired by migration.

Before public deployment add real Auth, account-wide abuse controls, CAPTCHA, monitoring and retention/deletion rules. Local simulated sessions are not production authentication.

The automated suite covers direct recipients without verification, PDFs and ownership, shortlist summaries/links, invalid addresses, cross-user isolation, idempotency, quotas, retries, missing configuration and provider rejection.

Email sharing is currently disabled: no email controls or delivery worker run in the local app, and email endpoints return 410. Use Download PDF on a saved detailed plan. Historical delivery implementation remains dormant for possible future use.
