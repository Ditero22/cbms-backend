ALTER TABLE employees ADD COLUMN is_driver integer NOT NULL DEFAULT 0,
 ADD COLUMN license_number text, ADD COLUMN license_classification text,
 ADD COLUMN license_expires_on text, ADD COLUMN driver_availability text NOT NULL DEFAULT 'Available',
 ADD COLUMN emergency_contact_name text, ADD COLUMN emergency_contact_phone text, ADD COLUMN notes text;
ALTER TABLE employees ADD CONSTRAINT employees_is_driver_valid CHECK (is_driver IN (0,1)),
 ADD CONSTRAINT employees_driver_availability_valid CHECK (driver_availability IN ('Available','Unavailable'));
--> statement-breakpoint
ALTER TABLE vehicles ADD COLUMN brand text, ADD COLUMN model text, ADD COLUMN year integer,
 ADD COLUMN color text, ADD COLUMN fuel_type text, ADD COLUMN odometer numeric(14,3),
 ADD COLUMN capacity_value numeric(14,3), ADD COLUMN capacity_unit text,
 ADD COLUMN default_driver_id uuid REFERENCES employees(id), ADD COLUMN registration_expires_on text,
 ADD COLUMN insurance_provider text, ADD COLUMN insurance_reference text, ADD COLUMN insurance_expires_on text,
 ADD COLUMN notes text, ADD COLUMN manual_status text;
UPDATE vehicles SET manual_status='Unavailable' WHERE status='Unavailable';
ALTER TABLE vehicles ADD CONSTRAINT vehicles_capacity_valid CHECK ((capacity_value IS NULL AND capacity_unit IS NULL) OR (capacity_value > 0 AND length(trim(capacity_unit)) > 0)),
 ADD CONSTRAINT vehicles_odometer_valid CHECK (odometer IS NULL OR odometer >= 0);
