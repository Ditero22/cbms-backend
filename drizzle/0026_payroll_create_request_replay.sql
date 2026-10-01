ALTER TABLE "payroll_runs" ADD COLUMN "request_key" uuid;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "request_user_id" uuid;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_request_user_id_users_id_fk" FOREIGN KEY ("request_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_request_key_unique" ON "payroll_runs" USING btree ("request_key");--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_request_identity_valid" CHECK (("payroll_runs"."request_key" is null and "payroll_runs"."request_user_id" is null and "payroll_runs"."request_fingerprint" is null)
      or ("payroll_runs"."request_key" is not null and "payroll_runs"."request_user_id" is not null and "payroll_runs"."request_fingerprint" ~ '^[0-9a-f]{64}$'));