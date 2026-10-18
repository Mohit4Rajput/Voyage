-- Durable research queue implemented with Postgres row leases + SKIP LOCKED.
-- No queue extension, paid scheduler or public worker endpoint is required.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New trip' check (length(title) between 1 and 160),
  current_revision integer not null default 0,
  selected_option_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index trips_owner on public.trips(owner_id);

create table public.trip_brief_revisions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  revision integer not null,
  brief jsonb not null,
  created_at timestamptz not null default now(),
  unique(trip_id, revision)
);
create table public.research_jobs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  brief_revision integer not null,
  kind text not null check (kind in ('options', 'itinerary')),
  request_key uuid not null,
  selected_option_id uuid,
  status text not null default 'queued' check (status in ('queued','researching','synthesizing','validating','completed','failed','cancelled')),
  progress text not null default 'Queued',
  error_code text,
  result_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(trip_id, request_key),
  foreign key(trip_id, brief_revision) references public.trip_brief_revisions(trip_id, revision)
);
create index research_jobs_trip on public.research_jobs(trip_id, created_at desc);
create table private.job_state (
  job_id uuid primary key references public.research_jobs(id) on delete cascade,
  checkpoint jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz not null default now()
);
create index job_state_available on private.job_state(available_at, lease_until);

create table public.research_sources (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.research_jobs(id) on delete cascade,
  source_key text not null,
  url text not null check (url like 'https://%'),
  title text not null,
  excerpt text not null,
  checked_at timestamptz not null,
  evidence_status text not null default 'web_search_result' check (evidence_status = 'web_search_result'),
  unique(job_id, source_key)
);
create index sources_job on public.research_sources(job_id);
create table public.trip_options (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  job_id uuid not null references public.research_jobs(id) on delete cascade,
  brief_revision integer not null,
  option_key text not null,
  rank integer not null,
  content jsonb not null,
  created_at timestamptz not null default now(),
  unique(job_id, option_key),
  foreign key(trip_id, brief_revision) references public.trip_brief_revisions(trip_id, revision)
);
create index options_trip on public.trip_options(trip_id, created_at desc);
-- Null on deletion avoids dangling references to removed trip outputs.
alter table public.trips add constraint trips_selected_option_fk foreign key(selected_option_id) references public.trip_options(id) on delete set null;
alter table public.research_jobs add constraint jobs_selected_option_fk foreign key(selected_option_id) references public.trip_options(id) on delete set null;

create table public.itinerary_versions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  job_id uuid not null unique references public.research_jobs(id) on delete cascade,
  brief_revision integer not null,
  selected_option_id uuid not null references public.trip_options(id),
  content jsonb not null,
  status text not null default 'draft' check (status in ('draft','locked')),
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(trip_id, brief_revision) references public.trip_brief_revisions(trip_id, revision)
);
create index itineraries_trip on public.itinerary_versions(trip_id, created_at desc);

