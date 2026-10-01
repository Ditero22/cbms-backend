# CBMS staging on Render, Neon, and Cloudflare

This runbook prepares a free-tier staging deployment with the current application architecture:

- Cloudflare Pages serves the Vite frontend and proxies `/api/*` to the API.
- Render runs the existing Dockerized Express API.
- Neon provides PostgreSQL.
- Cloudflare R2 stores private proof attachments.

The Pages proxy keeps browser API traffic on the Pages origin. That matches the backend's secure `SameSite=Lax` session cookie and avoids exposing the Render API URL to the frontend bundle. The proxy target is a Cloudflare Pages runtime variable, not a build-time variable.

## Before creating resources

Use a **new, empty staging database**. Do not point the workflow at the old Neon database or any database containing CBMS data until its migration journal, accounts, and data have been inventoried and a recovery plan has been tested. Before upgrading a database with existing data, review migration `0025`'s account-scope effects and measure migration `0029`'s inventory-ledger table-lock duration on a representative copy. Back up the database before applying migrations.

Keep synthetic staging data only. Do not copy customer, employee, payroll, payment, or proof data into this environment.

## 1. Create the Neon staging database

Create a new PostgreSQL project/database in a nearby region. Keep its connection strings private.

- Runtime `DATABASE_URL` for Render: use Neon’s **pooled** connection string and require TLS.
- GitHub Actions secret `STAGING_DATABASE_URL`: use Neon’s **direct, unpooled** connection string and require TLS. Migrations and database locks should not use the transaction pooler.

Add `STAGING_DATABASE_URL` in the backend GitHub repository’s Actions secrets. Never put a database URL in a commit, issue, workflow log, or chat.

## 2. Create the Cloudflare Pages site

Create a Pages project from `Ditero22/cbms-frontend`, production branch `main`:

- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: the repository root
- `VITE_API_URL`: omit it or set it to `/api/v1`

The frontend already defaults to `/api/v1`. The Pages Function in `functions/api/[[path]].js` forwards API paths to the backend without changing the browser-visible origin. The `_routes.json` file limits Function invocations to `/api/*`; static frontend requests remain static requests.

In Pages settings, choose **Fail closed** for exhausted Functions quotas so API routes return an error instead of falling through to a static SPA response. Pages Functions use the Workers Free daily request allowance; the API will be unavailable if that allowance is exhausted until it resets.

After the first Pages deployment, record the exact production origin, such as `https://<project>.pages.dev`. Use that origin exactly for the backend's `FRONTEND_URL` and `CORS_ORIGINS`. Do not allow preview origins unless preview deployments are explicitly secured and required.

## 3. Create private R2 storage

Create a private R2 bucket for staging proofs and an S3 API token scoped to that bucket with object read/write access. Do not enable public access. Keep the account ID, access key, and secret key in Render's environment-variable store only. This backend already supports the R2 S3-compatible API; do not use the Render filesystem for proof files because free instances have ephemeral storage.

## 4. Apply migrations and provision the initial administrator

The backend intentionally refuses to start when migrations are pending, and the Render free service does not provide a pre-deploy migration command. The backend repository includes a manual GitHub Actions workflow named **Staging database operation** for these one-time operations.

1. In GitHub Actions, run **Staging database operation** on the `main` branch with operation `migrate`; enter exactly `APPLY-STAGING-MIGRATIONS-AFTER-REVIEW` as confirmation. This first run is for the new empty database. For later migrations, review the migration and preflight/backup requirements above before entering the same confirmation. Confirm that the action succeeds before creating the Render service.
2. Add repository Actions secrets `STAGING_ADMIN_EMAIL` and `STAGING_ADMIN_PASSWORD` for a unique staging-only administrator.
3. Dispatch the same workflow on `main` with operation `provision-admin` and enter exactly `PROVISION-EMPTY-STAGING-DATABASE` in its confirmation field.
4. Confirm the run succeeds, then remove the temporary `STAGING_ADMIN_PASSWORD` repository secret. The provisioning script refuses to run if any user already exists and logs no account email or password.

The admin operation is deliberately guarded by both the exact confirmation phrase and the script's empty-user check. Never use it to repair or replace an existing account.

## 5. Create the Render API service

After migrations and administrator provisioning succeed, create a Blueprint from the backend repository and its `render.yaml`. The manifest creates the API service only; it does not create a database.

Set the prompted values in Render:

- `DATABASE_URL`: Neon pooled runtime URI.
- `FRONTEND_URL`: exact production Pages origin.
- `CORS_ORIGINS`: the same exact production Pages origin (comma-separated only if more trusted origins are intentionally required).
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`: staging R2 settings.

Render generates `SESSION_SECRET`; the manifest sets `TRUST_PROXY=true`, `NODE_ENV=production`, and a small database pool. The health check is `/api/ready`. Automatic deploys are disabled so a later commit cannot deploy database-dependent code before its migration is deliberately applied. After reviewing a future migration and backup plan, run the migration workflow first, then deploy that commit from Render.

The service URL is the API origin, for example `https://<service>.onrender.com`. Keep it as an origin only: no path, query string, or credentials.

## 6. Connect Pages to the API

In the Cloudflare Pages project's production **Runtime** variables, set:

- `CBMS_API_ORIGIN` = the HTTPS Render service origin.

Redeploy Pages after adding this variable. This is a server-side Function variable; do not prefix it with `VITE_`, since Vite variables are embedded in browser assets.

## 7. Verify the staging deployment

Use synthetic records and verify these flows from the deployed Pages origin:

1. Open `/api/health` and `/api/ready`; confirm the API responds and readiness reports migrations complete.
2. Sign in through the Pages site. In browser developer tools, verify the session cookie is Secure, HttpOnly, and SameSite=Lax and that API traffic uses the Pages origin.
3. Confirm an authorized read and write, then confirm an unauthorized role cannot perform the same restricted action.
4. Upload a synthetic proof, read it through the authenticated application, and confirm private objects are not anonymously accessible.
5. Wait for Render to idle, then verify recovery after its cold start. Free Render web services spin down after inactivity, so the first request can be slow; this is suitable for staging, not dependable business operations.
6. Review logs for startup errors and verify no credentials, session cookies, or personal data are logged.

## Free-tier limits and recovery

Free tiers are useful for a learning/staging environment, but they do not guarantee zero charges or production availability. Render free web services sleep after inactivity and have ephemeral filesystems. Neon free compute and storage have quotas. Cloudflare R2 includes a free allowance, but usage beyond its monthly storage and operation allowances can incur charges. Check current provider limits and billing alerts before uploading substantial files or running real business data.

Before any production release, complete and rehearse a paired database-and-R2 backup/restore, test the migration path against representative data, configure monitoring and billing alerts, and choose service plans that meet the application's availability and recovery needs. A database backup alone cannot restore proof attachments referenced by CBMS records.
