# CBMS Backend Architecture & Technology Stack

## Local schema compatibility and startup — 2026-10-02

The local dashboard incident was reproduced as authenticated `GET /api/v1/dashboard/summary` returning 500 while login, CORS, liveness and the old readiness probe succeeded. The database had 24 migrations and was missing customer/vehicle branch columns required by the current API. A validated custom-format backup and isolated restore rehearsal preceded application of existing migrations 0024–0027. A later startup check caught pending migrations 0028–0029; after another verified backup/restore rehearsal, all **30 migrations (0000–0029)** are now applied locally. The API starts and health/readiness return 200. Migration 0029 assigned unique ledger sequences to 32 existing local rows; no reset/seed occurred. Earlier “persistent database untouched” notes refer to previous checkpoints.

`src/database/readiness.ts` now owns a read-only check of packaged migrations and the applied PostgreSQL journal. `server.ts` calls it before listening; `/api/ready` calls the same check. Missing/pending journal entries, unavailable PostgreSQL and missing packaged migration files return safe structured 503 errors. `/api/health` stays database-independent. Startup does not migrate implicitly, and migration commands still run as a reviewed deployment step from the backend package directory. Port conflicts and pool shutdown failures have sanitized guidance. The journal check detects unapplied migrations; it does not certify absence of manual schema drift or replace upgrade/restore testing.

Invalid report-option branch filters now return `400 VALIDATION_ERROR`, using the same safe-parse transport pattern as other report routes. The unreachable generic Expense schema entry and unused Inventory schema re-export were removed; dedicated domain validation and transport → service → repository boundaries remain intact. Active legacy delivery/allowance paths and all historical migrations remain.

HTTP diagnostics use shared allowlist serializers. Logs retain request ID, method, pathname, response status and safe application-error classification; query values, cookies, credentials, bodies, arbitrary exception text/stacks and SQL details are excluded. Idle PostgreSQL pool errors use the same safe classification. Tests cover the registered pool handler, application error handler and HTTP logger's automatic 5xx error path.

Current checks as of 2026-10-02: backend build/lint/format, **109/109 unit cases across 30 files**, and **190/190 PostgreSQL cases across 23 integration files** pass. HTTP integration coverage verifies delivery options, foreign-branch delivery creation/status denial, unassigned-branch behavior, branch-limited sales CSV exports despite forged filters, and Manager payroll branch scope through proof-backed payment and authorized proof preview. An actual API startup against an isolated restore of the old schema exits 1 without listening; the live upgraded API passes readiness. Production/staging upgrades, private-provider recovery, and full system role acceptance remain unverified. See [the incident audit](../CONNECTIVITY_ARCHITECTURE_AUDIT.md).

## Implemented Payroll Model (2026-10-01)

Regular employee compensation is represented by `payroll_runs`, `payroll_entries`, and `payroll_entry_adjustments`. A run snapshots its period/branch; each entry snapshots employee identity and pay basis, units, rate, regular pay, additions, deductions, gross, and net. Adjustment types are constrained and additions remain separate from regular pay. The database checks the total relationships, while the service computes exact cents and fractional units.

The supported lifecycle is Draft → Processed → Paid → Received at the entry level. Processing freezes a nonempty run; payment records the actual date/method/reference and actor; employee receipt records date/time, confirmer, acknowledgement, and may include private proof. Payroll action grants are independently enforced in the service, API, branch scope, and attachment authorization. Migration `0020_clear_anthem.sql` adds the model and grants without rewriting existing pay-run headers or driver allowances.

Driver allowances continue to model additional trip/meal/fuel allowances, cash advances, and reimbursements. They are not normal salary. Pay configuration on employee records, statutory calculations, payroll approval/accounting policy, exports, and external disbursement are not implemented because the business rules are not yet established.

**Product requirement update (2026-10-01):** Drivers are employees/workers and regular driver pay belongs in Payroll. The separate Driver Allowance page/workflow is slated for retirement. Do not convert historical allowance amounts or linked expense/proof records into payroll without an approved mapping. The configured local development database currently has zero allowance rows, but production data is unknown; preserve the existing record and closeout path until a safe legacy archive/settlement plan is approved and implemented. This paragraph records current code plus the pending product change, not a claim that the page has already been removed.

## 1. Overview

The Construction Business Management System (CBMS) backend will be responsible for all business logic, authentication, authorization, database operations, file handling, auditing, reporting, and communication between the frontend and backend services.

The backend should be designed for:

- Maintainability
- Security
- Scalability
- Clear separation of business modules
- Multi-branch operations
- Reliable financial and inventory transactions
- Easy testing
- Future expansion

The backend will initially be built as a **Modular Monolith using Vertical Slice Architecture concepts**.

Microservices will not be used during the initial development of CBMS.

---

# 2. Backend Technology Stack

## Runtime

**Node.js**

Node.js will run the backend application and provide the JavaScript/TypeScript runtime.

Recommended:

```text
Node.js LTS
```

---

## Programming Language

**TypeScript**

TypeScript will be used instead of plain JavaScript.

Benefits:

- Static typing
- Better IDE support
- Safer refactoring
- Fewer runtime errors
- Easier maintenance
- Better developer experience

---

# 3. Backend Framework

## Express.js

Express will be used as the HTTP backend framework.

Responsibilities include:

- REST API routes
- Middleware
- Authentication
- Request validation
- Error handling
- Rate limiting
- API responses

Example request flow:

```text
Frontend
   │
   ▼
Express Route
   │
   ▼
Authentication Middleware
   │
   ▼
Authorization Middleware
   │
   ▼
Validation
   │
   ▼
Controller / Handler
   │
   ▼
Service / Business Logic
   │
   ▼
Repository / Database
```

---

# 4. API Architecture

CBMS will use a:

# REST API

Example endpoints:

```text
/api/auth
/api/users
/api/branches
/api/employees
/api/customers
/api/products
/api/inventory
/api/orders
/api/deliveries
/api/vehicles
/api/payroll
/api/expenses
/api/reports
/api/audit-logs
```

Example:

```http
GET /api/products
POST /api/products
GET /api/products/:id
PATCH /api/products/:id
DELETE /api/products/:id
```

---

# 5. Backend Architecture

CBMS will use a:

# Modular Monolith

The backend remains one application but is separated into independent business modules.

Example:

```text
backend/
│
├── src/
│   │
│   ├── modules/
│   │   │
│   │   ├── auth/
│   │   ├── users/
│   │   ├── roles/
│   │   ├── branches/
│   │   ├── employees/
│   │   ├── customers/
│   │   ├── suppliers/
│   │   ├── products/
│   │   ├── inventory/
│   │   ├── orders/
│   │   ├── deliveries/
│   │   ├── vehicles/
│   │   ├── payroll/
│   │   ├── expenses/
│   │   ├── reports/
│   │   └── audit/
│   │
│   ├── middleware/
│   ├── database/
│   ├── config/
│   ├── shared/
│   ├── utils/
│   ├── app.ts
│   └── server.ts
│
├── tests/
├── drizzle/
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

# 6. Vertical Slice Architecture

Each feature should contain the code it needs instead of organizing the entire application only by technical layer.

Example:

```text
modules/
└── inventory/
    │
    ├── inventory.routes.ts
    ├── inventory.controller.ts
    ├── inventory.service.ts
    ├── inventory.repository.ts
    ├── inventory.schema.ts
    ├── inventory.types.ts
    └── inventory.permissions.ts
```

Another module:

```text
modules/
└── payroll/
    │
    ├── payroll.routes.ts
    ├── payroll.controller.ts
    ├── payroll.service.ts
    ├── payroll.repository.ts
    ├── payroll.schema.ts
    └── payroll.types.ts
```

This keeps related business functionality together.

---

# 7. Database

## PostgreSQL

PostgreSQL will be the primary database.

It is well suited to CBMS because the system contains strongly related business data.

Examples:

```text
Users
   ↓
Branches

Employees
   ↓
Payroll

Products
   ↓
Inventory
   ↓
Branches

Orders
   ↓
Customers
   ↓
Payments
   ↓
