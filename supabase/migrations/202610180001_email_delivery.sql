alter table private.traveler_contacts add column verified_at timestamptz;
alter table private.traveler_contacts add column verification_method text check(verification_method in ('resend','outbox'));
create table private.email_challenges (
 id uuid primary key, user_id uuid not null references private.traveler_contacts(user_id) on delete cascade,
 email text not null, token_hash text not null unique, mode text not null check(mode in ('resend','outbox')),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '30 minutes', used_at timestamptz
);
create table private.mail_jobs (
 id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in ('verification','itinerary')),mode text not null check(mode in ('resend','outbox')),
 email text not null,plan_id uuid references public.itinerary_versions(id),request_key uuid not null,
 payload jsonb not null,status text not null default 'queued' check(status in ('queued','sending','accepted','delivered','bounced','complained','failed','outbox')),
 attempts integer not null default 0,next_attempt timestamptz not null default now(),lease_until timestamptz,
 provider_id text,error_code text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(user_id,request_key)
);
revoke all on private.email_challenges,private.mail_jobs from public,anon,authenticated;
create function private.invalidate_contact_verification() returns trigger language plpgsql set search_path='' as $$
begin
 if new.email is distinct from old.email then
   new.verified_at=null;new.verification_method=null;
   update private.email_challenges set used_at=coalesce(used_at,now()) where user_id=old.user_id;
 end if;
 return new;
end $$;
create trigger reset_contact_verification before update on private.traveler_contacts for each row execute function private.invalidate_contact_verification();
create or replace function public.get_contact_email() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
 return coalesce((select jsonb_build_object('email',email,'verified',verified_at is not null,'verification_method',verification_method,'updated_at',updated_at) from private.traveler_contacts where user_id=auth.uid()),jsonb_build_object('email',null,'verified',false));
end $$;
