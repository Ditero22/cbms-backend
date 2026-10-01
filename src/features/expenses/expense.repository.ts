import { pool } from '@/database/client.js'
import type { PoolClient } from 'pg'
import type { ExpenseCreateInput } from './expense.schemas.js'

export async function getExpenseCategories(branchId?: string) {
  const result = await pool.query<{ category: string }>(
    `select distinct category from expenses ${branchId ? 'where branch_id=$1' : ''} order by category limit 100`,
    branchId ? [branchId] : [],
  )
  return result.rows.map((row) => row.category)
}

export async function isActiveExpenseBranch(client: PoolClient, branchId: string) {
  const result = await client.query(
    "select id from branches where id=$1 and status='Active' and deleted_at is null for key share",
    [branchId],
  )
  return result.rowCount === 1
}

export async function lockExpenseRequest(client: PoolClient, requestKey: string) {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    `manual-expense:${requestKey}`,
  ])
}

export async function findExpenseRequest(client: PoolClient, requestKey: string) {
  const result = await client.query<{
    id: string
    description: string
    category: string
    branchId: string
    amount: string
    submittedBy: string
  }>(
    `select id::text as id,description,category,branch_id::text as "branchId",amount::text as amount,submitted_by::text as "submittedBy"
     from expenses where request_key=$1`,
    [requestKey],
  )
  return result.rows[0]
}

export async function insertManualExpense(
  client: PoolClient,
  input: ExpenseCreateInput,
  branchId: string,
  submittedBy: string,
) {
  const result = await client.query<{ id: string }>(
    `insert into expenses(description,category,branch_id,amount,submitted_by,request_key)
     values($1,$2,$3,$4,$5,$6) returning id::text as id`,
    [
      input.description,
      input.category,
      branchId,
      input.amount,
      submittedBy,
      input.requestKey ?? null,
    ],
  )
  return result.rows[0]!.id
}

export async function insertManualExpenseAudit(
  client: PoolClient,
  input: {
    id: string
    branchId: string
    userId: string
    description: string
    category: string
    amount: string
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs(user_id,branch_id,action,entity_type,entity_id,new_value,ip_address,request_id,created_at)
     values($1,$2,'created expenses','expenses',$3,$4,$5,$6,clock_timestamp())`,
    [
      input.userId,
      input.branchId,
      input.id,
      {
        description: input.description,
        category: input.category,
        branchId: input.branchId,
        amount: input.amount,
        submittedBy: input.userId,
        status: 'Pending',
      },
      input.ipAddress,
      input.requestId,
    ],
  )
}

export async function getExpenseBranches(branchId?: string | null) {
  const result = await pool.query<{ id: string; name: string }>(
    `select id, name from branches where deleted_at is null and status = 'Active'${
      branchId ? ' and id = $1' : ''
    } order by name`,
    branchId ? [branchId] : [],
  )

  return result.rows
}

export async function lockExpenseForReview(
  client: PoolClient,
  expenseId: string,
  branchId: string | null | undefined,
) {
  const result = await client.query<{
    id: string
    branchId: string
    description: string
    category: string
    amount: string
    status: string
  }>(
    `select id, branch_id as "branchId", description, category, amount::text as amount, status
     from expenses
     where id = $1 and ($2::uuid is null or branch_id = $2)
     for update`,
    [expenseId, branchId ?? null],
  )
  return result.rows[0]
}

export async function saveExpenseReview(
  client: PoolClient,
  expenseId: string,
  reviewerId: string,
  decision: 'Approved' | 'Rejected',
) {
  if (decision === 'Approved') {
    await client.query(
      `update expenses
       set status = $1, approved_by = $2, approved_at = now(), updated_at = now()
       where id = $3`,
      [decision, reviewerId, expenseId],
    )
    return
  }

  await client.query('update expenses set status = $1, updated_at = now() where id = $2', [
    decision,
    expenseId,
  ])
}

export async function insertExpenseReviewAudit(
  client: PoolClient,
  values: {
    userId: string
    branchId: string
    expenseId: string
    oldValue: Record<string, unknown>
    newValue: Record<string, unknown>
    ipAddress: string | null
    requestId: string | null
  },
) {
  await client.query(
    `insert into audit_logs
      (user_id, branch_id, action, entity_type, entity_id, old_value, new_value, ip_address, request_id)
     values ($1, $2, $3, 'expenses', $4, $5, $6, $7, $8)`,
    [
      values.userId,
      values.branchId,
      `expense ${String(values.newValue.status).toLowerCase()}`,
      values.expenseId,
      values.oldValue,
      values.newValue,
      values.ipAddress,
      values.requestId,
    ],
  )
}
