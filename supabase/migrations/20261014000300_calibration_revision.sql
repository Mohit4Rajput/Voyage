-- HOSTED HISTORY ONLY: imported from the linked project; local workbench uses the newer research schema.
-- A changed brief invalidates mood calibration and destination selection atomically.
CREATE OR REPLACE FUNCTION public.reset_calibration_on_brief_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NEW.brief IS DISTINCT FROM OLD.brief THEN
  DELETE FROM public.trip_progress WHERE trip_id = NEW.id;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reset_calibration_on_brief_change() FROM PUBLIC;
DROP TRIGGER IF EXISTS reset_calibration_on_brief_change ON public.trips;
CREATE TRIGGER reset_calibration_on_brief_change AFTER UPDATE OF brief ON public.trips
FOR EACH ROW EXECUTE FUNCTION public.reset_calibration_on_brief_change();
CREATE OR REPLACE FUNCTION public.guard_calibration_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE current_revision integer;
BEGIN
 SELECT revision INTO current_revision FROM public.trips WHERE id=NEW.trip_id FOR SHARE;
 IF (NEW.payload->>'briefRevision')::integer IS DISTINCT FROM current_revision THEN
  RAISE EXCEPTION 'Trip brief changed. Reload and respond to the mood cards again.';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_calibration_revision() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_calibration_revision ON public.trip_progress;
CREATE TRIGGER guard_calibration_revision BEFORE INSERT OR UPDATE ON public.trip_progress
FOR EACH ROW EXECUTE FUNCTION public.guard_calibration_revision();
