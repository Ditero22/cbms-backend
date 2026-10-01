import type { PoolClient } from 'pg'
import type { PayrollContext } from './payroll.service.js'

export async function writeAudit(
  client: PoolClient,
  context: PayrollContext,
  entityType: 'payroll-run' | 'payroll-entry',
  entityId: string,
  branchId: string,
  action: string,
  oldValue: unknown,
  newValue: unknown,
) {
  await client.query(
    `insert into audit_logs(user_id,branch_id,action,entity_type,entity_id,old_value,new_value,ip_address,request_id)
     values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
    [
      context.user.id,
      branchId,
      action,
      entityType,
      entityId,
      oldValue === null ? null : JSON.stringify(oldValue),
      newValue === null ? null : JSON.stringify(newValue),
      context.ipAddress,
      context.requestId,
    ],
  )
}
