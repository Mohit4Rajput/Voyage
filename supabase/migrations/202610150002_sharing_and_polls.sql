-- Private ballots: organizers get only aggregate choices + participation flags.
create table private.polls (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  job_id uuid not null references public.research_jobs(id) on delete cascade,
  closes_at timestamptz not null,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index polls_trip on private.polls(trip_id);
create table private.poll_invites (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references private.polls(id) on delete cascade,
  label text not null check(length(label) between 1 and 80),
  token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  redeemed_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index invites_poll on private.poll_invites(poll_id);
create table private.ballots (
  invite_id uuid primary key references private.poll_invites(id) on delete cascade,
  option_id uuid not null references public.trip_options(id) on delete cascade,
  veto_flags text[] not null default '{}',
  submitted_at timestamptz not null default now()
);

create function public.create_trip_poll(p_trip_id uuid,p_job_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare p private.polls;
begin
  perform 1 from public.trips t join public.research_jobs j on j.trip_id=t.id where t.id=p_trip_id and t.owner_id=auth.uid() and j.id=p_job_id and j.kind='options' and j.status='completed' and j.brief_revision=t.current_revision for update of t;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not exists(select 1 from public.trip_options where job_id=p_job_id) then raise exception 'INVALID_OPTION'; end if;
  if (select count(*) from private.polls where trip_id=p_trip_id)>=20 then raise exception 'RATE_LIMITED'; end if;
  insert into private.polls(trip_id,job_id,closes_at) values(p_trip_id,p_job_id,now()+interval '48 hours') returning * into p;
  return jsonb_build_object('id',p.id,'closes_at',p.closes_at);
end $$;

create function public.create_poll_invite(p_poll_id uuid,p_label text,p_token_hash text) returns uuid language plpgsql security definer set search_path = '' as $$
declare invite_id uuid;
begin
  perform 1 from private.polls p join public.trips t on t.id=p.trip_id where p.id=p_poll_id and t.owner_id=auth.uid() and p.closed_at is null and p.closes_at>now() for update of p;
  if not found then raise exception 'NOT_FOUND'; end if;
  if (select count(*) from private.poll_invites where poll_id=p_poll_id)>=20 then raise exception 'RATE_LIMITED'; end if;
  insert into private.poll_invites(poll_id,label,token_hash) values(p_poll_id,p_label,p_token_hash) returning id into invite_id;
  return invite_id;
end $$;

create function public.redeem_poll_invite(p_token_hash text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare p private.polls; i private.poll_invites; choices jsonb; evidence jsonb;
begin
  if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
  select p2.* into p from private.polls p2 join private.poll_invites i2 on i2.poll_id=p2.id where i2.token_hash=p_token_hash and i2.revoked_at is null for update of p2;
  if not found or p.closed_at is not null or p.closes_at<=now() then raise exception 'NOT_FOUND'; end if;
  select * into i from private.poll_invites where token_hash=p_token_hash for update;
  if i.redeemed_by is not null and i.redeemed_by<>auth.uid() then raise exception 'INVITE_ALREADY_USED'; end if;
  update private.poll_invites set redeemed_by=auth.uid() where id=i.id;
  select jsonb_agg(jsonb_build_object('id',o.id,'content',o.content) order by o.rank) into choices from public.trip_options o where o.job_id=p.job_id;
  select coalesce(jsonb_agg(jsonb_build_object('source_key',s.source_key,'url',s.url,'title',s.title,'checked_at',s.checked_at)),'[]') into evidence from public.research_sources s where s.job_id=p.job_id;
  return jsonb_build_object('poll_id',p.id,'invite_id',i.id,'closes_at',p.closes_at,'options',choices,'sources',evidence);
end $$;

create function public.submit_trip_ballot(p_invite_id uuid,p_option_id uuid,p_veto_flags text[]) returns void language plpgsql security definer set search_path = '' as $$
declare p private.polls; i private.poll_invites;
begin
  -- Close and submit lock the same poll row; deadline cannot race a ballot write.
  select p2.* into p from private.polls p2 join private.poll_invites i2 on i2.poll_id=p2.id where i2.id=p_invite_id for update of p2;
  select * into i from private.poll_invites where id=p_invite_id;
  if p.id is null or i.redeemed_by is distinct from auth.uid() or auth.uid() is null or i.revoked_at is not null then raise exception 'NOT_FOUND'; end if;
  if p.closed_at is not null or p.closes_at<=now() then raise exception 'POLL_CLOSED'; end if;
  if p_veto_flags is null or array_length(p_veto_flags,1)>3 or not p_veto_flags <@ array['dates','accessibility','travel_fatigue'] then raise exception 'VALIDATION_ERROR'; end if;
  if not exists(select 1 from public.trip_options where id=p_option_id and job_id=p.job_id) then raise exception 'INVALID_OPTION'; end if;
  insert into private.ballots(invite_id,option_id,veto_flags) values(i.id,p_option_id,p_veto_flags)
    on conflict(invite_id) do update set option_id=excluded.option_id,veto_flags=excluded.veto_flags,submitted_at=now();
end $$;

create function public.trip_poll_summary(p_poll_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare p private.polls; totals jsonb; participants jsonb; veto_counts jsonb;
begin
  select p2.* into p from private.polls p2 join public.trips t on t.id=p2.trip_id where p2.id=p_poll_id and t.owner_id=auth.uid();
  if not found then raise exception 'NOT_FOUND'; end if;
  select coalesce(jsonb_agg(x),'[]') into totals from (
    select o.id as option_id,count(b.invite_id) as votes from public.trip_options o
      left join private.ballots b on b.option_id=o.id and exists(select 1 from private.poll_invites i where i.id=b.invite_id and i.poll_id=p.id and i.revoked_at is null)
      where o.job_id=p.job_id group by o.id
  ) x;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'label',i.label,'revoked',i.revoked_at is not null,'responded',b.invite_id is not null)),'[]') into participants
    from private.poll_invites i left join private.ballots b on b.invite_id=i.id where i.poll_id=p.id;
  select jsonb_build_object('dates',count(*) filter(where 'dates'=any(b.veto_flags)),
    'accessibility',count(*) filter(where 'accessibility'=any(b.veto_flags)),
    'travel_fatigue',count(*) filter(where 'travel_fatigue'=any(b.veto_flags))) into veto_counts
    from private.ballots b join private.poll_invites i on i.id=b.invite_id where i.poll_id=p.id and i.revoked_at is null;
  return jsonb_build_object('id',p.id,'closed',p.closed_at is not null or p.closes_at<=now(),'closes_at',p.closes_at,'totals',totals,'veto_counts',veto_counts,'participants',participants);
end $$;

create function public.close_trip_poll(p_poll_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from private.polls p join public.trips t on t.id=p.trip_id where p.id=p_poll_id and t.owner_id=auth.uid() for update of p;
  if not found then raise exception 'NOT_FOUND'; end if;
  update private.polls set closed_at=coalesce(closed_at,now()) where id=p_poll_id;
end $$;

create function public.revoke_poll_invite(p_invite_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare poll_id uuid;
begin
  select p.id into poll_id from private.polls p join private.poll_invites i on i.poll_id=p.id join public.trips t on t.id=p.trip_id where i.id=p_invite_id and t.owner_id=auth.uid() for update of p;
  if not found then raise exception 'NOT_FOUND'; end if;
  update private.poll_invites set revoked_at=coalesce(revoked_at,now()) where id=p_invite_id;
end $$;

create function public.create_plan_share(p_plan_id uuid,p_token_hash text) returns uuid language plpgsql security definer set search_path = '' as $$
declare share_id uuid; v_trip_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'VALIDATION_ERROR'; end if;
  select t.id into v_trip_id from public.trips t join public.itinerary_versions p on p.trip_id=t.id where p.id=p_plan_id and t.owner_id=auth.uid();
  if not found then raise exception 'NOT_FOUND'; end if;
  if (select count(*) from private.plan_shares s where s.trip_id=v_trip_id)>=30 then raise exception 'RATE_LIMITED'; end if;
  insert into private.plan_shares(trip_id,plan_id,token_hash,expires_at) values(v_trip_id,p_plan_id,p_token_hash,now()+interval '30 days') returning id into share_id;
  return share_id;
end $$;

create function public.revoke_plan_share(p_share_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  update private.plan_shares s set revoked_at=coalesce(s.revoked_at,now()) where s.id=p_share_id and exists(select 1 from public.trips t where t.id=s.trip_id and t.owner_id=auth.uid());
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

create function public.resolve_plan_share(p_token_hash text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  -- Shared output has no brief, party ages, user identity, invitation or job internals.
  select jsonb_build_object('plan_id',p.id,'content',p.content,'status',p.status,'created_at',p.created_at,
    'sources',(select coalesce(jsonb_agg(jsonb_build_object('source_key',r.source_key,'url',r.url,'title',r.title,'checked_at',r.checked_at)),'[]') from public.research_sources r where r.job_id=p.job_id)) into result
    from private.plan_shares s join public.itinerary_versions p on p.id=s.plan_id
    where s.token_hash=p_token_hash and s.revoked_at is null and s.expires_at>now();
  if result is null then raise exception 'NOT_FOUND'; end if;
  return result;
end $$;

revoke all on function public.create_trip_poll(uuid,uuid),public.create_poll_invite(uuid,text,text),public.redeem_poll_invite(text),public.submit_trip_ballot(uuid,uuid,text[]),public.trip_poll_summary(uuid),public.close_trip_poll(uuid),public.revoke_poll_invite(uuid),public.create_plan_share(uuid,text),public.revoke_plan_share(uuid),public.resolve_plan_share(text) from public,anon;
grant execute on function public.create_trip_poll(uuid,uuid),public.create_poll_invite(uuid,text,text),public.redeem_poll_invite(text),public.submit_trip_ballot(uuid,uuid,text[]),public.trip_poll_summary(uuid),public.close_trip_poll(uuid),public.revoke_poll_invite(uuid),public.create_plan_share(uuid,text),public.revoke_plan_share(uuid),public.resolve_plan_share(text) to authenticated;
