ALTER TABLE "businesses" ADD COLUMN "further_tax_rates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
GRANT UPDATE (further_tax_rates) ON businesses TO rasid_app;
--> statement-breakpoint
-- create_business() also takes the dated further-tax changes (validated by the API: BusinessInput).
CREATE OR REPLACE FUNCTION create_business(b jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  uid text := app_user_id();
  t text;
  r text;
BEGIN
  SELECT tenant_id, role INTO t, r FROM users WHERE id = uid;
  IF t IS NULL THEN
    RAISE EXCEPTION 'No signed-in user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF r <> 'owner' THEN
    RAISE EXCEPTION 'Only owners can add a business' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO businesses (id, tenant_id, name, ntn_cnic, province, address, activity, sector, environment,
                          default_sale_type, further_tax_rate, further_tax_rates, invoice_prefix, next_invoice_no)
  VALUES (b->>'id', t, b->>'name', b->>'ntnCnic', b->>'province', b->>'address', b->>'activity', b->>'sector',
          b->>'environment', b->>'defaultSaleType', (b->>'furtherTaxRate')::numeric, COALESCE(b->'furtherTaxRates', '[]'::jsonb),
          b->>'invoicePrefix', (b->>'nextInvoiceNo')::integer);
  INSERT INTO memberships (user_id, business_id, role) VALUES (uid, b->>'id', 'owner');
END $$;
