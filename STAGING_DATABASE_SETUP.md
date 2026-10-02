# Staging Database Setup

## Issue

The GitHub Actions workflow `Staging database operation` is failing because required repository secrets are not configured.

**Failing Job:** [Validate staging operation request](https://github.com/Ditero22/cbms-backend/actions/runs/37002751316/job/110823961077)

## Root Cause

The validation step in `.github/workflows/staging-database.yml` checks for the following secrets before running any staging database operations:

1. **`STAGING_DATABASE_URL`** - Required for all operations
2. **`STAGING_ADMIN_EMAIL`** - Required only for `provision-admin` operation
3. **`STAGING_ADMIN_PASSWORD`** - Required only for `provision-admin` operation

These secrets are currently **not configured** in the repository, causing the workflow to fail with:
```
::error::Set the STAGING_DATABASE_URL repository Actions secret.
```

## Solution

### Step 1: Add `STAGING_DATABASE_URL` Secret

1. Navigate to your repository: **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Configure:
   - **Name:** `STAGING_DATABASE_URL`
   - **Value:** Your staging database connection string (e.g., `postgresql://user:password@host:port/database`)
4. Click **Add secret**

### Step 2: Add Admin Provisioning Secrets (if needed)

If you plan to run the `provision-admin` operation, also configure:

1. **Secret 1:**
   - **Name:** `STAGING_ADMIN_EMAIL`
   - **Value:** Email address for the staging administrator

2. **Secret 2:**
   - **Name:** `STAGING_ADMIN_PASSWORD`
   - **Value:** Password for the staging administrator

### Step 3: Re-run the Workflow

1. Go to the [Actions tab](https://github.com/Ditero22/cbms-backend/actions)
2. Select **Staging database operation**
3. Click **Run workflow**
4. Choose your operation:
   - **migrate** - Apply committed database migrations
   - **provision-admin** - Provision the first administrator
5. Provide required confirmations:
   - For migrations: `APPLY-STAGING-MIGRATIONS-AFTER-REVIEW`
   - For admin provisioning: `PROVISION-EMPTY-STAGING-DATABASE`
6. Click **Run workflow**

## Reference

- **Workflow File:** [.github/workflows/staging-database.yml](https://github.com/Ditero22/cbms-backend/blob/main/.github/workflows/staging-database.yml)
- **Failed Run:** [Run #37002751316](https://github.com/Ditero22/cbms-backend/actions/runs/37002751316)