Deliveries
```

PostgreSQL provides:

- Foreign keys
- Transactions
- Constraints
- Indexing
- Relational queries
- Aggregations
- Strong consistency
- Advanced reporting capabilities

---

# 8. ORM

## Drizzle ORM

Drizzle will be used to communicate with PostgreSQL.

Responsibilities:

- Table definitions
- Database queries
- Relationships
- Migrations
- Transaction handling

Example conceptual table:

```text
users
----------------
id
first_name
last_name
email
password_hash
role_id
branch_id
status
created_at
updated_at
```

---

# 9. Database Migration Management

Database schema changes must always use migrations.

Do not manually modify the production database.

Example workflow:

```text
Modify Drizzle schema
        ↓
Generate migration
        ↓
Review migration
        ↓
Apply migration
        ↓
Deploy
```

Migrations must be committed to Git.

---

# 10. Authentication

Authentication will be handled by the backend.

Possible login identifiers:

```text
Email
Username
```

Passwords must never be stored directly.

Passwords should be hashed using a secure password hashing algorithm such as:

```text
Argon2
```

or an equivalent secure implementation.

---

# 11. Authentication Flow

Example:

```text
User submits credentials
        │
        ▼
Backend validates request
        │
        ▼
Find user
        │
        ▼
Verify password
        │
        ▼
Check account status
        │
        ▼
Create authenticated session/token
        │
        ▼
Return authenticated user information
```

---

# 12. Authorization

Authentication answers:

```text
Who are you?
```

Authorization answers:

```text
What are you allowed to do?
```

CBMS will use:

# Role-Based Access Control — RBAC

Example roles may include:

```text
Owner
Administrator
Branch Manager
Inventory Staff
Sales Staff
Accounting Staff
HR / Payroll Staff
Delivery Staff
Viewer
```

---

# 13. Permission-Based Authorization

Roles alone should not control everything.

Individual permissions should also exist.

Example permissions:

```text
users.read
users.create
users.update
users.delete

inventory.read
inventory.create
inventory.adjust
inventory.transfer

sales.read
sales.create
sales.update
sales.cancel

payroll.read
payroll.process

reports.view
reports.export
```

Roles can contain multiple permissions.

Example:

```text
Branch Manager
│
├── inventory.read
├── inventory.adjust
├── sales.read
├── sales.create
├── deliveries.read
└── reports.view
```

---

# 14. Branch-Level Authorization

CBMS is a multi-branch system.

Permissions must therefore consider both:

```text
Role / Permission

AND

Branch
```

Example:

```text
Employee:
Branch 2
```

The backend must prevent that employee from accessing:

```text
Branch 1 inventory
Branch 1 employees
Branch 1 orders
Branch 1 expenses
```

unless their role explicitly has cross-branch permission.

---

# 15. Never Trust the Frontend

Frontend restrictions are not security.

For example, hiding an Admin button does not prevent someone from manually calling:

```http
DELETE /api/users/100
```

The backend must validate every protected request.

Example:

```text
Request
   ↓
Authentication
   ↓
Permission Check
   ↓
Branch Access Check
   ↓
Business Rules
   ↓
Database Operation
```

---

# 16. Request Validation

## Zod

Zod will validate API request data.

Validate:

```text
Request body
URL parameters
Query parameters
Environment variables
```

Example:

```text
POST /api/products
```

Backend must validate:

```text
name
category
unit
price
supplier
status
```

Never trust incoming request data.

---

# 17. Error Handling

CBMS should use centralized error handling.

Example structure:

```json
{
  "success": false,
  "error": {
    "code": "PRODUCT_NOT_FOUND",
    "message": "The requested product could not be found."
  }
}
```

Production errors must not expose:

- Stack traces
- SQL queries
- Database credentials
- Environment variables
- Internal server paths

---

# 18. Logging

The backend should use structured logging.

Logs may include:

```text
Timestamp
Request ID
Endpoint
HTTP method
Status
Processing duration
User ID
Branch ID
Error type
```

Sensitive values must never be logged.

Never log:

```text
Passwords
Access tokens
Refresh tokens
Session IDs
Secret keys
Database passwords
```

---

# 19. Audit Logging

CBMS should maintain business audit logs.

Examples:

```text
User created employee
User changed product price
User adjusted inventory
User transferred inventory
User cancelled order
User modified payroll
User deleted record
User changed permissions
```

Example audit record:

```text
audit_logs
-----------------------
id
user_id
branch_id
action
entity_type
entity_id
old_value
new_value
ip_address
created_at
```

Audit records should generally be append-only.

---

# 20. Inventory Transactions

Inventory must not simply overwrite stock quantities without recording why the stock changed.

Use inventory transactions.

Example:

```text
inventory_transactions
----------------------
id
product_id
branch_id
transaction_type
quantity
reference_type
reference_id
performed_by
created_at
```

Possible transaction types:

```text
PURCHASE
SALE
TRANSFER_IN
TRANSFER_OUT
RETURN
DAMAGE
ADJUSTMENT
```

This provides an inventory history.

---

# 21. Database Transactions

Important business operations should use database transactions.

Example:

```text
Complete Order
      │
      ├── Create sale
      ├── Save order items
      ├── Reduce inventory
      ├── Record payment
      ├── Create delivery
      └── Create audit log
```

The operation should either:

```text
COMMIT EVERYTHING
```

or:

```text
ROLLBACK EVERYTHING
```

Partial business transactions should be avoided.

---

# 22. File Storage

Files should not normally be stored directly inside PostgreSQL.

Use:

# Cloudflare R2

Possible stored files:

```text
Employee documents
Receipts
Delivery proof
Invoices
Product images
Project documents
Profile images
Attachments
```

PostgreSQL stores file metadata.

Example:

```text
attachments
----------------
id
file_name
object_key
mime_type
file_size
uploaded_by
entity_type
entity_id
created_at
```

---

# 23. File Upload Security

The backend must validate uploads.

Check:

```text
Maximum file size
Allowed MIME type
File extension
Authorization
Upload ownership
Object key
```

Never trust the filename supplied by the browser.

Generate server-controlled object keys.

Example:

```text
cbms/
employees/
123/
documents/
generated-file-id.pdf
```

---

# 24. Rate Limiting

Rate limiting should protect sensitive routes.

Examples:

```text
/login
/password-reset
/file-upload
/search
/export
```

This helps protect against abuse and brute-force attacks.

---

# 25. Security Headers

Use secure HTTP headers.

Recommended middleware:

```text
Helmet
```

Security policies should include protections such as:

```text
Content security
Frame protection
MIME sniffing protection
Referrer policy
HTTPS enforcement in production
```

---

# 26. CORS

CORS must be explicitly configured.

Production should not blindly use:

```text
Access-Control-Allow-Origin: *
```

Allowed frontend domains should be specified through configuration.

---

# 27. Environment Variables

Secrets must be stored outside the codebase.

Example:

```env
NODE_ENV=
PORT=

DATABASE_URL=

SESSION_SECRET=
JWT_SECRET=

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=

FRONTEND_URL=
```

The real `.env` file must not be committed to Git.

Provide:

```text
.env.example
```

instead.

---

# 28. Configuration Validation

Environment variables should be validated when the application starts.

If critical configuration is missing, startup should fail instead of running with an invalid configuration.

---

# 29. API Versioning

The API should support versioning.

Example:

```text
/api/v1/auth
/api/v1/users
/api/v1/products
/api/v1/inventory
```

This makes future API changes easier to manage.

---

# 30. Pagination

Endpoints that return large amounts of data must support pagination.

Example:

```http
GET /api/v1/orders?page=1&limit=20
```

Avoid returning thousands of records at once.

---

# 31. Filtering

Business lists should support filtering.

Example:

```http
GET /api/v1/orders?branchId=2&status=completed
```

Other filters might include:

```text
Date range
Branch
Employee
Status
Category
Supplier
Customer
```

---

# 32. Sorting

Example:

```http
GET /api/v1/orders?sort=createdAt&order=desc
```

Sorting must only allow approved fields.

Do not directly inject user values into SQL sorting expressions.

---

# 33. Search

Search should be implemented through backend-controlled queries.

Search examples:

```text
Products
Customers
Employees
Orders
Suppliers
```

Indexes should be added when necessary.

---

# 34. Database Indexing

Indexes should be created for commonly searched or joined fields.

Examples:

```text
users.email
users.branch_id

