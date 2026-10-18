-- HOSTED HISTORY ONLY: imported from the linked project; local workbench uses the newer research schema.
begin;
create table public.discovery_trips (
 id uuid primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 revision integer not null default 0,
 stage text not null default 'context' check(stage in ('context','discovery','review','confirmed','suggestions')),
 budget_scope text not null default 'per_person_stays_commute' check(budget_scope='per_person_stays_commute'),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index discovery_owner_updated on public.discovery_trips(owner_id,updated_at desc);
alter table public.discovery_trips enable row level security;
revoke all on public.discovery_trips from anon,authenticated;
grant select,insert,delete on public.discovery_trips to authenticated;
create policy discovery_trip_read on public.discovery_trips for select to authenticated using(owner_id=(select auth.uid()));
create policy discovery_trip_create on public.discovery_trips for insert to authenticated with check(owner_id=(select auth.uid()) and revision=0 and stage='context');
create policy discovery_trip_delete on public.discovery_trips for delete to authenticated using(owner_id=(select auth.uid()));
create table public.discovery_answers (
 trip_id uuid not null references public.discovery_trips(id) on delete cascade,
 module text not null check(module in ('origin','duration','budget','party','vibe')),
 raw_text text not null check(char_length(raw_text) between 1 and 1000),
 parsed jsonb not null check(jsonb_typeof(parsed)='object'),
 parser_version text not null,
 revision integer not null,
 updated_at timestamptz not null default now(),
 primary key(trip_id,module)
);
alter table public.discovery_answers enable row level security;
revoke all on public.discovery_answers from anon,authenticated;
grant select on public.discovery_answers to authenticated;
create policy discovery_answer_read on public.discovery_answers for select to authenticated using(exists(select 1 from public.discovery_trips t where t.id=trip_id and t.owner_id=(select auth.uid())));
create table public.discovery_requests (
 trip_id uuid not null references public.discovery_trips(id) on delete cascade,
 request_id uuid not null,
 fingerprint text not null,
 result jsonb not null,
 created_at timestamptz not null default now(),
 primary key(trip_id,request_id)
);
alter table public.discovery_requests enable row level security;
revoke all on public.discovery_requests from anon,authenticated;
create function public.discovery_save_answer(p_trip uuid,p_request uuid,p_expected_revision integer,p_module text,p_raw text,p_parsed jsonb,p_parser text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.discovery_trips; saved public.discovery_requests; fingerprint_value text; result_value jsonb;
begin
 select * into t from public.discovery_trips where id=p_trip and owner_id=auth.uid() for update;
 if not found then raise exception using errcode='P0002',message='Trip unavailable'; end if;
 fingerprint_value=jsonb_build_array(p_module,p_raw,p_parsed,p_parser,p_expected_revision)::text;
 select * into saved from public.discovery_requests where trip_id=p_trip and request_id=p_request;
 if found then
  if saved.fingerprint<>fingerprint_value then raise exception using errcode='P0001',message='Request conflict'; end if;
  return saved.result;
 end if;
 if t.revision<>p_expected_revision then raise exception using errcode='P0001',message='Stale revision'; end if;
 if (select count(*) from public.discovery_requests where trip_id=p_trip and created_at>now()-interval '1 minute')>=30 then raise exception using errcode='P0001',message='Request limit'; end if;
 update public.discovery_trips set revision=revision+1,stage='context',updated_at=now() where id=p_trip returning * into t;
 insert into public.discovery_answers(trip_id,module,raw_text,parsed,parser_version,revision) values(p_trip,p_module,p_raw,p_parsed,p_parser,t.revision)
 on conflict(trip_id,module) do update set raw_text=excluded.raw_text,parsed=excluded.parsed,parser_version=excluded.parser_version,revision=excluded.revision,updated_at=now();
 result_value=jsonb_build_object('tripId',p_trip,'revision',t.revision,'module',p_module,'parsed',p_parsed);
 insert into public.discovery_requests(trip_id,request_id,fingerprint,result) values(p_trip,p_request,fingerprint_value,result_value);
 return result_value;
end;
$$;
revoke all on function public.discovery_save_answer(uuid,uuid,integer,text,text,jsonb,text) from public;
grant execute on function public.discovery_save_answer(uuid,uuid,integer,text,text,jsonb,text) to authenticated;
commit;
