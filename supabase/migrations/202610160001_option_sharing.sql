-- Keep historical ballots privately for compatibility, but retire voting access.
revoke execute on function public.create_trip_poll(uuid,uuid),public.create_poll_invite(uuid,text,text),public.redeem_poll_invite(text),public.submit_trip_ballot(uuid,uuid,text[]),public.trip_poll_summary(uuid),public.close_trip_poll(uuid),public.revoke_poll_invite(uuid) from authenticated,anon,public;

create table private.option_shares (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  job_id uuid not null references public.research_jobs(id),
  token_hash text not null unique,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '30 days',
  revoked_at timestamptz
);
revoke all on private.option_shares from public,anon,authenticated;

create function public.create_options_share(p_trip_id uuid,p_job_id uuid,p_token_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid; payload jsonb;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'VALIDATION_ERROR'; end if;
  perform 1 from public.trips t join public.research_jobs j on j.trip_id=t.id
    where t.id=p_trip_id and t.owner_id=auth.uid() and j.id=p_job_id and j.kind='options' and j.status='completed' and j.brief_revision=t.current_revision for update of t;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not exists(select 1 from public.trip_options where job_id=p_job_id) then raise exception 'INVALID_OPTION'; end if;
  if (select count(*) from private.option_shares where trip_id=p_trip_id)>=30 then raise exception 'RATE_LIMITED'; end if;
  select jsonb_build_object('options',(select jsonb_agg(jsonb_build_object('rank',o.rank,'content',o.content) order by o.rank) from public.trip_options o where o.job_id=p_job_id),
    'sources',(select coalesce(jsonb_agg(jsonb_build_object('source_key',r.source_key,'url',r.url,'title',r.title,'checked_at',r.checked_at)),'[]'::jsonb) from public.research_sources r where r.job_id=p_job_id),
    'created_at',now()) into payload;
  insert into private.option_shares(trip_id,job_id,token_hash,snapshot) values(p_trip_id,p_job_id,p_token_hash,payload) returning id into result;
  return result;
end $$;

create function public.resolve_options_share(p_token_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload jsonb;
begin
  select snapshot into payload from private.option_shares where token_hash=p_token_hash and revoked_at is null and expires_at>now();
  if payload is null then raise exception 'NOT_FOUND'; end if;
  return payload;
end $$;

create function public.revoke_options_share(p_share_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  update private.option_shares s set revoked_at=coalesce(s.revoked_at,now()) where s.id=p_share_id and exists(select 1 from public.trips t where t.id=s.trip_id and t.owner_id=auth.uid());
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;
revoke all on function public.create_options_share(uuid,uuid,text),public.resolve_options_share(text),public.revoke_options_share(uuid) from public,anon;
grant execute on function public.create_options_share(uuid,uuid,text),public.resolve_options_share(text),public.revoke_options_share(uuid) to authenticated;
grant execute on function public.resolve_options_share(text) to anon;