employees.branch_id

products.sku
products.category_id

orders.customer_id
orders.branch_id
orders.created_at
orders.status

inventory.product_id
inventory.branch_id
```

Indexes should be based on actual application queries rather than added everywhere.

---

# 35. Soft Delete

Important business records should generally not be permanently deleted immediately.

Possible approach:

```text
deleted_at
deleted_by
```

or:

```text
status = archived
```

This is especially important for:

```text
Employees
Products
Orders
Payments
Payroll
Inventory
Financial records
```

---

# 36. Financial Data

Financial values should use decimal/numeric database types.

Do not use floating-point numbers for money.

Correct:

```text
DECIMAL
NUMERIC
```

Avoid:

```text
FLOAT
DOUBLE
```

for financial calculations.

---

# 37. Date and Time

Database timestamps should use a consistent timezone strategy.

Recommended:

```text
Store timestamps in UTC.
```

Convert them for display on the frontend when necessary.

---

# 38. Background Jobs

CBMS may eventually require jobs such as:

```text
Report generation
Email notifications
Data exports
Scheduled backups
Document processing
Inventory alerts
```

Initially, these can remain simple.

If the workload grows, a background worker and queue can be introduced.

Possible future addition:

```text
Redis
+
BullMQ
```

Do not introduce this until required.

---

# 39. Redis

Redis is NOT required for the first version.

It may later be introduced for:

```text
Caching
Rate limiting
Session storage
Queues
Background jobs
Distributed locks
```

---

# 40. Testing

The backend should have automated tests.

Recommended categories:

```text
Unit Tests
Integration Tests
API Tests
Authorization Tests
Database Tests
```

Important areas to test:

```text
Authentication
Permissions
Branch restrictions
Inventory adjustments
Stock transfer
Payments
Payroll
Database transactions
File authorization
```

---

# 41. Authorization Tests

Authorization must be tested independently.

Example:

```text
Branch 1 user
attempts
GET /api/v1/branches/2/inventory

Expected:

403 Forbidden
```

Never assume RBAC is correct just because the interface hides buttons.

---

# 42. Docker

The backend will use Docker.

Example:

```text
backend/
└── Dockerfile
```

Development may use:

```text
Docker Compose
```

Services:

```text
backend
postgres
```

Potential later services:

```text
redis
worker
```

---

# 43. Docker Development Structure

Example:

```text
docker-compose.yml

services:

  backend
     │
     └── Node.js / Express

  postgres
     │
     └── PostgreSQL

  redis
     │
     └── Optional later
```

Docker allows developers to run the same environment consistently.

---

# 44. Health Endpoint

The backend should expose a health endpoint.

Example:

```http
GET /api/health
```

Possible response:

```json
{
  "status": "healthy"
}
```

Production monitoring can use this endpoint.

---

# 45. Graceful Shutdown

The backend should handle shutdown signals correctly.

Example:

```text
SIGINT
SIGTERM
```

On shutdown:

```text
Stop accepting requests
Complete active requests
Close database connections
Close Redis connection if used
Stop workers
Exit process
```

---

# 46. Git Repository Rules

Never commit:

```text
.env
node_modules
database passwords
API keys
R2 credentials
production secrets
private certificates
```

Commit:

```text
.env.example
migration files
Dockerfile
docker-compose.yml
configuration templates
```

---

# 47. Backend Module Plan

Initial modules:

```text
Auth
Users
Roles
Permissions
Branches

Employees

Customers
Suppliers

Products
Categories

Inventory
Inventory Transfers
Inventory Adjustments

Orders
Order Items
Payments

Deliveries
Vehicles
Drivers

Expenses

Payroll

Reports

Files / Attachments

Notifications

Audit Logs
```

---

# 48. Recommended Folder Structure

```text
backend/
│
├── src/
│   │
│   ├── config/
│   │   ├── env.ts
│   │   ├── database.ts
│   │   └── storage.ts
│   │
│   ├── database/
│   │   ├── schema/
│   │   ├── migrations/
│   │   └── client.ts
│   │
│   ├── middleware/
│   │   ├── auth.middleware.ts
│   │   ├── permission.middleware.ts
│   │   ├── branch.middleware.ts
│   │   ├── validation.middleware.ts
│   │   ├── rate-limit.middleware.ts
│   │   └── error.middleware.ts
│   │
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── roles/
│   │   ├── permissions/
│   │   ├── branches/
│   │   ├── employees/
│   │   ├── customers/
│   │   ├── suppliers/
│   │   ├── products/
│   │   ├── inventory/
│   │   ├── orders/
│   │   ├── payments/
│   │   ├── deliveries/
│   │   ├── vehicles/
│   │   ├── expenses/
│   │   ├── payroll/
│   │   ├── reports/
│   │   ├── files/
│   │   └── audit/
│   │
│   ├── shared/
│   │   ├── errors/
│   │   ├── constants/
│   │   ├── types/
│   │   └── utilities/
│   │
│   ├── app.ts
│   └── server.ts
│
├── tests/
│
├── drizzle/
│
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── drizzle.config.ts
├── package.json
└── tsconfig.json
```

---

# 49. Backend Design Principles

The backend should follow these principles:

## Security First

Every request should be treated as untrusted.

---

## Backend Owns Business Rules

The frontend must not be responsible for enforcing critical business rules.

---

## Database Integrity

Use:

```text
Foreign keys
Constraints
Transactions
Unique constraints
Indexes
```

to protect the database.

---

## Least Privilege

Users should only have the permissions required for their job.

---

## Audit Important Actions

Important business changes should be traceable.

---

## Avoid Premature Complexity

Do not introduce:

```text
Microservices
Kubernetes
Redis
Message brokers
Complex event systems
```

unless they are actually required.

---

# 50. Final Backend Stack

The approved CBMS backend stack is:

```text
Runtime
Node.js

Language
TypeScript

Framework
Express.js

API
REST API

Validation
Zod

Database
PostgreSQL

ORM
Drizzle ORM

Authentication
Secure session/token-based authentication

Authorization
RBAC + Permission-Based Access Control

Branch Security
Branch-Level Authorization

Password Hashing
Argon2 or secure equivalent

Object Storage
Cloudflare R2

Security
Helmet
CORS
Rate Limiting
Input Validation

Architecture
Modular Monolith
+
Vertical Slice Architecture

Development Environment
Docker
Docker Compose

