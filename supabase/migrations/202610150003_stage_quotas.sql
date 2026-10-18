-- Reserve independent capacity for detailed plans after destination searches.
create or replace function public.enqueue_research(p_trip_id uuid, p_revision integer, p_kind text, p_request_key uuid) returns public.research_jobs
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
  if (select count(*) from public.research_jobs j2 join public.trips t2 on t2.id=j2.trip_id where t2.owner_id=auth.uid() and j2.kind=p_kind and j2.created_at > now()-interval '1 day') >= 3 then raise exception 'RATE_LIMITED'; end if;
  insert into public.research_jobs(trip_id,brief_revision,kind,request_key,selected_option_id)
    values(t.id,p_revision,p_kind,p_request_key,case when p_kind='itinerary' then t.selected_option_id else null end) returning * into j;
  insert into private.job_state(job_id) values(j.id);
  return j;
end $$;
