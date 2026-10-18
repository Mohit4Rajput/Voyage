-- HOSTED HISTORY ONLY: imported from the linked project; local workbench uses the newer research schema.
-- Dedicated server-only access to the optional search credential.
CREATE OR REPLACE FUNCTION public.commute_search_key()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
 SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='voyage_tavily' LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.commute_search_key() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commute_search_key() TO service_role;