Testing
Unit + Integration + API + Authorization Tests
```

---

# 51. Technologies Not Required Initially

The following are intentionally excluded from Version 1 unless requirements change:

```text
Kubernetes
Microservices
GraphQL
Redis
Kafka
RabbitMQ
Elasticsearch
Multiple independent databases
```

These technologies may be introduced later if actual production requirements justify them.

---

# 52. Backend Goal

The goal is not to make the backend unnecessarily complicated.

The goal is to create a backend that is:

```text
Secure
Organized
Reliable
Easy to understand
Easy to test
Easy to maintain
Ready to grow
```

The architecture should allow CBMS to start as a manageable business application while still supporting future expansion.

---

# 53. Implemented Record Lifecycle APIs

The API includes dedicated Employee lifecycle endpoints and a shared lifecycle for Branches, Customers, Suppliers, and Products. Vehicles now use the dedicated fleet workflow APIs in Section 57 rather than the generic record lifecycle. These endpoints use fields present in the current schema.

Employee:

```text
GET    /api/v1/employees/:employeeId?historyPage=1
POST   /api/v1/employees
PATCH  /api/v1/employees/:employeeId
PATCH  /api/v1/employees/:employeeId/archive
```

Employee detail requires `employees.read`, applies the authenticated user's branch scope, and returns the stored employee, branch name, optional `hiredAt`, timestamps, and paginated real audit history. Create requires `employees.create`; edit/status/archive require `employees.update`. Create, update, and archive write their audit record in the same transaction as the business change.

Managed records:

```text
GET    /api/v1/{branches|customers|suppliers|products}/:recordId
PATCH  /api/v1/{branches|customers|suppliers|products}/:recordId
PATCH  /api/v1/{branches|customers|suppliers|products}/:recordId/archive
GET    /api/v1/products/options
```

Detail requires the module read permission. Edit and archive require the module update permission introduced by migration `0007_record_lifecycle.sql`. Detail returns flat camelCase stored fields, `status`, timestamps, permission-filtered `related` data, and up to 25 audit events when the actor has `audit.read`. Product detail also resolves `supplierName`; Product options returns active suppliers for create/edit forms.

Archive is soft deletion. The service returns `RECORD_IN_USE` when active references, stock, or open work would make an archive unsafe. Branch reads and writes honor branch assignment for non-cross-branch users. Invalid supplier and other foreign-key choices return a 4xx response. Audit entity history uses the composite index added by `0008_audit_entity_history_index.sql`.

The isolated PostgreSQL suite is run with `npm run test:integration` when `TEST_DATABASE_URL` points to `cbms_test` or `cbms_integration_*`. For a configured local development database, `npm run test:integration:local` creates a randomly named disposable database, migrates it, runs the suite, and removes it afterward.

# 54. Order Detail Read API

```http
GET /api/v1/orders/:orderId
```

The endpoint requires `sales.read`, validates the order UUID, and applies the authenticated user's assigned branch scope. It returns the order header, priced item lines with delivery/return/cancellation progress, payment and refund records, delivery and return records, associated inventory ledger movements, lifecycle eligibility, and exact-cent `paidAmount` and `balance` values. The caller only receives order audit history when also granted `audit.read`; otherwise `history` is an empty array. A missing or out-of-scope order returns the same not-found response.

This endpoint returns current lifecycle progress and is paired with the workflow APIs below. New orders reserve stock at placement; delivery quantities are assigned to order lines; completion, cancellation, refunds, and returns use dedicated service transitions and immutable financial, stock, ledger, and audit records.

# 55. Order, Payment, Delivery, Refund, and Return Workflows

Order lifecycle endpoints:

```http
GET   /api/v1/orders/:orderId/lifecycle
POST  /api/v1/orders/:orderId/complete
POST  /api/v1/orders/:orderId/cancel
```

The lifecycle read returns current eligibility and item-level ordered, delivered, returned, cancelled, and cancellable quantities. Completion requires all quantities to be delivered or cancelled, no unresolved delivery/return/refund, resolved reservations, and payment in full. Cancellation accepts a reason and line quantities. Undelivered reservations are released; delivered quantities must be returned before cancellation; any net payment on cancelled quantities must be refunded first. Existing pre-reservation orders use the migration-assigned legacy stock mode to avoid consuming inventory twice.

Delivery creation requires explicit order-line IDs and quantities. A delivered status transition posts the delivery's selected quantities against inventory, resolves reservations for newly delivered quantities, and writes an inventory ledger record in the same transaction. Returns are requested against a delivered delivery and its order lines, reviewed, then received with accepted quantities and item condition. Only accepted `Resalable` quantities are restocked and recorded as `RETURN_IN`.

Refund endpoints:

```http
GET   /api/v1/orders/:orderId/refunds
POST  /api/v1/orders/:orderId/refunds
PATCH /api/v1/refunds/:refundId/approve
PATCH /api/v1/refunds/:refundId/reject
PATCH /api/v1/refunds/:refundId/process
```

Refunds are separate records; payment rows are not edited or deleted. Requests are limited to the original payment's unrefunded and unreserved amount. Processing requires approval, records method/reference/actor/time, and reduces net collected amounts. Contractual value is reduced by cancelled line quantities, independently of refunds, so a reversal is not counted twice. Cancellation projections use the difference of cumulative rounded line adjustments, matching persisted values for fractional quantities. This is manual refund bookkeeping; no payment gateway or bank settlement is integrated.

Return endpoints:

```http
GET   /api/v1/orders/:orderId/returns
POST  /api/v1/orders/:orderId/returns
PATCH /api/v1/returns/:returnId/approve
PATCH /api/v1/returns/:returnId/reject
PATCH /api/v1/returns/:returnId/receive
```

Lifecycle actions are permission-gated (`orders.complete`, `orders.cancel`, `payments.refund.request`, `payments.refund.approve`, `payments.refund.process`, `returns.create`, `returns.approve`, and `returns.receive`) within the order's branch. Cancellation remains a one-step `orders.cancel` action; separate manager approval has no configured policy. State, stock, ledger, and audit changes are transactional. Identical request-key retries replay the original creation; changing data under an existing key conflicts. Concurrency tests verify amount/quantity limits and single refund/receipt posting. Order audit history links real order, payment, delivery, refund, return, and reconciliation records, enforces the actual order branch, and returns the latest 25 events only with `audit.read`.

Receipt accepts `remainderCondition` when a Resalable item is only partly accepted into inventory. For 10 returned, 7 accepted, and Damaged remainder, stock increases by 7 while all 10 are tracked as returned. Other receipt combinations reject this field. Migration `0013_return_remainder_condition.sql` adds the nullable classification with a database constraint; historical unclassified remainders stay null. Receipt recomputes open order status from net delivered/cancelled quantities and preserves closed status. Replacement delivery reserves available stock and posts normally; receiving damaged goods does not create replacement stock.

Legacy reconciliation endpoints:

```http
GET /api/v1/orders/:orderId/legacy-delivery-reconciliation
PUT /api/v1/orders/:orderId/legacy-deliveries/:deliveryId/reconcile
```

Both require `deliveries.update` and enforce branch scope. Migration `0012_legacy_delivery_reconciliation.sql` marks inferred pre-reservation allocations Unverified and preserves their inferred quantity. PUT submits all order lines (zero for absent goods) and a note of at least 10 characters. It validates cumulative allocation bounds, stores verifier/time, and audits old/new quantities without changing physical stock. Correction is blocked when existing returns/cancellations/closed status/stock postings make it unsafe; same-quantity verification remains possible. Delivery/return/completion/cancellation actions are guarded until reconciliation is complete. New Reserved orders are unaffected.

The historical order/administration checkpoint recorded on 2026-10-01 included 20 frontend order checks (17 rendered browser scenarios), 57 backend unit tests, 53 isolated PostgreSQL integration cases, and 14 applied migrations. Those figures precede the fleet, allowance, customer receivable, and private-proof work below and are not the latest totals. See Section 62 and `../progressreport.md` for the current verification record. Run `npm run test:integration:local` for disposable DB tests and the frontend's `npm run test:e2e` for isolated browser acceptance. CI contains PostgreSQL and browser gates; hosted execution, full-module/all-role/accessibility matrices, staging, and production remain unverified.

# 56. Implemented Users & Roles Administration

The administration APIs use the existing account, role, permission, session, and audit tables. This iteration adds no schema fields or migrations. These are verified local administration operations; they do not complete self-service account recovery or certify the whole application for release.

| Endpoint                                  | Required permission                             | Current behavior                                                                                                                                               |
| ----------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/users`                       | `users.read`                                    | Server-paginated account list with supported search, sort, and status filters; branch-scoped viewers see accounts whose home branch matches their own.         |
| `GET /api/v1/users/options`               | `users.create` or `users.update`                | Active branches within the actor's scope and assignable roles, including descriptions. Roles whose grants exceed the actor's permissions are omitted.          |
| `GET /api/v1/users/:userId?historyPage=1` | `users.read`                                    | Safe stored account detail, current role/permissions, branch, management eligibility, and permission-gated audit history.                                      |
| `POST /api/v1/users`                      | `users.create`                                  | Creates an Active account with a normalized email, hashed password, validated role/branch assignment, and transactional audit.                                 |
| `PATCH /api/v1/users/:userId`             | `users.update`                                  | Updates name, role, branch, cross-branch access, or Active/Inactive status after scope and grant checks. Email and password are not accepted by this endpoint. |
| `DELETE /api/v1/users/:userId`            | `users.update`                                  | Administrator-only audited soft deletion. Marks the account Inactive/deleted, revokes all sessions, blocks sign-in, and preserves the user row and historical references. Self-deletion and removal of the last active Administrator are rejected. |
| `POST /api/v1/users/:userId/password`     | `users.update`                                  | Administrator reset for another manageable account; clears failed-login lockout and revokes all target sessions.                                               |
| `GET /api/v1/roles`                       | `roles.read`                                    | Role catalogue with stored description, grants, creation time, scoped assigned-user count, and management eligibility.                                         |
| `GET /api/v1/roles/options`               | `roles.read`, `roles.create`, or `roles.update` | Permission keys the actor currently holds.                                                                                                                     |
| `GET /api/v1/roles/:roleId?historyPage=1` | `roles.read`                                    | Role metadata and permission-gated, paginated real audit history.                                                                                              |
| `POST /api/v1/roles`                      | `roles.create`                                  | Creates a custom role using only known, unique permission keys within the actor's grants.                                                                      |
| `PATCH /api/v1/roles/:roleId`             | `roles.update`                                  | Edits a manageable custom role's name, description, or permissions.                                                                                            |
| `DELETE /api/v1/roles/:roleId`            | `roles.update`                                  | Deletes an unused, manageable custom role and retains its deletion audit. Assigned users must be reassigned first.                                             |