create table private.plan_shares (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  plan_id uuid not null references public.itinerary_versions(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- SQL validates briefs too: authenticated callers may invoke RPCs directly.
create function private.validate_brief(b jsonb) returns void language plpgsql set search_path = '' as $$
declare days integer; start_day date; end_day date; moods_count integer;
begin
  if b is null or jsonb_typeof(b) <> 'object' or octet_length(b::text) > 10000 then raise exception 'VALIDATION_ERROR: invalid brief'; end if;
  if not (b ?& array['departure_location','start_date','end_date','number_of_days','nights','budget_per_person_minor','currency','budget_scope','adults','rooms','moods','intent','child_ages']) then raise exception 'VALIDATION_ERROR: missing brief fields'; end if;
  if exists(select 1 from unnest(array['departure_location','start_date','end_date','currency','budget_scope','intent']) k where jsonb_typeof(b->k) is distinct from 'string') then raise exception 'VALIDATION_ERROR: string fields required'; end if;
  if exists(select 1 from unnest(array['number_of_days','nights','budget_per_person_minor','adults','rooms']) k where jsonb_typeof(b->k) is distinct from 'number' or (b->>k) !~ '^\d+$') then raise exception 'VALIDATION_ERROR: integral numeric fields required'; end if;
  if length(trim(b->>'departure_location'))=0 or length(trim(b->>'intent'))=0 then raise exception 'VALIDATION_ERROR: blank brief fields'; end if;
  if length(b->>'departure_location') not between 1 and 160 or length(b->>'intent') not between 1 and 1000 then raise exception 'VALIDATION_ERROR: departure and intent required'; end if;
  if (b->>'start_date') !~ '^\d{4}-\d{2}-\d{2}$' or (b->>'end_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'VALIDATION_ERROR: date format'; end if;
  start_day := (b->>'start_date')::date; end_day := (b->>'end_date')::date;
  if (b->>'number_of_days') !~ '^\d+$' or (b->>'adults') !~ '^\d+$' or (b->>'rooms') !~ '^\d+$' or (b->>'budget_per_person_minor') !~ '^\d+$' then raise exception 'VALIDATION_ERROR: integral counts and budget required'; end if;
  days := (b->>'number_of_days')::integer;
  if days not between 2 and 15 or end_day - start_day + 1 <> days or (b->>'nights')::integer <> days - 1 then raise exception 'VALIDATION_ERROR: dates/days/nights disagree'; end if;
  if (b->>'currency') not in ('INR','USD','EUR','GBP') or (b->>'budget_scope') is distinct from 'all_in' or (b->>'budget_per_person_minor')::bigint not between 100 and 1000000000 then raise exception 'VALIDATION_ERROR: budget/currency'; end if;
  if (b->>'adults')::integer not between 1 and 12 or (b->>'rooms')::integer not between 1 and (b->>'adults')::integer then raise exception 'VALIDATION_ERROR: adults/rooms'; end if;
  if jsonb_typeof(b->'child_ages') <> 'array' or jsonb_array_length(b->'child_ages') > 8 then raise exception 'VALIDATION_ERROR: child ages'; end if;
  if exists(select 1 from jsonb_array_elements(b->'child_ages') a where jsonb_typeof(a) <> 'number' or a::text !~ '^\d+$' or (a::text)::integer not between 0 and 17) then raise exception 'VALIDATION_ERROR: child age range'; end if;
  if jsonb_typeof(b->'moods') <> 'array' or jsonb_array_length(b->'moods') <> 3 then raise exception 'VALIDATION_ERROR: three moods required'; end if;
  if exists(select 1 from jsonb_array_elements(b->'moods') m where jsonb_typeof(m) <> 'string' or length(m #>> '{}') not between 1 and 40) then raise exception 'VALIDATION_ERROR: mood keyword'; end if;
  select count(distinct lower(value)) into moods_count from jsonb_array_elements_text(b->'moods');
  if moods_count <> 3 then raise exception 'VALIDATION_ERROR: distinct moods required'; end if;
  if length(coalesce(b->>'constraints','')) > 1500 or length(coalesce(b->>'entry_eligibility','')) > 500 then raise exception 'VALIDATION_ERROR: constraints too long'; end if;
end $$;

create function public.save_travel_brief(p_trip_id uuid, p_expected_revision integer, p_brief jsonb) returns public.trips
language plpgsql security definer set search_path = '' as $$
declare t public.trips; next_revision integer;
begin
  if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
  if p_expected_revision is null or p_expected_revision<0 then raise exception 'CONFLICT'; end if;
  perform private.validate_brief(p_brief);
  if p_trip_id is null then
    if p_expected_revision <> 0 then raise exception 'CONFLICT'; end if;
    if (select count(*) from public.trips where owner_id = auth.uid() and created_at > now()-interval '1 day') >= 20 then raise exception 'RATE_LIMITED'; end if;
    insert into public.trips(owner_id) values(auth.uid()) returning * into t;
  else
    select * into t from public.trips where id=p_trip_id and owner_id=auth.uid() for update;
    if not found then raise exception 'NOT_FOUND'; end if;
  end if;
  if t.current_revision <> p_expected_revision then raise exception 'CONFLICT'; end if;
  next_revision := t.current_revision + 1;
  insert into public.trip_brief_revisions(trip_id, revision, brief) values(t.id, next_revision, p_brief);
  update public.trips set current_revision=next_revision, selected_option_id=null,
    title=left((p_brief->>'departure_location') || ' · ' || (p_brief->>'start_date'),160), updated_at=now() where id=t.id returning * into t;
  update public.research_jobs set status='cancelled', progress='Brief changed; start new research', updated_at=now()
    where trip_id=t.id and status not in ('completed','failed','cancelled');
  return t;
end $$;

create function public.enqueue_research(p_trip_id uuid, p_revision integer, p_kind text, p_request_key uuid) returns public.research_jobs
language plpgsql security definer set search_path = '' as $$
declare t public.trips; j public.research_jobs;
begin
  if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
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
  if (select count(*) from public.research_jobs j2 join public.trips t2 on t2.id=j2.trip_id where t2.owner_id=auth.uid() and j2.created_at > now()-interval '1 day') >= 3 then raise exception 'RATE_LIMITED'; end if;
  insert into public.research_jobs(trip_id,brief_revision,kind,request_key,selected_option_id)
    values(t.id,p_revision,p_kind,p_request_key,case when p_kind='itinerary' then t.selected_option_id else null end) returning * into j;
  insert into private.job_state(job_id) values(j.id);
  return j;
end $$;

create function public.choose_trip_option(p_trip_id uuid, p_revision integer, p_option_id uuid) returns public.trips
language plpgsql security definer set search_path = '' as $$
declare t public.trips;
begin
  select * into t from public.trips where id=p_trip_id and owner_id=auth.uid() for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_revision is null or t.current_revision <> p_revision then raise exception 'CONFLICT'; end if;
  if not exists(select 1 from public.trip_options o join public.research_jobs j on j.id=o.job_id where o.id=p_option_id and o.trip_id=t.id and o.brief_revision=t.current_revision and j.status='completed') then raise exception 'INVALID_OPTION'; end if;
  if t.selected_option_id is distinct from p_option_id then
    update public.research_jobs set status='cancelled',progress='Selection changed',updated_at=now() where trip_id=t.id and kind='itinerary' and status not in ('completed','failed','cancelled');
  end if;
  update public.trips set selected_option_id=p_option_id,updated_at=now() where id=t.id returning * into t;
  return t;
end $$;

create function public.cancel_research(p_job_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.research_jobs j set status='cancelled',progress='Cancelled',updated_at=now()
    where j.id=p_job_id and exists(select 1 from public.trips t where t.id=j.trip_id and t.owner_id=auth.uid()) and j.status not in ('completed','failed','cancelled');
end $$;

create function public.lock_itinerary(p_plan_id uuid) returns public.itinerary_versions language plpgsql security definer set search_path = '' as $$
declare p public.itinerary_versions; t public.trips;
begin
  select t2.* into t from public.trips t2 join public.itinerary_versions p2 on p2.trip_id=t2.id where p2.id=p_plan_id and t2.owner_id=auth.uid() for update of t2;
  if not found then raise exception 'NOT_FOUND'; end if;
  select * into p from public.itinerary_versions where id=p_plan_id for update;
  if p.brief_revision <> t.current_revision or p.selected_option_id is distinct from t.selected_option_id then raise exception 'CONFLICT'; end if;
  if (p.content->'budget'->>'within_budget') is distinct from 'true' then raise exception 'BUDGET_UNRESOLVED'; end if;
  update public.itinerary_versions set status='locked',locked_at=coalesce(locked_at,now()) where id=p.id returning * into p;
  return p;
end $$;

-- Worker RPCs are service-role-only. Lease token fences out old/crashed workers.
create function public.worker_claim(p_only_job uuid default null) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.job_state; j public.research_jobs; b jsonb; chosen jsonb; token uuid;
begin
  -- Lock trip first: consistent ordering with save/select/complete avoids deadlocks.
  select j2.* into j from public.research_jobs j2 join private.job_state s2 on s2.job_id=j2.id join public.trips t on t.id=j2.trip_id
    where j2.status not in ('completed','failed','cancelled') and s2.available_at<=now() and (s2.lease_until is null or s2.lease_until<now()) and (p_only_job is null or j2.id=p_only_job)
    order by j2.created_at for update of t skip locked limit 1;
  if not found then return null; end if;
  select * into s from private.job_state where job_id=j.id for update;
  if s.attempts >= 3 then
    update public.research_jobs set status='failed',error_code='RETRY_LIMIT',progress='Retry limit reached',updated_at=now() where id=j.id;
    return null;
  end if;
  token := gen_random_uuid();
  update private.job_state set attempts=attempts+1,lease_token=token,lease_until=now()+interval '180 seconds' where job_id=j.id;
  update public.research_jobs set status='researching',progress='Research starting',updated_at=now(),error_code=null where id=j.id returning * into j;
  select brief into b from public.trip_brief_revisions where trip_id=j.trip_id and revision=j.brief_revision;
  if j.selected_option_id is not null then select content into chosen from public.trip_options where id=j.selected_option_id; end if;
  return jsonb_build_object('job',to_jsonb(j),'brief',b,'selected_option',chosen,'checkpoint',s.checkpoint,'lease_token',token);
end $$;

create function public.worker_checkpoint(p_job_id uuid,p_lease_token uuid,p_checkpoint jsonb,p_status text,p_progress text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('researching','synthesizing','validating') or octet_length(p_checkpoint::text)>500000 then raise exception 'INVALID_CHECKPOINT'; end if;
  perform 1 from public.trips t join public.research_jobs j on j.trip_id=t.id where j.id=p_job_id for update of t;
  update private.job_state s set checkpoint=p_checkpoint,lease_until=now()+interval '180 seconds'
    where job_id=p_job_id and lease_token=p_lease_token and lease_until>now()
    and exists(select 1 from public.research_jobs j where j.id=s.job_id and j.status not in ('completed','failed','cancelled'));
  if not found then return false; end if;
  update public.research_jobs set status=p_status,progress=left(p_progress,200),updated_at=now() where id=p_job_id;
  return true;
end $$;

create function public.worker_heartbeat(p_job_id uuid,p_lease_token uuid) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.trips t join public.research_jobs j on j.trip_id=t.id where j.id=p_job_id for update of t;
  update private.job_state s set lease_until=now()+interval '180 seconds' where job_id=p_job_id and lease_token=p_lease_token and lease_until>now()
    and exists(select 1 from public.research_jobs j where j.id=s.job_id and j.status not in ('completed','failed','cancelled'));
  return found;
end $$;

create function public.worker_complete(p_job_id uuid,p_lease_token uuid,p_result jsonb,p_sources jsonb) returns boolean language plpgsql security definer set search_path = '' as $$
declare j public.research_jobs; t public.trips; item jsonb; ranking integer:=0;
begin
  select t2.* into t from public.trips t2 join public.research_jobs j2 on j2.trip_id=t2.id where j2.id=p_job_id for update of t2;
  select * into j from public.research_jobs where id=p_job_id for update;
  perform 1 from private.job_state where job_id=j.id and lease_token=p_lease_token and lease_until>now() for update;
  if not found or j.status in ('completed','failed','cancelled') then return false; end if;
  if j.brief_revision<>t.current_revision or (j.kind='itinerary' and j.selected_option_id is distinct from t.selected_option_id) then
    update public.research_jobs set status='cancelled',progress='Inputs changed',updated_at=now() where id=j.id; return false;
  end if;
  for item in select value from jsonb_array_elements(p_sources) loop
    insert into public.research_sources(job_id,source_key,url,title,excerpt,checked_at)
      values(j.id,item->>'id',item->>'url',item->>'title',item->>'content',(item->>'checked_at')::timestamptz)
      on conflict(job_id,source_key) do nothing;
  end loop;
  if j.kind='options' then
    for item in select value from jsonb_array_elements(p_result->'options') loop
      ranking:=ranking+1;
      insert into public.trip_options(trip_id,job_id,brief_revision,option_key,rank,content) values(j.trip_id,j.id,j.brief_revision,item->>'id',ranking,item);
    end loop;
  else
    insert into public.itinerary_versions(trip_id,job_id,brief_revision,selected_option_id,content) values(j.trip_id,j.id,j.brief_revision,j.selected_option_id,p_result);
  end if;
  update public.research_jobs set status='completed',result_summary=case when j.kind='options' then p_result-'options' else jsonb_build_object('title',p_result->'title','evidence_status',p_result->'evidence_status') end,progress=case when j.kind='options' and jsonb_array_length(p_result->'options')=0 then 'No supported options found; revise brief' else 'Ready — review estimates and uncertainties' end,completed_at=now(),updated_at=now() where id=j.id;
  update private.job_state set lease_token=null,lease_until=null,checkpoint='{}'::jsonb where job_id=j.id;
  return true;
end $$;

create function public.worker_fail(p_job_id uuid,p_lease_token uuid,p_code text,p_retry boolean) returns boolean language plpgsql security definer set search_path = '' as $$
declare s private.job_state;
begin
  perform 1 from public.trips t join public.research_jobs j on j.trip_id=t.id where j.id=p_job_id for update of t;
  select * into s from private.job_state where job_id=p_job_id and lease_token=p_lease_token and lease_until>now() for update;
  if not found then return false; end if;
  update public.research_jobs set status=case when p_retry and s.attempts<3 then 'queued' else 'failed' end,error_code=left(p_code,60),progress=case when p_retry and s.attempts<3 then 'Provider unavailable; retry scheduled' else 'Research failed; revise or try again later' end,updated_at=now()
    where id=p_job_id and status not in ('completed','failed','cancelled');
  if not found then return false; end if;
  update private.job_state set lease_token=null,lease_until=null,available_at=now()+interval '60 seconds'*s.attempts where job_id=p_job_id;
  return true;
end $$;

-- RLS + read-only browser roles. All mutations go through narrow functions.
alter table public.trips enable row level security;
create policy owner_read on public.trips for select to authenticated using(owner_id=(select auth.uid()));
do $$ declare table_name text; begin
  foreach table_name in array array['trip_brief_revisions','research_jobs','trip_options','itinerary_versions'] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('create policy owner_read on public.%I for select to authenticated using (exists(select 1 from public.trips t where t.id=trip_id and t.owner_id=(select auth.uid())))',table_name);
  end loop;
end $$;
alter table public.research_sources enable row level security;
create policy owner_read on public.research_sources for select to authenticated using(exists(select 1 from public.research_jobs j join public.trips t on t.id=j.trip_id where j.id=job_id and t.owner_id=(select auth.uid())));
revoke all on public.trips,public.trip_brief_revisions,public.research_jobs,public.research_sources,public.trip_options,public.itinerary_versions from anon,authenticated;
grant select on public.trips,public.trip_brief_revisions,public.research_jobs,public.research_sources,public.trip_options,public.itinerary_versions to authenticated;

revoke all on function public.save_travel_brief(uuid,integer,jsonb),public.enqueue_research(uuid,integer,text,uuid),public.choose_trip_option(uuid,integer,uuid),public.cancel_research(uuid),public.lock_itinerary(uuid) from public,anon;
grant execute on function public.save_travel_brief(uuid,integer,jsonb),public.enqueue_research(uuid,integer,text,uuid),public.choose_trip_option(uuid,integer,uuid),public.cancel_research(uuid),public.lock_itinerary(uuid) to authenticated;
revoke all on function public.worker_claim(uuid),public.worker_checkpoint(uuid,uuid,jsonb,text,text),public.worker_heartbeat(uuid,uuid),public.worker_complete(uuid,uuid,jsonb,jsonb),public.worker_fail(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.worker_claim(uuid),public.worker_checkpoint(uuid,uuid,jsonb,text,text),public.worker_heartbeat(uuid,uuid),public.worker_complete(uuid,uuid,jsonb,jsonb),public.worker_fail(uuid,uuid,text,boolean) to service_role;
