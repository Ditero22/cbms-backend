# Staging Database Operations

The **Staging database operation** GitHub Actions workflow supports three explicit operations. It only runs from the `main` branch and requires the repository secret `STAGING_DATABASE_URL`.

Configure repository secrets under **Settings → Secrets and variables → Actions**. Keep the database connection string and administrator credentials private; do not add them to this document, source control, issues, or chat.

## Check the database connection

Use this after adding or rotating `STAGING_DATABASE_URL`:

1. Open the repository's **Actions** tab.
2. Select **Staging database operation**, then **Run workflow** from `main`.
3. Choose **`check-connection`** and run it. No confirmation value is required.

This operation connects with the configured secret and runs `SELECT 1`. It does not apply migrations, create accounts, or change application data. A successful run confirms that the GitHub Actions runner can connect with that secret; it does not check whether the database has every application migration applied.

## Apply committed migrations

Choose **`migrate`** only after reviewing the committed migrations and intending to apply them to staging. Enter this exact confirmation when prompted:

```text
APPLY-STAGING-MIGRATIONS-AFTER-REVIEW
```

## Provision the first administrator

Choose **`provision-admin`** only to provision the initial staging administrator in an empty staging database. Configure `STAGING_ADMIN_EMAIL` and `STAGING_ADMIN_PASSWORD` as repository Actions secrets, then enter this exact confirmation:

```text
PROVISION-EMPTY-STAGING-DATABASE
```

Do not use this operation to reset or replace an existing administrator.

## Workflow safeguards

- Operations must be dispatched from `main`.
- `STAGING_DATABASE_URL` is required for every operation.
- Migration and administrator provisioning require their separate confirmation values.
- The connection check is read-only and does not require either confirmation.

Workflow source: [`.github/workflows/staging-database.yml`](.github/workflows/staging-database.yml)