User detail returns `{ user, history, historyPage, historyPageSize, historyTotal }`. `user` includes `id`, `name`, `email`, `roleId`, `roleName`, `roleDescription`, `branchId`, `branchName`, `isCrossBranch`, `status`, `createdAt`, `updatedAt`, the stored nullable `lastLoginAt`, current `permissions`, `canManage`, and `managementReason`. It exposes no password hash, login-attempt counters, session identifiers/tokens, or lockout internals. Last login is populated only by successful authentication; no timestamp is inferred for older accounts.

Role detail returns `{ role, history, historyPage, historyPageSize, historyTotal }`. The role includes `id`, `name`, `description`, `isSystem`, `permissions`, `createdAt`, `assignedUserCount`, `canManage`, and `managementReason`. Counts include Active and Inactive non-deleted accounts visible within the actor's management scope. For branch-scoped actors, cross-branch accounts and other branches are excluded from the count; a zero visible count does not establish that a role is globally unused.

History uses 20 events per page, ordered newest first with an ID tie-breaker. `historyPage` accepts integers from 1 to 10000. Without `audit.read`, the API returns an empty history and a zero total. Branch-scoped viewers receive only events tagged with their assigned branch; historical null/global role events are not exposed to them. Entries include the real actor name, action, creation time, and allowlisted old/new administration fields. The historical JSON filter excludes unknown top-level password, token, and hash keys; it does not recursively validate unexpected nested values within an allowed historical field. These detail endpoints validate UUIDs and query parameters before querying PostgreSQL.

Account writes check the **existing** account scope before evaluating the proposed assignment. A branch-scoped actor cannot pull an account from another branch into their own or manage a cross-branch account merely because its home branch matches. Out-of-scope reads/writes return the same account-not-found response. Same-branch account detail can be visible while `canManage` is false because the target has grants beyond the actor's own. Update and password-reset operations enforce that existing grant ceiling; assigning a new role also checks its grants. Proposed branch assignments require an active branch. An unassigned account requires cross-branch access, which only a cross-branch actor may grant. Self role/branch/access/deactivation changes and administrator self-password reset are guarded, and at least one Active built-in administrator must remain.

Account deletion uses the existing `deleted_at` and `deleted_by` fields rather than removing the row. Only an authenticated system Administrator with `users.update` can request it; a custom role or forged cross-branch flag is insufficient. The transaction locks the system Administrator role before the target account, rejects self-deletion and protects the last Active Administrator, marks the target Inactive/deleted, revokes all its sessions, and writes the deletion audit event atomically. Authentication and active account queries reject/hide the deleted account while its email, audit and business foreign keys remain intact; the email stays reserved. The Users page requires explicit confirmation and explains that account history and the email are retained.

Custom-role mutation checks both existing and proposed grants. Branch-scoped actors cannot edit or delete a role assigned to another branch, a global account, or a cross-branch account; this includes Inactive non-deleted accounts. Unassigned custom roles remain manageable when their grants fit within the actor's own permissions. The built-in administrator role is immutable. The shared-role write guard follows the existing branch-isolation rule; additional organization-specific delegation or approval policies are not implemented.

Account rows and affected role rows are locked within the mutation transaction. Multiple role rows are locked in stable ID order, and current grants are reread after locking. This serializes assignment changes with role updates and protects the scope checks from concurrent mutations. Role deletion checks all assigned accounts, beyond the visible count. Business changes and their audit records commit together.

Session revocation is based on **actual persisted access changes**. Changing a user's role, branch, cross-branch access, or status revokes every target session in the same transaction. A name edit that submits unchanged assignment/status fields preserves existing sessions. Password reset always revokes sessions. Changing a role's permission set revokes its assigned users' sessions; role name/description edits and an unchanged permission set preserve sessions. Every authenticated request still reloads account status, assignment, and current grants from PostgreSQL.

Failed login attempts increment atomically, including concurrent requests. Eight failed attempts trigger the existing 15-minute account lock; a failed attempt after expiry begins a new attempt cycle. Successful login clears the counter and updates `lastLoginAt`. Before creating a session, the transaction rechecks the stored password hash, Active/non-deleted status, and lock expiry. An in-flight login verified before a password reset or deactivation cannot recreate a session using stale credentials.

At the historical administration checkpoint on 2026-10-01, `tests/integration/user-management-http.test.ts` contained 12 HTTP/PostgreSQL administration scenarios covering validation, account creation/detail, scope and grant denial, activation, password reset, assignment/session changes, unchanged full edit payloads, system/last-administrator protection, shared roles, role lifecycle, safe audit pagination, concurrent lockout, and stale-password session rejection. That checkpoint recorded **57 unit tests and 53 PostgreSQL integration cases across 8 integration files**, 14 migrations, and **35 frontend acceptance checks (32 rendered scenarios and 3 arithmetic checks)** for order/shell and administration. These are retained as historical evidence, not current suite totals. The disposable runner creates and drops a separate database; development records are not test fixtures. See Section 62 for the later backend results and `../progressreport.md` for the final browser run. Full-module/all-role/accessibility matrices, hosted CI, production infrastructure, and recovery operations remain unverified.

# 57. Implemented Worker and Fleet Workflows

Drivers are existing employee records with `isDriver`, optional license number/classification/expiry, `driverAvailability`, emergency contact, and notes. The Employee APIs in Section 53 create and edit these fields; there is no separate driver/person table. Driver availability is `Available` or `Unavailable`. An assignment requires an Active, non-deleted driver in the selected branch whose availability permits assignment. A recorded expired license prevents assignment; optional license data is not a legal license verification service. Active assignments protect worker updates and archival from unsafe changes.

The original implementation used globally shared vehicles; that model was superseded by migration `0027_vehicle_branch_scope.sql`. Vehicles now have nullable branch ownership. Branch accounts are scoped to their assigned branch, and Admin can view all or filter by an active branch. New branch-user vehicles inherit the authenticated branch; Admin must select one. Generic edit cannot move vehicle ownership. Legacy vehicles with no operational history or mixed-branch assignment/maintenance history remain unassigned and Admin-only pending review. Assignments, maintenance, default drivers, vehicle activity and connected report/dashboard data use branch-valid relationships.

All paths below are under `/api/v1`:

```text
GET   /vehicles/options
GET   /vehicles
POST  /vehicles
GET   /vehicles/:id?historyPage=1&maintenancePage=1&assignmentPage=1
PATCH /vehicles/:id
PATCH /vehicles/:id/status
PATCH /vehicles/:id/archive

GET   /vehicle-assignments
POST  /vehicle-assignments
GET   /vehicle-assignments/:id?historyPage=1
POST  /vehicle-assignments/:id/start
POST  /vehicle-assignments/:id/complete
POST  /vehicle-assignments/:id/cancel
```

Vehicle records store name, unique normalized plate number, vehicle type, brand/model/year/color, fuel type, odometer, capacity value/unit, optional default driver, registration/insurance dates and references, service date, and notes. Capacity value and unit must be supplied together. Vehicle type and maintenance type are validated descriptive fields rather than new business classification tables. A default driver is a worker reference; it does not assign every future trip automatically.

