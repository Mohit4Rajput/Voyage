-- Delivery contact is private and deliberately separate from research briefs.
create table private.traveler_contacts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check(length(email)<=254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  updated_at timestamptz not null default now()
);
revoke all on private.traveler_contacts from public,anon,authenticated;

create function public.get_contact_email() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
  return coalesce((select jsonb_build_object('email',email,'verified',false,'updated_at',updated_at) from private.traveler_contacts where user_id=auth.uid()),jsonb_build_object('email',null,'verified',false));
end $$;

create function public.save_contact_email(p_email text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
  if p_email is null then
    delete from private.traveler_contacts where user_id=auth.uid();
  else
    if length(p_email)>254 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'VALIDATION_ERROR'; end if;
    insert into private.traveler_contacts(user_id,email) values(auth.uid(),p_email)
      on conflict(user_id) do update set email=excluded.email,updated_at=now();
  end if;
  return public.get_contact_email();
end $$;
revoke all on function public.get_contact_email(),public.save_contact_email(text) from public,anon;
grant execute on function public.get_contact_email(),public.save_contact_email(text) to authenticated;
