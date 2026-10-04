# CBMS backend architecture

Current cross-cutting guidance: [backend](../md-docs/architecture/BACKEND_ARCHITECTURE.md), [database](../md-docs/architecture/DATABASE_ARCHITECTURE.md), [API](../md-docs/architecture/API_ARCHITECTURE.md), [authorization](../md-docs/architecture/AUTHORIZATION_ARCHITECTURE.md), and [module boundaries](../md-docs/architecture/MODULE_BOUNDARIES.md). This package reference retains module detail.

This guide describes the current code boundaries and durable constraints. It replaces the former implementation plan and generic backend tutorial, whose proposed folder layout and future-state statements no longer matched the repository. Verify behavior against source, migrations, and tests.

## Current structure

CBMS is a TypeScript/Express modular monolith backed by PostgreSQL and Drizzle. Feature boundaries live under `src/features`; shared HTTP, configuration, database, and security code live under `src/http`, `src/config`, `src/database`, and `src/shared`.

Current feature areas include authentication, users, records/master data, orders, payments, inventory, deliveries, fleet, expenses, payroll, reports, dashboard, and attachments. Inspect the owning feature before changing a route, service, schema, or transaction. `src/http` composes the API; shared route/schema files are not a reason to move unrelated modules.

Typical request path:

```text
HTTP route → authentication/permission/scope checks → input schema
→ feature service and transaction → PostgreSQL → response serializer
```

The service owns business rules and database invariants. Routes adapt HTTP; repositories/queries should not duplicate policy. The frontend is not a security boundary.

## Authoritative references

| Concern | Source |
| --- | --- |
| Approved first-release behavior and deferred scope | [Release scope](../md-docs/project/release-scope.md) |
| Confirmed ownership, replay, and data-retention decisions | [Engineering decisions](../md-docs/business/decisions.md) and [master-data rules](../md-docs/modules/master-data.md) |
| Authentication, authorization, branch isolation, and private proofs | [Security rules](../md-docs/security/security.md) plus the affected route/service/tests |
| Current schema and migrations | `src/database/` and `drizzle/`; inspect migration journal and package scripts. Do not rely on the archived schema-0023 snapshot. |
| Local/staging database setup | [Staging database setup](STAGING_DATABASE_SETUP.md) and [deployment recovery](../md-docs/deployment/backup-recovery.md) for recovery work |
| Current release status and test evidence | [Progress report](../md-docs/project/progressreport.md) and [completion board](../md-docs/project/completion-board.md) |

For a task, read only the relevant table row, feature, schema, and tests. The historical setup guide [RENDER_STAGING.md](RENDER_STAGING.md) is retained for reference; it does not define the current deployment.

## Non-negotiable data and security constraints

- Derive actor identity, permissions, and branch scope from authenticated server state. Check parent and related-record ownership on reads and writes, including reports, exports, dashboard aggregates, and attachment access.
- Validate all untrusted input at the API boundary and return sanitized errors. Never trust client-supplied branch, actor, balance, permission, or workflow state.
- Keep money and stock arithmetic exact. Preserve transactions, reservation/ledger invariants, idempotency keys, audit records, and immutable receipt/history behavior.
- Database startup/readiness checks are read-only. Migrations and sample seeds are explicit commands; startup never migrates or seeds.
- Private proof storage uses authorized parent records and private object access. Local mock storage tests do not establish real Cloudflare R2 acceptance or recovery.
- Never expose secrets, credentials, session values, private object URLs, personal data, SQL, or stack traces in responses, logs, tests, or documentation.
- Never point destructive tests at hosted databases. Keep the local disposable-database target guard enabled; never reset/truncate persistent local data without explicit authorization.

## Verification

Use the affected package's scripts and tests. Backend changes commonly need `npm run build`, `npm run lint`, `npm run format:check`, and focused unit/integration tests. For database changes, test the migration on a disposable local database and verify upgrade/recovery behavior appropriate to its risk. Do not report hosted provider evidence from local tests.