Vehicle statuses are `Available`, `On Service`, `Under Maintenance`, and the retained `Unavailable` state. The status endpoint accepts `{ status: 'Available' | 'Under Maintenance' | 'Unavailable' }`; operational `On Service` is derived from assignments. Scheduled and Active assignments reserve both vehicle and worker immediately. This deliberately conservative reservation prevents overlapping active work; it does not implement a future time-slot booking calendar. Row locks and partial unique database indexes protect these constraints during concurrent requests.

Assignment creation accepts vehicle/driver/branch IDs, destination, purpose, optional scheduled timestamp, starting odometer, and notes. Status moves from Scheduled to Active to Completed, or Scheduled/Active to Cancelled. Ending odometer cannot precede starting odometer, and completion updates the vehicle reading. Vehicle detail exposes paginated assignment and maintenance records, cost summary, operational eligibility, and permission-filtered audit history. Detail activity/history uses 20 records per page; list endpoints support server search, sort, status, page, and limit.

To link a trip to an order delivery, create the delivery with paired `driverId` and `vehicleId` fields through the existing delivery API. Standalone assignment creation rejects a direct `deliveryId`. Moving the linked delivery to In Transit starts its assignment; Delivered completes it; Failed cancels it. Manual assignment transitions are blocked for delivery-linked work so delivery and fleet status cannot diverge. The legacy free-text driver name remains available only when no worker is linked. Delivery detail resolves assignment ID, worker name, vehicle name, and plate number. Construction destinations/purposes can be recorded; no Project entity or invented project foreign key was added.

# 58. Implemented Maintenance and Expense Posting

```text
POST  /api/v1/vehicles/:id/maintenance
GET   /api/v1/vehicle-maintenance/:id?historyPage=1
PATCH /api/v1/vehicle-maintenance/:id
POST  /api/v1/vehicle-maintenance/:id/start
POST  /api/v1/vehicle-maintenance/:id/complete
POST  /api/v1/vehicle-maintenance/:id/cancel
```

Maintenance operations require both `vehicles.maintenance` and `expenses.read` and enforce the record's actual branch. Records contain maintenance type, description, reported problem, service provider/contact, actual service dates, labor/parts/other costs, receipt reference, notes, and linked expense ID. Costs use decimal strings and exact-cent arithmetic.

Statuses are Scheduled, In Progress, Completed, and Cancelled. Scheduled/In Progress records may be edited; Completed/Cancelled records are locked. Start refuses conflicting Scheduled/Active assignments and places the vehicle Under Maintenance. Actual start/completion dates reject future dates and completion before start. Completion posts one linked **Pending** expense when total cost is positive; the normal expense approval workflow remains necessary. State guards, transaction locks, and a unique expense link prevent a second posting. Cancellation does not create an expense. Completing/cancelling a job releases its maintenance hold while respecting other active maintenance and the vehicle's manual availability setting.

Proofs can be attached to non-cancelled maintenance records using Section 61. The cost/expense relationship is stored once; reports do not post another expense or overwrite a completed financial record.

# 59. Implemented Driver Allowance Workflow

```text
GET   /api/v1/driver-allowances/options
GET   /api/v1/driver-allowances
POST  /api/v1/driver-allowances
GET   /api/v1/driver-allowances/:id?historyPage=1
PATCH /api/v1/driver-allowances/:id
POST  /api/v1/driver-allowances/:id/approve
POST  /api/v1/driver-allowances/:id/release
POST  /api/v1/driver-allowances/:id/receive
POST  /api/v1/driver-allowances/:id/cancel
```

Actions require `driver-allowances.read`, `.create`, `.update`, `.approve`, `.release`, `.receive`, or `.cancel` as appropriate and enforce the actual branch. Migration `0014_fleet_workflows.sql` grants new workflow permissions to the built-in administrator; other roles must be deliberately assigned the grants they need.

An allowance references an existing driver worker and branch, with optional assignment/delivery links validated against that worker and branch. Payment types are Trip allowance, Delivery allowance, Meal allowance, Fuel allowance, Cash advance, Reimbursement, and Other. Timing is Immediate, After trip, Scheduled payday, or Pending release. Methods are Cash, GCash, Bank Transfer, Payroll, and Other. Store amount, reference number, and notes along with the workflow actors/timestamps.

The lifecycle is **Pending → Approved → Released → Received**. Only Pending records are editable; only Pending/Approved records can be cancelled. Approval records the approving actor and timestamp. Release creates exactly one linked **Approved** expense, preserving the allowance approval actor/time. Released/Received records cannot be silently edited or cancelled.

Receive accepts `{ receivedAt, acknowledgement?, proofAttachmentId? }`, with an offset-aware receipt timestamp on/after release and no future timestamp beyond the small clock tolerance. A non-empty acknowledgement or a physically readable proof belonging to that same allowance is required. A proof attached to another allowance, payment, or maintenance record does not satisfy receipt. This records evidence of acknowledgement; it does not authenticate a photographed person's identity.

Allowance bookkeeping is separate from regular salary. Payroll method and Scheduled payday are recorded choices, not an integrated pay run. No salary calculation, automatic cash-advance recovery, net-pay deduction, external bank transfer, or GCash settlement is performed.

# 60. Implemented Customer Receivables and Immutable Receipts

```text
GET  /api/v1/payments
GET  /api/v1/payments/options
GET  /api/v1/payments/orders/:orderId
POST /api/v1/payments
```

The Payments list now returns **one financial row per order**, including orders with no payment. Columns are Order, Customer, Total Amount, Amount Paid, Remaining Balance, Status, and Last Payment Date. Server search/filter/pagination and monetary/date sorting operate on real database values. The list and dedicated detail require `payments.read`; detail does not additionally require `sales.read`. Options and receipt creation require `payments.create`. Every operation checks the actual order branch; missing and out-of-scope detail share a not-found response.

Receipt creation accepts:

```json
{
  "orderId": "order-uuid",
  "amount": "1250.00",
  "method": "GCash",
  "paymentDate": "2026-10-01",
  "externalReference": "provider-reference",
  "notes": "Customer's partial payment",
  "requestKey": "request-uuid"
}
```

Methods are Cash, GCash, Bank transfer, Card, Cheque, and Other. Amount is a positive decimal string with at most two decimal places. Payment date is a valid non-future Philippine calendar date; omitted dates default to today in `Asia/Manila` for compatibility. Provider reference and notes are optional bounded text. The frontend uses a stable UUID request key for retries. Identical retries return the original receipt; reusing the key with another actor, order, or different payment data returns a conflict. Order locking serializes competing collections and rejects overpayment, closed-order collection, and collection while a refund is unresolved.

Receipts retain their original amount, method, actual payment date, reference, notes, recorded-by actor, and creation timestamp. There are no payment edit/delete APIs. Refunds remain separate records using Section 55; private proofs reference the receipt ID, not the order ID.

The shared balance calculation is:

```text
Payable amount = original priced order lines minus rounded cancelled quantities
Net amount paid = paid receipts minus processed refunds
Remaining balance = payable amount minus net amount paid
```

Requested/Approved refunds are shown separately until processed. Returns alone do not reduce payable value or refund cash. Cancellation and processed refunds affect different parts of the calculation, avoiding double reversal. Money is calculated in exact cents and returned as strings; negative balances remain visible as Overpaid rather than being hidden. Financial status is Cancelled for cancelled orders, otherwise Overpaid, Paid, Partially Paid, or Unpaid according to the signed balance/net receipts.

Detail returns the order/customer/branch identifiers and names, original/payable/receipt/refund/net/balance totals, pending refund amount, financial and order statuses, last payment date, immutable payment/refund arrays, and `canRecordPayment`/`recordingBlocker`. The latest 25 relevant audit events are included only with `audit.read`. A repeatable-read transaction keeps the financial summary and histories consistent.

The current application retains cash-order completion rules: an order must meet fulfillment/workflow checks and have no outstanding balance to complete. Due dates, overdue charges, credit terms, credit-limit decisions, invoice accounting, and automated payment-provider integration have not been introduced.

