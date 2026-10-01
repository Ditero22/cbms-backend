import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/database/client.js'
import {
  archiveModuleRecord,
  createModuleRecord,
  getModuleRecord,
  getProductOptions,
  listModuleRecords,
  updateModuleRecord,
} from '@/features/records/record.service.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import {
  archiveVehicle,
  changeVehicleStatus,
  createVehicle,
  getVehicleDetail,
  updateVehicle,
} from '@/features/fleet/vehicle.service.js'
import { listFleetRecords } from '@/features/fleet/fleet-list.repository.js'
import { placeOrder } from '@/features/orders/order.service.js'

const fixture = randomUUID().slice(0, 8)
let user: AuthenticatedUser
let branchId: string
let otherBranchId: string

const context = () => ({ user, ipAddress: null, requestId: null })

async function insertId(sql: string, parameters: unknown[]) {
  const result = await pool.query<{ id: string }>(sql, parameters)
  if (!result.rows[0]?.id) throw new Error('Could not insert integration fixture.')
  return result.rows[0].id
}

beforeAll(async () => {
  const roleId = await insertId('insert into roles (name) values ($1) returning id', [
    `Record role ${fixture}`,
  ])
  branchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    'Record North',
    `rec-n-${fixture}`,
  ])
  otherBranchId = await insertId('insert into branches (name, code) values ($1, $2) returning id', [
    'Record South',
    `rec-s-${fixture}`,
  ])
  const userId = await insertId(
    `insert into users (email, name, password_hash, role_id, branch_id)
     values ($1, 'Record actor', 'unused-test-hash', $2, $3) returning id`,
    [`record-${fixture}@example.invalid`, roleId, branchId],
  )
  const modules = ['branches', 'customers', 'suppliers', 'products', 'vehicles']
  user = {
    id: userId,
    email: `record-${fixture}@example.invalid`,
    name: 'Record actor',
    role: `Record role ${fixture}`,
    branchId,
    branch: 'Record North',
    isCrossBranch: true,
    permissions: [
      ...modules.flatMap((module) => [`${module}.read`, `${module}.create`, `${module}.update`]),
      'audit.read',
      'inventory.read',
      'sales.read',
      'employees.read',
    ],
  }
})

afterAll(async () => {
  await pool.end()
})

