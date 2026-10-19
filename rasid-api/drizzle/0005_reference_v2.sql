ALTER TABLE "hs_codes" ADD COLUMN "source_env" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "hs_codes" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', code || ' ' || description)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "ref_lists" ADD COLUMN "source_env" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
CREATE INDEX "hs_codes_search_idx" ON "hs_codes" USING gin ("search");--> statement-breakpoint
CREATE INDEX "hs_codes_digits_idx" ON "hs_codes" USING btree (replace("code", '.', '') text_pattern_ops);--> statement-breakpoint

-- Fallback token for reference lists when Rasid's own token isn't set: a customer token that
-- passed its last test (last_ok_at), production first, then the most recently tested. The API
-- role can't read across tenants (RLS), so this returns the one row needed and nothing else.
CREATE FUNCTION reference_fallback_credential()
RETURNS TABLE (business_id text, env text, key_version text, ciphertext text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT business_id, env, key_version, ciphertext FROM fbr_credentials
  WHERE last_ok_at IS NOT NULL
  ORDER BY (env = 'production') DESC, last_ok_at DESC, business_id
  LIMIT 1
$$;
--> statement-breakpoint
-- FBR refused the fallback token (401): it no longer counts as tested, so the next lookup picks another.
CREATE FUNCTION reference_fallback_rejected(p_business_id text, p_env text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE fbr_credentials SET last_ok_at = NULL WHERE business_id = p_business_id AND env = p_env
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION reference_fallback_credential(), reference_fallback_rejected(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reference_fallback_credential(), reference_fallback_rejected(text, text) TO rasid_app;
