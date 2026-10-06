import type { PoolClient } from 'pg'

export async function readPayrollRun(
  client: PoolClient,
  runId: string,
  branchScope: string | undefined,
) {
  const runResult = await client.query(
    `select r.id,r.reference,r.period_start::date::text as "periodStart",
            r.period_end::date::text as "periodEnd",r.employee_count as "employeeCount",
            r.gross_pay::text as "grossPay",r.branch_id as "branchId",b.name as "branchName",
            r.status,r.processed_by as "processedBy",u.name as "processedByName",
            r.processed_at as "processedAt",r.created_at as "createdAt"
     from payroll_runs r left join branches b on b.id=r.branch_id
     left join users u on u.id=r.processed_by
     where r.id=$1 and ($2::uuid is null or r.branch_id=$2)`,
    [runId, branchScope],
  )
  return runResult.rows[0]
}

export async function readPayrollEntries(
  client: PoolClient,
  runId: string,
  branchScope: string | undefined,
  page: number,
  limit: number,
) {
  const offset = (page - 1) * limit
  const entryResult = await client.query(
    `select e.id,e.employee_id as "employeeId",e.employee_number as "employeeNumber",
            e.employee_name as "employeeName",e.position,e.pay_basis as "payBasis",
            e.units::text as units,e.rate::text as rate,e.regular_pay::text as "regularPay",
            e.additional_pay::text as "additionalPay",e.deductions::text as deductions,
            e.gross_pay::text as "grossPay",e.net_pay::text as "netPay",
            e.payment_status as "paymentStatus",e.payment_date::text as "paymentDate",
            e.payment_method as "paymentMethod",e.payment_reference as "paymentReference",
            e.payment_notes as "paymentNotes",e.payment_proof_attachment_id as "proofAttachmentId",
            e.paid_by as "paidBy",paid.name as "paidByName",e.paid_at as "paidAt",
            e.received_at as "receivedAt",e.confirmed_by as "confirmedBy",
            confirmed.name as "confirmedByName",e.acknowledgement,
            count(*) over()::int as "totalEntries"
     from payroll_entries e
     left join users paid on paid.id=e.paid_by
     left join users confirmed on confirmed.id=e.confirmed_by
     where e.payroll_run_id=$1 and ($4::uuid is null or e.branch_id=$4)
     order by e.employee_name,e.employee_number,e.id limit $2 offset $3`,
    [runId, limit, offset, branchScope],
  )
  return entryResult.rows
}

export async function readPayrollAdjustments(client: PoolClient, entryIds: string[]) {
  if (!entryIds.length) return []
  const result = await client.query(
    `select id,payroll_entry_id as "payrollEntryId",kind,type,amount::text as amount,notes
         from payroll_entry_adjustments where payroll_entry_id=any($1::uuid[])
         order by created_at,id`,
    [entryIds],
  )
  return result.rows
}