# 61. Implemented Private Proof APIs and Storage

Supported parents are `payment`, `vehicle-maintenance`, and `driver-allowance`. The existing attachments table stores metadata; no second payment or proof ledger was created.

```text
GET  /api/v1/attachments?entityType=payment&entityId=receipt-uuid
POST /api/v1/attachments?entityType=payment&entityId=receipt-uuid
GET  /api/v1/attachments/:id/content
```

Upload sends the file's raw binary body, its allowed `Content-Type`, and a percent-encoded `x-file-name` header. It is not multipart or a public URL registration endpoint. Listing returns `{ items: [{ id, fileName, mimeType, fileSize, uploadedByName, createdAt }] }`; storage keys, credentials, and public URLs are not exposed.

The server authorizes the financial/operational parent before parsing an upload and rechecks it during the transaction. Payment proofs require `payments.read` to view and `payments.create` to upload. Maintenance proofs require `vehicles.maintenance` plus `expenses.read`; Cancelled records reject uploads. Allowance proofs require `.read` to view and `.release` or `.receive` to upload, and only Released/Received records accept them. Parent branch scope is enforced for list, upload, and download; out-of-scope parents return not found. A maximum of 50 proofs per parent is enforced under a parent row lock.

Accepted formats are JPEG, PNG, WebP, and PDF, up to 10 MiB per file. Filename, matching MIME/extension, bounded length, and actual file markers are validated. Path separators/control characters, empty files, executables, mismatched types, and truncated format markers are rejected. Download revalidates stored metadata/bytes and uses authenticated attachment responses with `Cache-Control: private, no-store`, `nosniff`, and a sandbox content security policy. Format checks do not provide malware scanning or full document/image certification.

For local development, leave R2 variables unset and use `LOCAL_UPLOAD_DIR` (default `.local/private-uploads`, resolved from the backend working directory). Files use generated UUID keys, restrictive creation permissions where supported, and no static/public route. Upload metadata and audit commit together; a failed transaction removes its newly stored file.

For private R2 storage, configure `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME` together. Keep the bucket private. These proof APIs do not use `R2_PUBLIC_URL` or public/presigned downloads. Production fails closed with `PRIVATE_STORAGE_REQUIRED` if storage is missing rather than falling back to a local folder. Reads are bounded to the proof limit even if an external storage object is changed.

Local private-file behavior has integration/browser coverage. Real credentialed R2 upload/download/failure/cleanup acceptance, provider configuration, and proof backup/restore operations still require deployment verification; local tests do not establish those results.

# 62. Reports, Migrations, and Current Verification

Report read and CSV export use `/api/v1/reports/data` and `/api/v1/reports/export`; `/api/v1/reports/options` supplies permitted filter choices. Implemented fleet/payment report keys are:

| Report key                 | Required domain access                     | Meaning                                                                                                |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `fleet-status`             | `vehicles.read`                             | Current vehicle availability in the authenticated branch; Admin can filter by branch or view all. It is a snapshot, not historical availability.                  |
| `fleet-assignments`        | `vehicles.assign`                          | Branch-scoped assignment activity with linked worker, vehicle, and delivery/customer where present.    |
| `fleet-maintenance`        | `vehicles.maintenance` and `expenses.read` | Branch-scoped maintenance cost/status and its linked expense.                                          |
| `driver-allowances`        | `driver-allowances.read`                   | Branch-scoped allowance workflow, method, timing, receipt, and linked expense.                         |
| `customer-balances`        | `payments.read`                            | Current signed order balances, including unpaid, paid, cancelled, and overpaid records.                |
| `customer-payment-history` | `payments.read`                            | Immutable receipts filtered by actual payment date, with provider reference, method, actor, and notes. |

All reports additionally require `reports.view`; exports require `reports.export` and write an audit record. Report-specific vehicle/driver/customer/status filters are validated, including rejecting filters that do not apply. Date ranges are bounded to 367 days. Current snapshots do not claim to reconstruct an earlier state from the selected dates. CSV output retains formula-injection escaping. Dashboard operational summaries are permission-gated and use the same customer balance and fleet/allowance records. Outstanding customer totals sum positive open balances without offsetting one customer's debt with another order's credit.

At this historical checkpoint the repository had 19 migration entries through `0018_inventory_detail_reorder.sql`: `0014_fleet_workflows.sql` extends employees/vehicles and adds fleet activity/allowances, `0015_payment_receipt_metadata.sql` adds receipt metadata/idempotency, `0016_private_proof_index.sql` indexes private proof lookup, `0017_vehicle_capacity_pair.sql` closes the SQL NULL capacity-pair validation gap, and `0018_inventory_detail_reorder.sql` adds repeat-safe stock corrections, the ledger index and the Administrator reorder grant. Apply repository migrations with `npm run db:migrate`; the existence of migration files is not a claim that a particular deployed database has applied them. Existing persons, receipts, inventory ledger, expense records, and legacy vehicle fields are preserved.

Results at that historical Inventory checkpoint were **73 unit tests**, **106 PostgreSQL integration cases across 14 files**, and **79 frontend acceptance checks (76 rendered + 3 arithmetic)**. Current verification is recorded in Section 67 and `../progressreport.md`.

From `cbms-backend`:

```bash
npm run test
npm run test:integration:local
npm run build
npm run lint
npm run format:check
```

For `test:integration:local`, the configured development `DATABASE_URL` supplies connection/create-database capability, but fixtures are written only to a randomly named `cbms_integration_*` database that the runner migrates and drops afterward. Alternatively, set `TEST_DATABASE_URL` to a dedicated `cbms_test` or `cbms_integration_*` database and run `npm run test:integration`; this runner does not itself drop a caller-provided database. Both integration and browser runners use a separate temporary private-proof directory and clear R2 configuration during tests, then remove only their own temporary storage.

New evidence includes customer receipt/refund arithmetic, concurrency/idempotency, branch/permission checks, fleet transitions/delivery linkage, allowance expense posting/receipt proof, private download validation and rollback, report access/filter/export behavior, and rendered responsive/recovery flows. Run browser acceptance from `cbms-frontend` with `npm run test:e2e`; focused fleet/payment/report commands are in that directory's README. These checks support the implemented scope; full organization policy, payroll, external settlement, real R2, hosted CI, accessibility certification, staging, and production recovery remain separate release work.

# 63. Inventory Detail, Ledger, Reorder Points, and Adjustments

Inventory list rows identify the actual product/branch stock row with a stable `id`. Exact `quantity`, `reservedQuantity`, `availableQuantity`, and `reorderLevel` are returned as decimal strings; displayed quantities include the product unit and sort numerically. Available stock is physical on-hand quantity minus reservations. The existing alert policy is inclusive: zero stock is Out of stock, positive on-hand stock at or below its reorder point is Low stock, and greater quantities are In stock. Inventory, dashboard alerts, and inventory-health reports use this same rule.

```text
GET   /api/v1/inventory/:id?movementPage=1&movementType=&dateFrom=2026-10-01&dateTo=2026-10-01&historyPage=1
PATCH /api/v1/inventory/:id/reorder
POST  /api/v1/inventory/adjustments
```

Detail requires `inventory.read` and the stock row's actual assigned branch, returning 404 for foreign rows and failing closed for an unassigned scoped account. Cross-branch accounts may review all permitted rows. A repeatable-read transaction keeps quantities, movement counts, and history coherent. Movements and audit history have independent 20-record pages; date filters cover inclusive Asia/Manila business dates. Detail returns `{ inventory, movements, movementTypes, movementPage, movementPageSize, movementTotal, history, historyPage, historyPageSize, historyTotal }`. Audit entries additionally require `audit.read`; legacy adjustment audits keyed by product ID remain visible only within this stock row's branch.

Movement `stockDelta` and `reservedDelta` distinguish physical and reservation changes. Reservation creation/release changes only reserved quantity; delivery decreases both physical and reserved quantities. Adjustments, transfers, accepted returns, and cancellation restocks change physical quantity only. Unknown historical types retain their recorded `quantityDelta` and return null interpreted deltas. The API does not invent opening transactions or reconstruct running balances from an incomplete historical ledger. Linked order/return references require `sales.read`, transfer references require `inventory.transfer`, and IDs/labels come only from branch-valid parent joins.

