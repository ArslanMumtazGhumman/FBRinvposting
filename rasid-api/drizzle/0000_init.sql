CREATE TABLE "api_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"invoice_id" text,
	"env" text NOT NULL,
	"endpoint" text NOT NULL,
	"idempotency_key" text,
	"outcome" text NOT NULL,
	"http_status" integer,
	"fbr_invoice_number" text,
	"error_code" text,
	"error_message" text,
	"response" jsonb,
	"payload_hash" text NOT NULL,
	"attempts" integer NOT NULL,
	"latency_ms" integer,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"business_id" text,
	"ip" text,
	"detail" text,
	"payload_hash" text,
	"attempts" integer,
	"latency_ms" integer,
	"env" text,
	"prev" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"ntn_cnic" text NOT NULL,
	"province" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"activity" text NOT NULL,
	"sector" text NOT NULL,
	"environment" text DEFAULT 'sandbox' NOT NULL,
	"default_sale_type" text DEFAULT 'Goods at standard rate (default)' NOT NULL,
	"further_tax_rate" numeric DEFAULT 4 NOT NULL,
	"invoice_prefix" text DEFAULT 'INV-' NOT NULL,
	"next_invoice_no" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"ntn_cnic" text NOT NULL,
	"name" text NOT NULL,
	"province" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"registration_type" text NOT NULL,
	"phone" text,
	"email" text,
	"active_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fbr_credentials" (
	"business_id" text NOT NULL,
	"env" text NOT NULL,
	"key_version" text NOT NULL,
	"ciphertext" text NOT NULL,
	"hint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"last_ok_at" timestamp with time zone,
	CONSTRAINT "fbr_credentials_business_id_env_pk" PRIMARY KEY("business_id","env")
);
--> statement-breakpoint
CREATE TABLE "import_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"name" text NOT NULL,
	"signature" text NOT NULL,
	"map" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"invoice_id" text NOT NULL,
	"business_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"hs_code" text NOT NULL,
	"product_description" text NOT NULL,
	"rate" text NOT NULL,
	"uom" text NOT NULL,
	"quantity" numeric DEFAULT 0 NOT NULL,
	"unit_price" numeric DEFAULT 0 NOT NULL,
	"total_values" numeric DEFAULT 0 NOT NULL,
	"value_sales_excluding_st" numeric DEFAULT 0 NOT NULL,
	"fixed_notified_value_or_retail_price" numeric DEFAULT 0 NOT NULL,
	"sales_tax_applicable" numeric DEFAULT 0 NOT NULL,
	"sales_tax_withheld_at_source" numeric DEFAULT 0 NOT NULL,
	"extra_tax" numeric DEFAULT 0 NOT NULL,
	"further_tax" numeric DEFAULT 0 NOT NULL,
	"sro_schedule_no" text DEFAULT '' NOT NULL,
	"fed_payable" numeric DEFAULT 0 NOT NULL,
	"discount" numeric DEFAULT 0 NOT NULL,
	"sale_type" text NOT NULL,
	"sro_item_serial_no" text DEFAULT '' NOT NULL,
	CONSTRAINT "invoice_items_invoice_id_line_no_pk" PRIMARY KEY("invoice_id","line_no")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"local_ref" text NOT NULL,
	"invoice_type" text NOT NULL,
	"invoice_date" date NOT NULL,
	"buyer" jsonb NOT NULL,
	"invoice_ref_no" text DEFAULT '' NOT NULL,
	"scenario_id" text,
	"environment" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fbr_invoice_number" text,
	"fbr_item_numbers" jsonb,
	"fbr_dated" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"batch_id" text,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	CONSTRAINT "invoices_id_business_key" UNIQUE("id","business_id"),
	CONSTRAINT "invoices_debit_note_ref" CHECK ("invoices"."invoice_type" <> 'Debit Note' or "invoices"."invoice_ref_no" <> ''),
	CONSTRAINT "invoices_posted_has_irn" CHECK ("invoices"."status" <> 'posted' or "invoices"."fbr_invoice_number" is not null)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" text NOT NULL,
	"business_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_business_id_pk" PRIMARY KEY("user_id","business_id")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"name" text NOT NULL,
	"hs_code" text NOT NULL,
	"uom" text NOT NULL,
	"sale_type" text NOT NULL,
	"rate" text NOT NULL,
	"unit_price" numeric DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" text,
	"fails" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fbr_credentials" ADD CONSTRAINT "fbr_credentials_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fbr_credentials" ADD CONSTRAINT "fbr_credentials_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_fk" FOREIGN KEY ("invoice_id","business_id") REFERENCES "public"."invoices"("id","business_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_calls_idempotency_key" ON "api_calls" USING btree ("business_id","env","idempotency_key") WHERE "api_calls"."endpoint" = 'post' and "api_calls"."outcome" = 'ok' and "api_calls"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "api_calls_business_created_idx" ON "api_calls" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "api_calls_invoice_idx" ON "api_calls" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_hash_key" ON "audit_log" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "audit_log_business_idx" ON "audit_log" USING btree ("business_id","id");--> statement-breakpoint
CREATE INDEX "businesses_tenant_idx" ON "businesses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "customers_business_idx" ON "customers" USING btree ("business_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "import_mappings_business_signature_key" ON "import_mappings" USING btree ("business_id","signature");--> statement-breakpoint
CREATE INDEX "invoice_items_business_idx" ON "invoice_items" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_business_local_ref_key" ON "invoices" USING btree ("business_id","local_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_irn_key" ON "invoices" USING btree ("fbr_invoice_number") WHERE "invoices"."fbr_invoice_number" is not null;--> statement-breakpoint
CREATE INDEX "invoices_business_created_idx" ON "invoices" USING btree ("business_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invoices_business_status_idx" ON "invoices" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "invoices_business_date_idx" ON "invoices" USING btree ("business_id","invoice_date");--> statement-breakpoint
CREATE INDEX "memberships_business_idx" ON "memberships" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "products_business_idx" ON "products" USING btree ("business_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");