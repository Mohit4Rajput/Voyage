-- HOSTED HISTORY ONLY: imported from the linked project; local workbench uses the newer research schema.
begin;
create or replace function public.discovery_save_answer(p_trip uuid,p_request uuid,p_expected_revision integer,p_module text,p_raw text,p_parsed jsonb,p_parser text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.discovery_trips; saved public.discovery_requests; fingerprint_value text; result_value jsonb;
begin
 if p_expected_revision is null or p_expected_revision<0 or p_request is null then raise exception using errcode='P0001',message='Invalid revision or request'; end if;
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
commit;
