-- The API role cannot insert businesses or memberships directly. This function
-- adds a business to the signed-in user's tenant and makes them its owner, in
-- one step, and only for users whose tenant role is owner.
CREATE FUNCTION create_business(b jsonb) RETURNS void
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
                          default_sale_type, further_tax_rate, invoice_prefix, next_invoice_no)
  VALUES (b->>'id', t, b->>'name', b->>'ntnCnic', b->>'province', b->>'address', b->>'activity', b->>'sector',
          b->>'environment', b->>'defaultSaleType', (b->>'furtherTaxRate')::numeric, b->>'invoicePrefix',
          (b->>'nextInvoiceNo')::integer);
  INSERT INTO memberships (user_id, business_id, role) VALUES (uid, b->>'id', 'owner');
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION create_business(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_business(jsonb) TO rasid_app;
