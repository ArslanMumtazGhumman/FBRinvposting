-- Row-level security, privileges and integrity guards.
--
-- The API connects as a login role that is a member of rasid_app (created by
-- `npm run db:migrate` from DATABASE_URL). rasid_app does not own the tables,
-- so every policy below applies to it. Migrations run as the table owner.
--
-- Each request that touches business data runs in a transaction that sets
--   set_config('app.user_id', <user>, true), set_config('app.business_id', <business>, true)
-- and the policies only expose rows of that business, and only while that
-- user is a member of it (src/db/client.ts, withBusiness()).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rasid_app') THEN
    CREATE ROLE rasid_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint

/* ---------- request context ---------- */

CREATE FUNCTION app_business_id() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.business_id', true), '') $$;
--> statement-breakpoint
CREATE FUNCTION app_user_id() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '') $$;
--> statement-breakpoint
CREATE FUNCTION app_is_member() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM memberships WHERE user_id = app_user_id() AND business_id = app_business_id()) $$;
--> statement-breakpoint

/* ---------- privileges ---------- */

GRANT USAGE ON SCHEMA public TO rasid_app;
--> statement-breakpoint
GRANT SELECT ON tenants, memberships TO rasid_app;
--> statement-breakpoint
GRANT SELECT ON users TO rasid_app;
--> statement-breakpoint
GRANT UPDATE (fails, locked_until, last_login_at) ON users TO rasid_app;
--> statement-breakpoint
GRANT SELECT ON businesses TO rasid_app;
--> statement-breakpoint
GRANT UPDATE (name, ntn_cnic, province, address, activity, sector, environment, default_sale_type,
              further_tax_rate, invoice_prefix, next_invoice_no, updated_at) ON businesses TO rasid_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON fbr_credentials, customers, products, invoices, invoice_items, import_mappings TO rasid_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON api_calls TO rasid_app;
--> statement-breakpoint
GRANT INSERT ON audit_log TO rasid_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE api_calls_id_seq, audit_log_id_seq TO rasid_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_business_id(), app_user_id(), app_is_member() TO rasid_app;
--> statement-breakpoint

/* ---------- policies ---------- */

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY memberships_self ON memberships FOR SELECT USING (user_id = app_user_id());
--> statement-breakpoint

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Listing needs every business of the user; changing one needs that business in context.
CREATE POLICY businesses_list ON businesses FOR SELECT
  USING (id IN (SELECT business_id FROM memberships WHERE user_id = app_user_id()));
--> statement-breakpoint
CREATE POLICY businesses_update ON businesses FOR UPDATE
  USING (id = app_business_id() AND (SELECT app_is_member()))
  WITH CHECK (id = app_business_id() AND (SELECT app_is_member()));
--> statement-breakpoint

-- (SELECT app_is_member()) is evaluated once per statement (initplan), not per row.
ALTER TABLE fbr_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY business_isolation ON fbr_credentials
  USING (business_id = app_business_id() AND (SELECT app_is_member()))
  WITH CHECK (business_id = app_business_id() AND (SELECT app_is_member()));
--> statement-breakpoint
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY business_isolation ON customers
  USING (business_id = app_business_id() AND (SELECT app_is_member()))
  WITH CHECK (business_id = app_business_id() AND (SELECT app_is_member()));
--> statement-breakpoint
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY business_isolation ON products
  USING (business_id = app_business_id() AND (SELECT app_is_member()))
  WITH CHECK (business_id = app_business_id() AND (SELECT app_is_member()));
--> statement-breakpoint
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY business_isolation ON invoices
  USING (business_id = app_business_id() AND (SELECT app_is_member()))
  WITH CHECK (business_id = app_business_id() AND (SELECT app_is_member()));
--> statement-breakpoint
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY business_isolation ON invoice_items
  USING (business_id = app_business_id() AND (SELECT app_is_member()))
  WITH CHECK (business_id = app_business_id() AND (SELECT app_is_member()));
--> statement-breakpoint
ALTER TABLE import_mappings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY business_isolation ON import_mappings
  USING (business_id = app_business_id() AND (SELECT app_is_member()))
  WITH CHECK (business_id = app_business_id() AND (SELECT app_is_member()));
--> statement-breakpoint
ALTER TABLE api_calls ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY business_isolation ON api_calls
  USING (business_id = app_business_id() AND (SELECT app_is_member()))
  WITH CHECK (business_id = app_business_id() AND (SELECT app_is_member()));
--> statement-breakpoint

-- The app may append audit rows (account-level ones have no business) but never read them.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_append ON audit_log FOR INSERT
  WITH CHECK (business_id IS NULL OR (business_id = app_business_id() AND (SELECT app_is_member())));
--> statement-breakpoint

-- The chain needs the previous hash; expose only that, nothing else from the log.
CREATE FUNCTION audit_tip() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1 $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_tip() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_tip() TO rasid_app;
--> statement-breakpoint

/* ---------- append-only tables ---------- */

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER api_calls_append_only BEFORE UPDATE OR DELETE ON api_calls FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER api_calls_no_truncate BEFORE TRUNCATE ON api_calls FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
--> statement-breakpoint

/* ---------- posted invoices are immutable (corrections go through a debit note) ---------- */

CREATE FUNCTION invoices_guard_posted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Invoice % is posted to FBR and cannot be changed. Issue a debit note against IRN %.',
      OLD.local_ref, OLD.fbr_invoice_number USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_immutable_when_posted BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard_posted();
--> statement-breakpoint

CREATE FUNCTION invoice_items_guard_posted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN inv_id := OLD.invoice_id; ELSE inv_id := NEW.invoice_id; END IF;
  IF EXISTS (SELECT 1 FROM invoices WHERE id = inv_id AND status = 'posted') THEN
    RAISE EXCEPTION 'Invoice is posted to FBR; its lines cannot be changed.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.invoice_id <> NEW.invoice_id
     AND EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id AND status = 'posted') THEN
    RAISE EXCEPTION 'Invoice is posted to FBR; its lines cannot be changed.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_items_immutable_when_posted BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION invoice_items_guard_posted();
