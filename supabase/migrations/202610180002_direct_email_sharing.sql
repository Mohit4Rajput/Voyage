-- Verification is retired. Keep old records private; do not send queued challenges.
update private.mail_jobs set status='failed',error_code='FEATURE_REMOVED',lease_until=null where kind='verification' and status in ('queued','sending');
update private.email_challenges set used_at=coalesce(used_at,now());
alter table private.mail_jobs drop constraint mail_jobs_kind_check;
alter table private.mail_jobs add constraint mail_jobs_kind_check check(kind in ('verification','options','itinerary'));
alter table private.mail_jobs add column trip_id uuid references public.trips(id);
alter table private.mail_jobs add column job_id uuid references public.research_jobs(id);
