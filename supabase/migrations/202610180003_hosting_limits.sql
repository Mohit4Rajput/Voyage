-- Enable only after hosted Auth is configured. Defaults preserve local fixtures.
create table private.hosting_limits(id boolean primary key default true check(id),enabled boolean not null default false,jobs_per_day integer not null default 10 check(jobs_per_day between 1 and 100),search_daily integer not null default 80,search_monthly integer not null default 800,model_daily integer not null default 25,model_monthly integer not null default 250);
insert into private.hosting_limits(id) values(true);
create table private.provider_usage(period text not null,kind text not null,used integer not null,primary key(period,kind));
create function public.reserve_provider_call(p_kind text) returns boolean language plpgsql security definer set search_path='' as $$
declare limits private.hosting_limits; d text:=to_char(now() at time zone 'UTC','YYYY-MM-DD'); m text:=to_char(now() at time zone 'UTC','YYYY-MM'); dl integer; ml integer;
begin
 if p_kind not in ('search','model') then raise exception 'VALIDATION_ERROR'; end if;
 select * into limits from private.hosting_limits where id=true for update;
 if not limits.enabled then raise exception 'HOSTING_NOT_ENABLED'; end if;
 dl:=case when p_kind='search' then limits.search_daily else limits.model_daily end;
 ml:=case when p_kind='search' then limits.search_monthly else limits.model_monthly end;
 if coalesce((select used from private.provider_usage where period=d and kind=p_kind),0)>=dl or coalesce((select used from private.provider_usage where period=m and kind=p_kind),0)>=ml then return false; end if;
 insert into private.provider_usage values(d,p_kind,1) on conflict(period,kind) do update set used=private.provider_usage.used+1;
 insert into private.provider_usage values(m,p_kind,1) on conflict(period,kind) do update set used=private.provider_usage.used+1;
 return true;
end $$;
revoke all on function public.reserve_provider_call(text) from public,anon,authenticated;
grant execute on function public.reserve_provider_call(text) to service_role;
create function public.hosting_ready() returns boolean language sql security definer set search_path='' as $$select coalesce((select enabled from private.hosting_limits where id=true),false)$$;
revoke all on function public.hosting_ready() from public,anon,authenticated;
grant execute on function public.hosting_ready() to service_role;
-- Read-only links must work on a second device without creating a user.
grant execute on function public.resolve_plan_share(text) to anon;
-- Reserve independent capacity for detailed plans after destination searches.
create or replace function public.enqueue_research(p_trip_id uuid, p_revision integer, p_kind text, p_request_key uuid) returns public.research_jobs
language plpgsql security definer set search_path = '' as $$
declare t public.trips; j public.research_jobs;
begin
  if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
  if exists(select 1 from private.hosting_limits where enabled) then
    if not exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null) then raise exception 'UNAUTHORIZED'; end if;
    perform pg_catalog.pg_advisory_xact_lock(712647);
  end if;
  -- Serialize per-owner quota checks across different trips.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 1));
  select * into t from public.trips where id=p_trip_id and owner_id=auth.uid() for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into j from public.research_jobs where trip_id=t.id and request_key=p_request_key;
  if found then
    if j.kind <> p_kind or j.brief_revision <> p_revision then raise exception 'CONFLICT'; end if;
    return j;
  end if;
  if p_kind not in ('options','itinerary') or p_revision <> t.current_revision then raise exception 'CONFLICT'; end if;
  if p_kind='itinerary' and t.selected_option_id is null then raise exception 'SELECT_OPTION_FIRST'; end if;
  if exists(select 1 from public.research_jobs where trip_id=t.id and status not in ('completed','failed','cancelled')) then raise exception 'RESEARCH_ALREADY_RUNNING'; end if;
  if (select count(*) from public.research_jobs j2 join public.trips t2 on t2.id=j2.trip_id where t2.owner_id=auth.uid() and j2.kind=p_kind and j2.created_at > now()-interval '1 day') >= 3 then raise exception 'RATE_LIMITED'; end if;
  if exists(select 1 from private.hosting_limits where enabled and (select count(*) from public.research_jobs where created_at>now()-interval '1 day')>=jobs_per_day) then raise exception 'RATE_LIMITED'; end if;
  insert into public.research_jobs(trip_id,brief_revision,kind,request_key,selected_option_id)
    values(t.id,p_revision,p_kind,p_request_key,case when p_kind='itinerary' then t.selected_option_id else null end) returning * into j;
  insert into private.job_state(job_id) values(j.id);
  return j;
end $$;
