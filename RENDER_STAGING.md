# CBMS staging on Render, Neon, and Cloudflare

> Shared documentation: [index](../md-docs/README.md), [current production progress](../md-docs/project/progressreport.md), and [approved release scope](../md-docs/project/release-scope.md). This package guide retains product/architecture details and dated checkpoints. Older “current” counts, follow-up tasks and scope assertions yield to those canonical sources; a documented feature is not proof of completion.


> Legacy Pages-based setup guide. The current frontend repository also contains a Cloudflare Worker entry point and uses the staging API origin in `cbms-frontend/wrangler.jsonc`. For the current Worker proxy and environment-specific deployment flow, follow the shared [deployment runbook](../md-docs/deployment/deployment.md). Do not use this older Pages guide as evidence that staging or production resources are provisioned.

This runbook prepares a free-tier staging deployment with the current application architecture:

- Cloudflare Pages serves the Vite frontend and proxies `/api/*` to the API.
- Render runs the existing Dockerized Express API.
- Neon provides PostgreSQL.
- Cloudflare R2 stores private proof attachments.

The Pages proxy keeps browser API traffic on the Pages origin. That matches the backend's secure `SameSite=Lax` session cookie and avoids exposing the Render API URL to the frontend bundle. The proxy target is a Cloudflare Pages runtime variable, not a build-time variable.

## Resource names used in this guide

Use these names so each provider resource is easy to identify as staging. Provider names may already be taken; if a name is unavailable, add a short suffix and use the actual generated URL/name consistently in all the settings below.

If you change the Render service name, update the `name` field in backend `render.yaml` before creating its Blueprint. If you change the R2 bucket name, use that exact name for Render's `R2_BUCKET_NAME`. If Cloudflare assigns a different Pages URL, use its exact origin for Render's `FRONTEND_URL` and `CORS_ORIGINS`.

| Provider         | Resource                                   | Name                             |
| ---------------- | ------------------------------------------ | -------------------------------- |
| GitHub           | Backend repository                         | `Ditero22/cbms-backend`          |
| GitHub           | Frontend repository                        | `Ditero22/cbms-frontend`         |
| Neon             | PostgreSQL project                         | `cbms-staging-ditero22`          |
| Neon             | Branch                                     | `main`                           |
| Cloudflare Pages | Frontend project                           | `cbms-frontend-staging-ditero22` |
| Cloudflare R2    | Private proof bucket                       | `cbms-staging-proofs-ditero22`   |
| Cloudflare R2    | S3 API token                               | `cbms-staging-proof-storage`     |
| Render           | API service (already set in `render.yaml`) | `cbms-api-staging-ditero22`      |

Neon may supply its own default database/role names when creating the project. Keep those defaults and use the connection strings Neon generates; CBMS does not require a particular PostgreSQL database or role name.

## Files to push before provider setup

These deployment files are in the two existing GitHub repositories. Push them to `main` before creating the Cloudflare Pages project or running the database workflow.

In `Ditero22/cbms-backend`:

```powershell
Set-Location C:\Users\karlo\Documents\CBMS\cbms-backend
git add -- .github/workflows/staging-database.yml RENDER_STAGING.md render.yaml src/database/provision-admin.ts
git commit -m "Prepare Render and Neon staging deployment"
git push origin main
```

In `Ditero22/cbms-frontend`:

```powershell
Set-Location C:\Users\karlo\Documents\CBMS\cbms-frontend
git add -- .github/workflows/ci.yml eslint.config.js package.json "functions/api/[[path]].js" public/_headers public/_routes.json tests/pages-proxy.test.mjs
git commit -m "Add Cloudflare Pages API proxy"
git push origin main
```

These commands stage only the named files. If Git says there is nothing to commit, check the repository's status before continuing.

## Before creating resources

Use a **new, empty staging database**. Do not point the workflow at the old Neon database or any database containing CBMS data until its migration journal, accounts, and data have been inventoried and a recovery plan has been tested. Before upgrading a database with existing data, review migration `0025`'s account-scope effects and measure migration `0029`'s inventory-ledger table-lock duration on a representative copy. Back up the database before applying migrations.

Keep synthetic staging data only. Do not copy customer, employee, payroll, payment, or proof data into this environment.

## 1. Create the Neon staging database

In Neon, choose **Create project** and enter `cbms-staging-ditero22`. Choose Singapore if Neon offers it for your account; otherwise choose the closest available region. Keep the generated database/role names and connection strings private. Use this project only for CBMS staging.

- Runtime `DATABASE_URL` for Render: use Neon’s **pooled** connection string and require TLS.
- GitHub Actions secret `STAGING_DATABASE_URL`: use Neon’s **direct, unpooled** connection string and require TLS. Migrations and database locks should not use the transaction pooler.

In GitHub, open `Ditero22/cbms-backend` → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add:

| Secret name            | Value                                                      |
| ---------------------- | ---------------------------------------------------------- |
| `STAGING_DATABASE_URL` | Neon direct (unpooled) connection string with TLS required |

Never put a database URL in a commit, issue, workflow log, or chat.

## 2. Create the Cloudflare Pages site