describe('managed business record lifecycle', () => {
  it('initializes missing stock on reactivation without replacing existing inventory', async () => {
    const branch = await createModuleRecord(
      'branches',
      { name: 'Reactivated Yard', code: `active-${fixture}` },
      context(),
    )
    await updateModuleRecord('branches', branch.id!, { status: 'Inactive' }, context())
    const product = await createModuleRecord(
      'products',
      {
        name: 'Reactivation material',
        sku: `active-${fixture}`,
        category: 'Test materials',
        unit: 'bag',
        unitPrice: '0',
      },
      context(),
    )
    const count = async () => {
      const result = await pool.query<{ id: string }>(
        'select id from inventory where branch_id=$1 and product_id=$2',
        [branch.id, product.id],
      )
      return result.rows
    }
    expect(await count()).toEqual([])
    await updateModuleRecord('branches', branch.id!, { status: 'Active' }, context())
    const initial = await count()
    expect(initial).toHaveLength(1)
    await updateModuleRecord('products', product.id!, { status: 'Inactive' }, context())
    const nextBranch = await createModuleRecord(
      'branches',
      { name: 'New reactivation yard', code: `next-${fixture}` },
      context(),
    )
    const missing = await pool.query(
      'select id from inventory where branch_id=$1 and product_id=$2',
      [nextBranch.id, product.id],
    )
    expect(missing.rowCount).toBe(0)
    await updateModuleRecord('products', product.id!, { status: 'Active' }, context())
    expect(await count()).toEqual(initial)
    const initialized = await pool.query(
      'select quantity, reserved_quantity from inventory where branch_id=$1 and product_id=$2',
      [nextBranch.id, product.id],
    )
    expect(initialized.rows).toEqual([{ quantity: '0.000', reserved_quantity: '0.000' }])
    const scoped = { ...user, isCrossBranch: false, branchId: branch.id! }
    await expect(getModuleRecord('branches', branch.id!, scoped)).rejects.toMatchObject({
      status: 403,
    })
    const detail = await getModuleRecord('branches', branch.id!, user)
    expect(detail.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'created branches' })]),
    )
  })

  it('sorts product prices numerically and searches contact phones', async () => {
    for (const price of ['100.00', '9.50', '25.00']) {
      await createModuleRecord(
        'products',
        {
          name: `Numeric sort ${fixture} ${price}`,
          sku: `sort-${fixture}-${price}`,
          category: 'Materials',
          unit: 'kg',
          unitPrice: price,
        },
        context(),
      )
    }
    const listed = await listModuleRecords('products', user, {
      search: `Numeric sort ${fixture}`,
      sort: 'Unit price',
      order: 'asc',
    })
    expect(listed.data.map((row) => row.unitPrice)).toEqual(['9.50', '25.00', '100.00'])
    const customer = await createModuleRecord(
      'customers',
      { branchId, name: 'Phone search customer', phone: `555-${fixture}` },
      context(),
    )
    const contacts = await listModuleRecords('customers', user, { search: `555-${fixture}` })
    expect(contacts.data).toMatchObject([{ id: customer.id, Phone: `555-${fixture}` }])
  })

  it('creates, reads, edits, deactivates, and archives a branch with stored contact fields', async () => {
    const branch = await createModuleRecord(
      'branches',
      {
        name: 'Service Yard',
        code: `yard-${fixture}`,
        managerName: 'Maya',
        phone: '555-0199',
        address: 'Yard road',
        email: 'yard@example.invalid',
      },
      context(),
    )
    const listed = await listModuleRecords('branches', user, { search: `yard-${fixture}` })
    expect(listed.data).toMatchObject([{ id: branch.id, Code: `yard-${fixture}` }])
    const detail = await getModuleRecord('branches', branch.id!, user)
    expect(detail).toMatchObject({
      id: branch.id,
      address: 'Yard road',
      email: 'yard@example.invalid',
      managerName: 'Maya',
      status: 'Active',
    })

    const updated = await updateModuleRecord(
      'branches',
      branch.id!,
      { phone: '', email: '', status: 'Inactive' },
      context(),
    )
    expect(updated).toMatchObject({ phone: null, email: null, status: 'Inactive' })
    const archived = await archiveModuleRecord('branches', branch.id!, context())
    expect(archived.archivedAt).toBeTruthy()
    await expect(getModuleRecord('branches', branch.id!, user)).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
    })
    const audit = await pool.query<{ action: string }>(
      "select action from audit_logs where entity_type = 'branches' and entity_id = $1 order by created_at",
      [branch.id],
    )
    expect(audit.rows.map((row) => row.action)).toContain('archived branches')
  })

  it('keeps branch updates within assignment and blocks archiving an assigned branch', async () => {
    const scoped = { ...user, isCrossBranch: false }
    await expect(
      updateModuleRecord(
        'branches',
        otherBranchId,
        { name: 'Wrong scope' },
        { ...context(), user: scoped },
      ),
    ).rejects.toMatchObject({ code: 'MANAGEMENT_FORBIDDEN' })
    await expect(getModuleRecord('branches', otherBranchId, scoped)).rejects.toMatchObject({
      code: 'MANAGEMENT_FORBIDDEN',
    })
    await expect(
      archiveModuleRecord('branches', branchId, { ...context(), user: scoped }),
    ).rejects.toMatchObject({ code: 'MANAGEMENT_FORBIDDEN' })
    await expect(listModuleRecords('branches', scoped, {})).rejects.toMatchObject({
      code: 'MANAGEMENT_FORBIDDEN',
    })
  })

  it('validates supplier references, exposes product stock, and preserves referenced records', async () => {
    const supplier = await createModuleRecord(
      'suppliers',
      {
        name: 'Steel Source',
        contactName: 'Sal',
        email: 'sal@example.invalid',
        phone: '555-0188',
        category: 'Steel',
      },
      context(),
    )
    const options = await getProductOptions(user)
    expect(options.suppliers).toContainEqual({ id: supplier.id, name: 'Steel Source' })
    await expect(
      createModuleRecord(
        'products',
        {
          name: 'Bad supply',
          sku: `bad-${fixture}`,
          category: 'Steel',
          unit: 'piece',
          unitPrice: 10,
          supplierId: randomUUID(),
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SUPPLIER' })

    const product = await createModuleRecord(
      'products',
      {
        name: 'Steel beam',
        sku: `beam-${fixture}`,
        category: 'Steel',
        unit: 'piece',
        unitPrice: 123.45,
        description: 'Test steel specification',
        supplierId: supplier.id,
      },
      context(),
    )
    await expect(archiveModuleRecord('suppliers', supplier.id!, context())).rejects.toMatchObject({
      code: 'RECORD_IN_USE',
    })
    const detail = await getModuleRecord('products', product.id!, user)
    expect(detail).toMatchObject({
      id: product.id,
      unitPrice: '123.45',
      description: 'Test steel specification',
      supplierId: supplier.id,
      supplierName: 'Steel Source',
    })
    expect((detail.related as { inventory: unknown[] }).inventory).toEqual(
      expect.arrayContaining([
        { branchId, branchName: 'Record North', quantity: '0.000', reorderLevel: '0.000' },
      ]),
    )
    await pool.query('update inventory set quantity = 2 where product_id = $1 and branch_id = $2', [
      product.id,
      branchId,
    ])
    await expect(archiveModuleRecord('products', product.id!, context())).rejects.toMatchObject({
      code: 'RECORD_IN_USE',
    })
    await pool.query('update inventory set quantity = 0 where product_id = $1 and branch_id = $2', [
      product.id,
      branchId,
    ])
    await updateModuleRecord(
      'products',
      product.id!,
      { unitPrice: '125.50', supplierId: '' },
      context(),
    )
    const detached = await getModuleRecord('products', product.id!, user)
    expect(detached).toMatchObject({ unitPrice: '125.50', supplierId: null, supplierName: null })
    await archiveModuleRecord('products', product.id!, context())
    await archiveModuleRecord('suppliers', supplier.id!, context())
  })

  it('keeps open customer orders and validates vehicle dates/status before archiving', async () => {
    const customer = await createModuleRecord(
      'customers',
      {
        branchId,
        name: 'Build Client',
        contactName: 'Pat',
        email: 'pat@example.invalid',
        phone: '555-0177',
        location: 'North',
      },
      context(),
    )
    const orderId = await insertId(
      `insert into orders (order_number, customer_id, branch_id, created_by)
       values ($1, $2, $3, $4) returning id`,
      [`REC-${fixture}`, customer.id, branchId, user.id],
    )
    await expect(archiveModuleRecord('customers', customer.id!, context())).rejects.toMatchObject({
      code: 'RECORD_IN_USE',
    })
    await pool.query("update orders set status = 'Completed' where id = $1", [orderId])
    await archiveModuleRecord('customers', customer.id!, context())

    const vehicle = await createVehicle(
      {
        name: 'Flatbed',
        plateNumber: `PL-${fixture}`,
        vehicleType: 'Truck',
        branchId,
        nextServiceAt: '2026-11-05',
      },
      context(),
    )
    await updateVehicle(vehicle.id, { nextServiceAt: null }, context())
    await changeVehicleStatus(vehicle.id, 'Unavailable', context())
    const detail = await getVehicleDetail(vehicle.id, user)
    expect(detail.vehicle).toMatchObject({ status: 'Unavailable', nextServiceAt: null })
    await archiveVehicle(vehicle.id, context())
    const list = await listFleetRecords('vehicles', { search: `PL-${fixture}` }, user)
    expect(list.total).toBe(0)
  })

  it('scopes customer lists and lifecycle access by branch and rejects cross-branch order assignment', async () => {
    const isolationSearch = `isolation-${fixture}`
    const customerA = await createModuleRecord(
      'customers',
      { branchId, name: `Branch A customer ${isolationSearch}` },
      context(),
    )
    const customerB = await createModuleRecord(
      'customers',
      { branchId: otherBranchId, name: `Branch B customer ${isolationSearch}` },
      context(),
    )
    const branchUser = { ...user, isCrossBranch: false, permissions: user.permissions }
    expect(branchUser.branchId).toBe(branchId)
    const customerOwnership = await pool.query<{ id: string; branch_id: string }>(
      'select id::text, branch_id::text from customers where id = any($1::uuid[]) order by id',
      [[customerA.id, customerB.id]],
    )
    expect(customerOwnership.rows).toHaveLength(2)
    expect(customerOwnership.rows).toEqual(
      expect.arrayContaining([
        { id: customerA.id, branch_id: branchId },
        { id: customerB.id, branch_id: otherBranchId },
      ]),
    )
    const ownRows = await listModuleRecords('customers', branchUser, {
      search: isolationSearch,
    })
    expect(ownRows.data.map((row) => [row.id, row.branchId])).toEqual([[customerA.id, branchId]])
    await expect(getModuleRecord('customers', customerB.id!, branchUser)).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
    })
    await expect(
      updateModuleRecord(
        'customers',
        customerB.id!,
        { name: 'Cross-branch change' },
        { ...context(), user: branchUser },
      ),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' })
    await expect(
      archiveModuleRecord('customers', customerB.id!, { ...context(), user: branchUser }),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' })
    await expect(
      listModuleRecords('customers', branchUser, { branchId: otherBranchId }),
    ).rejects.toMatchObject({ code: 'BRANCH_FORBIDDEN' })

    const forgedCreate = await createModuleRecord(
      'customers',
      { branchId: otherBranchId, name: `Server-scoped customer ${isolationSearch}` },
      { ...context(), user: branchUser },
    )
    const storedBranch = await pool.query<{ branch_id: string }>(
      'select branch_id::text from customers where id=$1',
      [forgedCreate.id],
    )
    expect(storedBranch.rows[0]?.branch_id).toBe(branchId)

    const adminRows = await listModuleRecords('customers', user, {
      search: isolationSearch,
      branchId: otherBranchId,
    })
    expect(adminRows.data.map((row) => row.id)).toEqual([customerB.id])

    const productId = await insertId(
      'insert into products (name, sku, category, unit, unit_price) values ($1,$2,$3,$4,$5) returning id',
      [`Isolation item ${fixture}`, `ISO-${fixture}`, 'Test', 'each', '1.00'],
    )
    await pool.query('insert into inventory(product_id,branch_id,quantity) values($1,$2,2)', [
      productId,
      branchId,
    ])
    await expect(
      placeOrder(
        { customerId: customerB.id!, branchId, items: [{ productId, quantity: 1 }] },
        {
          userId: user.id,
          customerBranchScope: branchId,
          ipAddress: null,
          requestId: null,
        },
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' })
  })

  it('rejects unauthorized edits and malformed updates before touching PostgreSQL', async () => {
    const reader = { ...user, permissions: ['customers.read'] }
    await expect(
      updateModuleRecord(
        'customers',
        randomUUID(),
        { name: 'Nope' },
        { ...context(), user: reader },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      updateModuleRecord('customers', randomUUID(), { unknown: 'x' }, context()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      updateModuleRecord('products', randomUUID(), { unitPrice: '10.123' }, context()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(getProductOptions(reader)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
