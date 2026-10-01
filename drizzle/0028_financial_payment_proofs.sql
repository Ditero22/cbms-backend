ALTER TABLE "payments" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_proof_attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD COLUMN "payment_notes" text;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD COLUMN "payment_request_key" uuid;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD COLUMN "payment_request_fingerprint" text;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD COLUMN "payment_proof_attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_proof_attachment_id_attachments_id_fk" FOREIGN KEY ("payment_proof_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_payment_proof_attachment_id_attachments_id_fk" FOREIGN KEY ("payment_proof_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_entries_payment_request_key_unique" ON "payroll_entries" USING btree ("payment_request_key");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_request_fingerprint_valid" CHECK ("payments"."request_fingerprint" is null or "payments"."request_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_payment_request_identity_valid" CHECK (("payroll_entries"."payment_request_key" is null and "payroll_entries"."payment_request_fingerprint" is null)
      or ("payroll_entries"."payment_request_key" is not null and "payroll_entries"."payment_request_fingerprint" is not null and "payroll_entries"."payment_request_fingerprint" ~ '^[0-9a-f]{64}$'));