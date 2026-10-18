CREATE TABLE "hs_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ref_lists" (
	"kind" text NOT NULL,
	"params" text DEFAULT '' NOT NULL,
	"as_of" text DEFAULT '' NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ref_lists_kind_params_as_of_pk" PRIMARY KEY("kind","params","as_of")
);
--> statement-breakpoint
CREATE TABLE "reference_credential" (
	"id" text PRIMARY KEY DEFAULT 'pral' NOT NULL,
	"key_version" text NOT NULL,
	"ciphertext" text NOT NULL,
	"hint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_credential_single" CHECK ("reference_credential"."id" = 'pral')
);
--> statement-breakpoint

-- Reference data is the same for every tenant, so these tables have no RLS. The worker
-- (nightly refresh) and the API (read-through lookups) write them as rasid_app.
GRANT SELECT, INSERT, UPDATE, DELETE ON ref_lists, hs_codes TO rasid_app;
--> statement-breakpoint
-- Only the owner (reference-cli set-token) writes the platform token; the app reads the ciphertext.
GRANT SELECT ON reference_credential TO rasid_app;