In Cloudflare, choose **Workers & Pages** → **Create** → **Pages** → **Connect to Git**. Select `Ditero22/cbms-frontend`, set the Pages project name to `cbms-frontend-staging-ditero22`, and choose production branch `main`:

- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: the repository root
- `VITE_API_URL`: omit it or set it to `/api/v1`

The frontend already defaults to `/api/v1`. The Pages Function in `functions/api/[[path]].js` forwards API paths to the backend without changing the browser-visible origin. The `_routes.json` file limits Function invocations to `/api/*`; static frontend requests remain static requests.

In Pages settings, choose **Fail closed** for exhausted Functions quotas so API routes return an error instead of falling through to a static SPA response. Pages Functions use the Workers Free daily request allowance; the API will be unavailable if that allowance is exhausted until it resets.

After the first Pages deployment, copy its exact production URL. It will normally be `https://cbms-frontend-staging-ditero22.pages.dev`; if Cloudflare selected another name, use the URL shown in the dashboard. Use that exact origin (scheme and hostname only) for the backend's `FRONTEND_URL` and `CORS_ORIGINS`. Do not allow preview origins unless preview deployments are explicitly secured and required.

## 3. Create private R2 storage

In Cloudflare R2, create the private bucket `cbms-staging-proofs-ditero22`. Do not enable public access. Create an S3 API token named `cbms-staging-proof-storage`, scoped only to that bucket, with object read and write permissions. Save its access key and secret when Cloudflare shows them; put them only into Render's environment-variable store. Record the Cloudflare account ID for the same account. This backend already supports the R2 S3-compatible API; do not use the Render filesystem for proof files because free instances have ephemeral storage.

## 4. Apply migrations and provision the initial administrator

The backend intentionally refuses to start when migrations are pending, and the Render free service does not provide a pre-deploy migration command. The backend repository includes a manual GitHub Actions workflow named **Staging database operation** for these one-time operations.

1. In `Ditero22/cbms-backend` → **Actions**, open **Staging database operation** → **Run workflow**. Select branch `main`, operation `migrate`, and enter exactly `APPLY-STAGING-MIGRATIONS-AFTER-REVIEW` as migration confirmation. This first run is for the new empty database. For later migrations, review the migration and preflight/backup requirements above before entering the same confirmation. Confirm that the action succeeds before creating the Render service.
2. In the same backend repository's Actions secrets, add `STAGING_ADMIN_EMAIL` and `STAGING_ADMIN_PASSWORD` for a unique staging-only administrator. These are one-time provisioning credentials, not the Render runtime secrets.
3. Dispatch the same workflow on `main` with operation `provision-admin` and enter exactly `PROVISION-EMPTY-STAGING-DATABASE` in its confirmation field.
4. Confirm the run succeeds, then remove the temporary `STAGING_ADMIN_PASSWORD` repository secret. The provisioning script refuses to run if any user already exists and logs no account email or password.

The admin operation is deliberately guarded by both the exact confirmation phrase and the script's empty-user check. Never use it to repair or replace an existing account.

## 5. Create the Render API service

After migrations and administrator provisioning succeed, in Render choose **New** → **Blueprint** and select `Ditero22/cbms-backend` on branch `main`. Render reads `render.yaml` from the repository root and creates the API service named `cbms-api-staging-ditero22`. The manifest creates the API service only; it does not create a database.

Set the prompted values in Render:

- `DATABASE_URL`: Neon pooled runtime URI.
- `FRONTEND_URL`: exact production Pages origin.
- `CORS_ORIGINS`: the same exact production Pages origin (comma-separated only if more trusted origins are intentionally required).
- `R2_ACCOUNT_ID`: Cloudflare account ID for the bucket.
- `R2_ACCESS_KEY_ID`: access key from token `cbms-staging-proof-storage`.
- `R2_SECRET_ACCESS_KEY`: secret key from that same token.
- `R2_BUCKET_NAME`: `cbms-staging-proofs-ditero22`.

Leave `R2_PUBLIC_URL` unset. Proof attachments are private and delivered through authenticated API routes.

Render generates `SESSION_SECRET`; the manifest sets `TRUST_PROXY=true`, `NODE_ENV=production`, and a small database pool. The health check is `/api/ready`. Automatic deploys are disabled so a later commit cannot deploy database-dependent code before its migration is deliberately applied. After reviewing a future migration and backup plan, run the migration workflow first, then deploy that commit from Render.

After deployment, copy the exact URL shown for Render service `cbms-api-staging-ditero22`. It will normally be `https://cbms-api-staging-ditero22.onrender.com`; if Render assigned another URL, use that actual origin. Keep it as an origin only: no path, query string, or credentials.

## 6. Connect Pages to the API

In Cloudflare Pages project `cbms-frontend-staging-ditero22` → **Settings** → **Variables and Secrets** → **Production**, add:

- `CBMS_API_ORIGIN` = the HTTPS Render service origin.

Redeploy Pages after adding this variable. This is a server-side Function variable; do not prefix it with `VITE_`, since Vite variables are embedded in browser assets.

Keep `CBMS_API_ORIGIN` out of the **Preview** environment until preview domains are deliberately added to the backend CORS allowlist.

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
