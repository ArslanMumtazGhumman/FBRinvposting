CREATE TABLE "sale_types" (
	"name" text PRIMARY KEY NOT NULL,
	"scenario_id" text NOT NULL,
	"uses_retail_price" boolean DEFAULT false NOT NULL,
	"exempt" boolean DEFAULT false NOT NULL,
	"trans_type_id" integer,
	"pral_desc" text,
	"needs_review" boolean DEFAULT true NOT NULL,
	"review_note" text DEFAULT '' NOT NULL,
	"checked_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_types_scenario" CHECK ("sale_types"."scenario_id" ~ '^SN0[0-2][0-9]$'),
	CONSTRAINT "sale_types_mapped_or_review" CHECK ("sale_types"."trans_type_id" is not null or "sale_types"."needs_review")
);

--> statement-breakpoint

-- Seed: src/lib/sale-types.ts (a test checks they match). trans_type_id is filled from PRAL's
-- transtypecode by the first refresh; until then every row needs review and keeps bundled rates.
INSERT INTO sale_types (name, scenario_id, uses_retail_price, exempt, review_note) VALUES
  ('Goods at standard rate (default)', 'SN001', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Goods at Reduced Rate', 'SN005', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Exempt Goods', 'SN006', false, true, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Goods at zero-rate', 'SN007', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('3rd Schedule Goods', 'SN008', true, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Steel Melting and re-rolling', 'SN003', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Ship breaking', 'SN004', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Cotton Ginners', 'SN009', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Telecommunication services', 'SN010', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Toll Manufacturing', 'SN011', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Petroleum Products', 'SN012', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Electricity Supply to Retailers', 'SN013', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Gas to CNG stations', 'SN014', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Mobile Phones', 'SN015', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Processing/ Conversion of Goods', 'SN016', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Goods (FED in ST Mode)', 'SN017', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Services (FED in ST Mode)', 'SN018', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Services', 'SN019', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Electric Vehicle', 'SN020', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Cement /Concrete Block', 'SN021', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Potassium Chlorate', 'SN022', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('CNG Sales', 'SN023', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Goods as per SRO.297(|)/2023', 'SN024', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.'),
  ('Non-Adjustable Supplies', 'SN025', false, false, 'Not matched yet: waits for PRAL’s transtypecode list.');
--> statement-breakpoint
-- Shared by every tenant, no RLS. The API role (worker refresh, read-through lookups) reads the table
-- and records the automatic match; confirming a mapping (confirmed_at) is for the owner (reference-cli).
GRANT SELECT ON sale_types TO rasid_app;
--> statement-breakpoint
GRANT UPDATE (trans_type_id, pral_desc, needs_review, review_note, checked_at, updated_at) ON sale_types TO rasid_app;
