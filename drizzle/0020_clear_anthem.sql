CREATE TABLE "payroll_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"employee_number" text NOT NULL,
	"employee_name" text NOT NULL,
	"position" text NOT NULL,
	"pay_basis" text NOT NULL,
	"units" numeric(12, 3) NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"regular_pay" numeric(14, 2) NOT NULL,
	"additional_pay" numeric(14, 2) DEFAULT '0' NOT NULL,
	"deductions" numeric(14, 2) DEFAULT '0' NOT NULL,
	"gross_pay" numeric(14, 2) NOT NULL,
	"net_pay" numeric(14, 2) NOT NULL,
	"payment_status" text DEFAULT 'Pending' NOT NULL,
	"payment_date" date,
	"payment_method" text,
	"payment_reference" text,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"confirmed_by" uuid,
	"acknowledgement" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_entries_basis_valid" CHECK ("payroll_entries"."pay_basis" in ('Salary', 'Daily wage', 'Weekly wage', 'Per-trip pay', 'Other')),
	CONSTRAINT "payroll_entries_units_valid" CHECK ("payroll_entries"."units" > 0),
	CONSTRAINT "payroll_entries_rate_valid" CHECK ("payroll_entries"."rate" > 0),
	CONSTRAINT "payroll_entries_totals_valid" CHECK ("payroll_entries"."regular_pay" >= 0 and "payroll_entries"."additional_pay" >= 0 and "payroll_entries"."deductions" >= 0 and "payroll_entries"."gross_pay" = "payroll_entries"."regular_pay" + "payroll_entries"."additional_pay" and "payroll_entries"."net_pay" = "payroll_entries"."gross_pay" - "payroll_entries"."deductions" and "payroll_entries"."net_pay" >= 0),
	CONSTRAINT "payroll_entries_payment_status_valid" CHECK ("payroll_entries"."payment_status" in ('Pending', 'Paid', 'Received')),
	CONSTRAINT "payroll_entries_payment_fields_valid" CHECK (("payroll_entries"."payment_status" = 'Pending' and "payroll_entries"."payment_date" is null and "payroll_entries"."payment_method" is null and "payroll_entries"."paid_by" is null and "payroll_entries"."paid_at" is null and "payroll_entries"."received_at" is null and "payroll_entries"."confirmed_by" is null) or ("payroll_entries"."payment_status" = 'Paid' and "payroll_entries"."payment_date" is not null and "payroll_entries"."payment_method" is not null and "payroll_entries"."paid_by" is not null and "payroll_entries"."paid_at" is not null and "payroll_entries"."received_at" is null and "payroll_entries"."confirmed_by" is null) or ("payroll_entries"."payment_status" = 'Received' and "payroll_entries"."payment_date" is not null and "payroll_entries"."payment_method" is not null and "payroll_entries"."paid_by" is not null and "payroll_entries"."paid_at" is not null and "payroll_entries"."received_at" is not null and "payroll_entries"."confirmed_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "payroll_entry_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_entry_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_entry_adjustments_amount_valid" CHECK ("payroll_entry_adjustments"."amount" > 0),
	CONSTRAINT "payroll_entry_adjustments_type_valid" CHECK (("payroll_entry_adjustments"."kind" = 'earning' and "payroll_entry_adjustments"."type" in ('Overtime', 'Bonus', 'Allowance', 'Reimbursement', 'Other compensation')) or ("payroll_entry_adjustments"."kind" = 'deduction' and "payroll_entry_adjustments"."type" in ('Deduction', 'Cash advance recovery')))
);
--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entry_adjustments" ADD CONSTRAINT "payroll_entry_adjustments_payroll_entry_id_payroll_entries_id_fk" FOREIGN KEY ("payroll_entry_id") REFERENCES "public"."payroll_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_entries_run_employee_unique" ON "payroll_entries" USING btree ("payroll_run_id","employee_id");--> statement-breakpoint
CREATE INDEX "payroll_entries_branch_created_idx" ON "payroll_entries" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "payroll_entries_run_name_idx" ON "payroll_entries" USING btree ("payroll_run_id","employee_name");--> statement-breakpoint
CREATE INDEX "payroll_entry_adjustments_entry_idx" ON "payroll_entry_adjustments" USING btree ("payroll_entry_id","created_at");
--> statement-breakpoint
INSERT INTO permissions (key, description) VALUES
	('payroll.update', 'Edit draft payroll runs.'),
	('payroll.process', 'Process and lock draft payroll runs.'),
	('payroll.pay', 'Record employee payroll payments and attach payment proof.'),
	('payroll.receive', 'Confirm employee payroll receipt and attach receipt proof.')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission_key)
SELECT roles.id, permissions.key
FROM roles CROSS JOIN permissions
WHERE roles.name = 'Administrator' AND roles.is_system = 1
  AND permissions.key IN ('payroll.update', 'payroll.process', 'payroll.pay', 'payroll.receive')
ON CONFLICT DO NOTHING;