Reorder writes require both `inventory.read` and `inventory.reorder`. The body is `{ reorderLevel: "10.375" }`, bounded from zero to 1,000,000 with at most three decimals. A row lock serializes changes and writes before/after reorder audit values without changing stock. Unchanged values create no duplicate audit event. Archived/inactive product or branch stock remains readable, while changed reorder points and new adjustments require active targets.

Adjustment bodies retain `{ productId, branchId, quantityDelta, note? }` and accept optional UUID `requestKey`. Exact decimal text and legacy JSON numbers are supported, with a nonzero signed delta of at most 1,000,000 and at most three decimals. Atomic updates cannot reduce physical stock below reserved quantity; failed reductions roll back row initialization, movement and audit. A unique request key plus transaction lock returns an existing matching actor/payload result without reposting stock; changed payloads or actors return 409. HTTP action/branch checks run before replay. Calls without a key retain their previous behavior.

Migration `0018_inventory_detail_reorder.sql` adds the nullable unique request key, stock ledger lookup index and granular reorder grant for the built-in Administrator only. Other roles require an explicit grant. The earlier migrations and data are preserved. The existing `inventory.create` permission remains for compatibility; adjustments use `inventory.adjust`. Six new unit cases and sixteen scoped Inventory HTTP/PostgreSQL/report cases pass, including concurrent removal/replay, uppercase UUID replay, positive overflow rollback, real order reservation/release, audit/linked-reference access, business-date filtering and inclusive threshold consistency. The fourteen new dark-mode Inventory browser scenarios pass in both their focused run and the full regression suite. At the Inventory checkpoint, the local database had 19 applied migrations and authenticated stock/detail/options/report/dashboard reads succeeded. The latest Expenses migration and totals are documented below.


## 64. Authoritative Expenses and exact submission

GET `/api/v1/expenses/:id?historyPage=1` requires expenses.read and the actual branch, returns 404 for foreign rows and fails closed for an unassigned scoped user. Repeatable-read detail returns `{ expense, review, source, history, historyPage, historyPageSize, historyTotal }`. Exact amount and stored submitter/branch/approval fields are authoritative. Review projects only the matching recorded Approved/Rejected expense decision (note, actual actor/date); full audit additionally requires audit.read and has independent 20-record pages.

Source is a real same-branch maintenance or driver-allowance expense_id relationship and requires the matching source-domain grant. Ambiguous historical dual source links are withheld. Manual records have no fabricated source. Private files remain authorized through their actual source parent; expense access alone cannot expose source IDs/metadata/proofs.

POST `/api/v1/expenses` delegates to the central service for exact positive cent values (decimal text or legacy JSON number), bounded by existing numeric(14,2), actual active permitted branch/default assigned branch and required recorded description/category. Optional canonical UUID requestKey serializes unchanged actor/payload retries and returns the original ID; changed actor/payload returns 409. Calls without a key retain previous behavior. Categories in options are suggestions from permitted recorded expenses, not a new mandatory taxonomy.

Pending decisions remain locked under expenses.approve. Required rejection notes, stored approval metadata/audit, concurrent decision conflict and generated fleet/allowance expenses preserve existing behavior. No edit/delete/reversal or new segregation rules are invented. Migration `0019_expense_detail_submission.sql` adds only a nullable unique manual request key; generated expense rows remain compatible. There are 20 migrations applied locally. Unit and HTTP/database evidence is recorded in progressreport.md and EXPENSE_AUDIT.md; real provider/deployment/recovery remain separate gates.

## 65. Administrator-only company-wide branch access

`users.is_cross_branch` is effective only when the assigned role is marked `is_system = 1` (the built-in Administrator role). Login and session authentication derive the access scope from both values; user creation and updates reject a custom role with global access and reject a branch-only Administrator. A branch manager or staff account therefore cannot obtain company-wide data access by role permissions or a forged request field. Branch-scope enforcement still needs module-by-module verification for every entity, relationship, report, export, dashboard query and proof.

Migration `0025_admin_only_cross_branch_access.sql` clears stored global flags from non-system roles and enables them for system Administrator accounts. It changes no schema and deletes no data. Account updates lock the system-role set before locking the target account to serialize Administrator deactivation and avoid lock-order deadlocks; the existing last-active-Administrator invariant rejects the second concurrent deactivation. The clean disposable PostgreSQL integration run applies this migration and passes **141/141 cases**; build, lint, format and **84/84 unit tests** pass. Payroll integration coverage additionally verifies branch-limited employee options, foreign-employee rejection on create/draft edit, preservation after a rejected edit, and Admin branch selection. The persistent development database was not migrated during this verification.

## 66. Payroll create replay identity

`POST /api/v1/payroll` accepts an optional UUID `requestKey`; omitting it preserves the previous behavior. The service requires `payroll.create` and checks the authenticated branch before touching replay state. With a key, it takes a transaction-scoped advisory lock, hashes the normalized branch/period/employee/pay/ordered-adjustment intent, and stores the request key, actor and fingerprint on the created run. A matching actor and fingerprint return the existing run ID/reference/status. A changed intent or actor returns 409 without exposing the existing run. The unique nullable index is a database-level guard against duplicate keys. Draft edits use a separate strict schema and cannot submit create identity.

Migration `0026_payroll_create_request_replay.sql` adds only nullable fields, an actor FK, a check that request identity fields are complete, and a unique nullable key index. It has no backfill and leaves existing pay runs untouched. Concurrent same-key creation, same-intent replay, changed-intent and different-actor conflicts pass in the disposable PostgreSQL suite. Payroll detail, processing, payment and receipt also return branch-safe denials and enforce each action grant. Private-proof HTTP tests verify read/upload/download scope by payroll entry branch and grants, then confirm receipt using the stored proof. The payroll browser workflow commits a create request, drops the first response, retries unchanged form input with the same key, and verifies the same run ID before continuing through edit/process/pay/receipt. At that payroll checkpoint, the backend passed **145/145 PostgreSQL cases across 17 files** and **84/84 unit tests**; current totals and fleet branch-scope changes are in Section 67. Full Admin/Manager/Staff provider acceptance, production migration timing, hosted CI and deployment remain unverified.

## 67. Vehicle branch ownership and connected scope

Migration `0027_vehicle_branch_scope.sql` adds nullable `vehicles.branch_id`, a restrictive FK and an index. The one-time backfill sets an owner only when all known assignment and maintenance rows for that vehicle use exactly one distinct branch. Unused or multi-branch-history vehicles remain unassigned for Admin review. No operational history is moved or discarded. Branch users create vehicles only within their authenticated branch; Admin must select an active branch. Generic vehicle edits cannot change ownership. A dedicated reviewed assignment/reassignment operation for legacy null-owner vehicles is not implemented.

Vehicle register list/detail/create/update/status/archive, default-driver choices, assignment/maintenance links and activity/history now enforce this owner. Non-Admin unassigned users fail closed. Report filter options, fleet-status/assignment/maintenance rows, and dashboard fleet totals use the viewer's branch; Admin can view all or select a branch for the register/report. Existing route grants still apply, including the company-wide Administrator requirement for cross-branch transfer creation.

Disposable PostgreSQL coverage verifies foreign list/detail/update/status/archive/options/assignment denials, forged branch create, Admin unfiltered/selected views, and no-branch denial. The employee workflow suite also now has authenticated HTTP coverage for branch-filtered list/options, foreign detail/edit/archive, branch-filter tampering and forged create. Current backend results are **84/84 unit tests** and **148/148 PostgreSQL integration cases across 17 files**. Fleet browser acceptance passes **10/10**, including the connected driver/delivery/maintenance/expense/allowance flow and seven widths from 375px to 1440px. Fleet report/dashboard browser acceptance passed **8/8**. Migration 0027 was applied by disposable integration/browser databases only; the persistent development database remains untouched. The user-facing progress report records remaining branch, proof, accessibility, provider and deployment gaps.