ALTER TABLE vehicles ADD CONSTRAINT vehicles_manual_status_valid CHECK (manual_status IS NULL OR manual_status IN ('Unavailable','Under Maintenance'));
ALTER TABLE vehicles ADD CONSTRAINT vehicles_dates_valid CHECK ((registration_expires_on IS NULL OR registration_expires_on ~ '^\d{4}-\d{2}-\d{2}$' AND registration_expires_on::date::text=registration_expires_on) AND (insurance_expires_on IS NULL OR insurance_expires_on ~ '^\d{4}-\d{2}-\d{2}$' AND insurance_expires_on::date::text=insurance_expires_on));
ALTER TABLE employees ADD CONSTRAINT employees_license_date_valid CHECK (license_expires_on IS NULL OR license_expires_on ~ '^\d{4}-\d{2}-\d{2}$' AND license_expires_on::date::text=license_expires_on);
--> statement-breakpoint
CREATE TABLE vehicle_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text NOT NULL UNIQUE,
 vehicle_id uuid NOT NULL REFERENCES vehicles(id), driver_id uuid NOT NULL REFERENCES employees(id),
 branch_id uuid NOT NULL REFERENCES branches(id), delivery_id uuid REFERENCES deliveries(id),
 destination text NOT NULL, purpose text NOT NULL, scheduled_at timestamptz, started_at timestamptz,
 ended_at timestamptz, start_odometer numeric(14,3), end_odometer numeric(14,3),
 status text NOT NULL DEFAULT 'Scheduled', notes text, created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT vehicle_assignments_status_valid CHECK (status IN ('Scheduled','Active','Completed','Cancelled')),
 CONSTRAINT vehicle_assignments_odometer_valid CHECK ((start_odometer IS NULL OR start_odometer >= 0) AND (end_odometer IS NULL OR end_odometer >= coalesce(start_odometer,0)))
);
CREATE UNIQUE INDEX vehicle_assignments_live_vehicle_unique ON vehicle_assignments(vehicle_id) WHERE status IN ('Scheduled','Active');
CREATE UNIQUE INDEX vehicle_assignments_live_driver_unique ON vehicle_assignments(driver_id) WHERE status IN ('Scheduled','Active');
CREATE UNIQUE INDEX vehicle_assignments_live_delivery_unique ON vehicle_assignments(delivery_id) WHERE status IN ('Scheduled','Active');
CREATE INDEX vehicle_assignments_branch_created_idx ON vehicle_assignments(branch_id,created_at);
--> statement-breakpoint
CREATE TABLE vehicle_maintenance (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text NOT NULL UNIQUE,
 vehicle_id uuid NOT NULL REFERENCES vehicles(id), branch_id uuid NOT NULL REFERENCES branches(id),
 maintenance_type text NOT NULL, description text NOT NULL, problem_reported text,
 started_on text, completed_on text, service_provider text, contact_person text,
 labor_cost numeric(14,2) NOT NULL DEFAULT 0, parts_cost numeric(14,2) NOT NULL DEFAULT 0,
 other_cost numeric(14,2) NOT NULL DEFAULT 0, receipt_reference text, notes text,
 status text NOT NULL DEFAULT 'Scheduled', expense_id uuid UNIQUE REFERENCES expenses(id),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT vehicle_maintenance_status_valid CHECK (status IN ('Scheduled','In Progress','Completed','Cancelled')),
 CONSTRAINT vehicle_maintenance_dates_valid CHECK ((started_on IS NULL OR started_on ~ '^\d{4}-\d{2}-\d{2}$' AND started_on::date::text=started_on) AND (completed_on IS NULL OR completed_on ~ '^\d{4}-\d{2}-\d{2}$' AND completed_on::date::text=completed_on) AND (completed_on IS NULL OR started_on IS NULL OR completed_on >= started_on)),
 CONSTRAINT vehicle_maintenance_cost_valid CHECK (labor_cost >= 0 AND parts_cost >= 0 AND other_cost >= 0 AND labor_cost+parts_cost+other_cost <= 999999999999.99)
);
CREATE INDEX vehicle_maintenance_vehicle_created_idx ON vehicle_maintenance(vehicle_id,created_at);
CREATE INDEX vehicle_maintenance_branch_created_idx ON vehicle_maintenance(branch_id,created_at);
--> statement-breakpoint
CREATE TABLE driver_allowances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text NOT NULL UNIQUE,
 worker_id uuid NOT NULL REFERENCES employees(id), branch_id uuid NOT NULL REFERENCES branches(id),
 assignment_id uuid REFERENCES vehicle_assignments(id), delivery_id uuid REFERENCES deliveries(id),
 payment_type text NOT NULL, amount numeric(14,2) NOT NULL, payment_timing text NOT NULL,
 method text NOT NULL, reference_number text, notes text, status text NOT NULL DEFAULT 'Pending',
 authorized_by uuid REFERENCES users(id), authorized_at timestamptz,
 released_by uuid REFERENCES users(id), released_at timestamptz,
 confirmed_by uuid REFERENCES users(id), received_at timestamptz, acknowledgement text,
 expense_id uuid UNIQUE REFERENCES expenses(id), created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT driver_allowances_amount_valid CHECK (amount > 0),
 CONSTRAINT driver_allowances_status_valid CHECK (status IN ('Pending','Approved','Released','Received','Cancelled'))
);
CREATE INDEX driver_allowances_branch_created_idx ON driver_allowances(branch_id,created_at);
--> statement-breakpoint
INSERT INTO permissions(key,description) VALUES
 ('vehicles.assign','Manage vehicle and driver assignments'),
 ('vehicles.maintenance','Manage vehicle maintenance and repairs'),
 ('driver-allowances.read','Read driver allowances and private proofs'),
 ('driver-allowances.create','Create driver allowances'),
 ('driver-allowances.update','Edit pending driver allowances'),
 ('driver-allowances.approve','Approve driver allowances'),
 ('driver-allowances.release','Record driver allowance release'),
 ('driver-allowances.receive','Confirm driver allowance receipt'),
 ('driver-allowances.cancel','Cancel unreleased driver allowances')
 ON CONFLICT(key) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_key)
 SELECT r.id,p.key FROM roles r CROSS JOIN permissions p
 WHERE r.name='Administrator' AND r.is_system=1 AND p.key IN (
 'vehicles.assign','vehicles.maintenance','driver-allowances.read','driver-allowances.create',
 'driver-allowances.update','driver-allowances.approve','driver-allowances.release','driver-allowances.receive','driver-allowances.cancel')
 ON CONFLICT DO NOTHING;
