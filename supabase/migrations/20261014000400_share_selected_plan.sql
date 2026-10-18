-- HOSTED HISTORY ONLY: imported from the linked project; local workbench uses the newer research schema.
CREATE OR REPLACE FUNCTION public.create_trip_share(p_trip_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.trips; choice public.trip_progress; concepts public.generation_runs; plan public.generation_runs; raw_token text; link_id uuid; snapshot_value jsonb;
BEGIN
 SELECT * INTO t FROM public.trips WHERE id=p_trip_id AND owner_id=auth.uid();
 IF NOT FOUND THEN RAISE EXCEPTION 'Trip unavailable'; END IF;
 SELECT * INTO choice FROM public.trip_progress WHERE trip_id=t.id AND owner_id=auth.uid() AND catalog_version='sample-v1';
 IF choice.generated_concept_run IS NULL OR (choice.payload->>'briefRevision')::integer IS DISTINCT FROM t.revision THEN RAISE EXCEPTION 'Choose a destination for the current trip brief first'; END IF;
 SELECT * INTO concepts FROM public.generation_runs WHERE id=choice.generated_concept_run AND owner_id=auth.uid() AND trip_id=t.id AND brief_revision=t.revision AND kind='concepts' AND status='completed';
 IF NOT FOUND THEN RAISE EXCEPTION 'Selected concepts unavailable'; END IF;
 SELECT * INTO plan FROM public.generation_runs WHERE trip_id=t.id AND owner_id=auth.uid() AND brief_revision=t.revision AND kind='plan' AND status='completed'
 AND input_context->>'conceptRunId'=concepts.id::text AND input_context->>'optionIndex'=choice.generated_option_index::text AND input_context->>'planVersion'='2'
 ORDER BY created_at DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Generate the selected destination plan before sharing'; END IF;
 IF (SELECT count(*) FROM public.share_links WHERE owner_id=auth.uid() AND created_at>now()-interval '1 hour')>=10 THEN RAISE EXCEPTION 'Share limit reached. Try again later.'; END IF;
 snapshot_value=jsonb_build_object('source','generated','nights',t.brief->'nights','departureDate',t.brief->'departureDate','returnDate',t.brief->'returnDate','options',(SELECT jsonb_agg(c->>'name') FROM jsonb_array_elements(concepts.output->'concepts') c),'selectedDestination',concepts.output->'concepts'->choice.generated_option_index->>'name','plan',plan.output);
 raw_token=encode(extensions.gen_random_bytes(32),'hex');
 INSERT INTO public.share_links(trip_id,owner_id,token_hash,snapshot) VALUES(t.id,auth.uid(),encode(extensions.digest(raw_token,'sha256'),'hex'),snapshot_value) RETURNING id INTO link_id;
 RETURN jsonb_build_object('id',link_id,'token',raw_token,'expiresInDays',7);
END;
$$;
