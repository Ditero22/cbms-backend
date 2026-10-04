import { createHash } from 'node:crypto'
import { hashPassword } from '@/shared/security/password.js'
import { env } from '@/config/env.js'
import { pool } from './client.js'
import { permissionKeys } from './permissions.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import { adjustInventory } from '@/features/inventory/inventory.service.js'
import { placeOrder, getOrderDetail } from '@/features/orders/order.service.js'
import { recordPayment } from '@/features/payments/payment.service.js'
import { createDelivery, updateDeliveryStatus } from '@/features/deliveries/delivery.service.js'
import { completeOrder } from '@/features/orders/order-lifecycle.service.js'
import { createPayrollRun } from '@/features/payroll/payroll.service.js'
import type { CreatePayrollRunInput } from '@/features/payroll/payroll.schemas.js'
import {
  expectedSampleEmployeeCounts,
  hasExpectedSampleEmployeeDistribution,
  isCompatibleSamplePayrollEntryCount,
} from './sample-data-rules.js'

const requiredDatabaseName = 'cbms_dev'
function stableUuid(seed: string) {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
const branchFixtures = [
  {
    code: 'BR-001',
    name: 'Branch I',
    manager: 'Mikaela Santos',
    address: 'Barangay San Roque, Antipolo City, Rizal',
    phone: '+63 917 555 0101',
    employees: [
      ['EMP-BR001-001', 'Mikaela Santos', 'Branch Manager', 'mikaela.santos'],
      ['EMP-BR001-002', 'Paolo Reyes', 'Staff', 'paolo.reyes'],
      ['EMP-BR001-003', 'Noel Mendoza', 'Driver', 'noel.mendoza'],
      ['EMP-BR001-004', 'Ramon Dela Cruz', 'Driver', 'ramon.delacruz'],
      ['EMP-BR001-005', 'Elias Navarro', 'Driver', 'elias.navarro'],
      ['EMP-BR001-006', 'Jun Arceo', 'Driver', 'jun.arceo'],
      ['EMP-BR001-007', 'Marvin Bautista', 'Driver', 'marvin.bautista'],
      ['EMP-BR001-008', 'Andres Flores', 'Site Worker', 'andres.flores'],
      ['EMP-BR001-009', 'Rogelio Cruz', 'Site Worker', 'rogelio.cruz'],
      ['EMP-BR001-010', 'Nestor Ramos', 'Site Worker', 'nestor.ramos'],
      ['EMP-BR001-011', 'Dante Villanueva', 'Site Worker', 'dante.villanueva'],
      ['EMP-BR001-012', 'Joel Mercado', 'Site Worker', 'joel.mercado'],
      ['EMP-BR001-013', 'Rico Salazar', 'Laborer', 'rico.salazar'],
    ],
  },
  {
    code: 'BR-002',
    name: 'Branch II',
    manager: 'Bianca Flores',
    address: 'Barangay Poblacion, Santa Rosa City, Laguna',
    phone: '+63 917 555 0202',
    employees: [
      ['EMP-BR002-001', 'Bianca Flores', 'Branch Manager', 'bianca.flores'],
      ['EMP-BR002-002', 'Luis Garcia', 'Staff', 'luis.garcia'],
      ['EMP-BR002-003', 'Tomas Aguilar', 'Driver', 'tomas.aguilar'],
      ['EMP-BR002-004', 'Rafael Lim', 'Driver', 'rafael.lim'],
      ['EMP-BR002-005', 'Cesar Bautista', 'Driver', 'cesar.bautista'],
      ['EMP-BR002-006', 'Arturo Soriano', 'Driver', 'arturo.soriano'],
      ['EMP-BR002-007', 'Benjie Castillo', 'Driver', 'benjie.castillo'],
      ['EMP-BR002-008', 'Isko Ramos', 'Site Worker', 'isko.ramos'],
      ['EMP-BR002-009', 'Renato Valdez', 'Site Worker', 'renato.valdez'],
      ['EMP-BR002-010', 'Omar Santiago', 'Site Worker', 'omar.santiago'],
      ['EMP-BR002-011', 'Rico Panganiban', 'Site Worker', 'rico.panganiban'],
      ['EMP-BR002-012', 'Alvin Manalo', 'Site Worker', 'alvin.manalo'],
      ['EMP-BR002-013', 'Arnel Bautista', 'Laborer', 'arnel.bautista'],
    ],
  },
  {
    code: 'BR-003',
    name: 'Branch III',
    manager: 'Gabriel Navarro',
    address: 'Barangay San Isidro, San Fernando City, Pampanga',
    phone: '+63 917 555 0303',
    employees: [
      ['EMP-BR003-001', 'Gabriel Navarro', 'Branch Manager', 'gabriel.navarro'],
      ['EMP-BR003-002', 'Therese Dizon', 'Staff', 'therese.dizon'],
      ['EMP-BR003-003', 'Emilio Ramos', 'Driver', 'emilio.ramos'],
      ['EMP-BR003-004', 'Felix Mendoza', 'Driver', 'felix.mendoza'],
      ['EMP-BR003-005', 'Arnold Cruz', 'Driver', 'arnold.cruz'],
      ['EMP-BR003-006', 'Dennis Bautista', 'Driver', 'dennis.bautista'],
      ['EMP-BR003-007', 'Gilbert Angeles', 'Driver', 'gilbert.angeles'],
      ['EMP-BR003-008', 'Carmelo Garcia', 'Site Worker', 'carmelo.garcia'],
      ['EMP-BR003-009', 'Danilo Lim', 'Site Worker', 'danilo.lim'],
      ['EMP-BR003-010', 'Rogelio Reyes', 'Site Worker', 'rogelio.reyes'],
      ['EMP-BR003-011', 'Ruben Villanueva', 'Site Worker', 'ruben.villanueva'],
      ['EMP-BR003-012', 'Nicanor David', 'Site Worker', 'nicanor.david'],
      ['EMP-BR003-013', 'Mario Dela Cruz', 'Laborer', 'mario.delacruz'],
    ],
  },
] as const

const customerFixtures = [
  ['Harborview Homes Development', 'Alicia Soriano', 'alicia.soriano', 'Pasig City, Metro Manila'],
  [
    'Northfield Builders Cooperative',
    'Marco Villanueva',
    'marco.villanueva',
    'Quezon City, Metro Manila',
  ],
  ['Luntian Ridge Construction', 'Cecilia Ramos', 'cecilia.ramos', 'Antipolo City, Rizal'],
  ['Pilar Community Housing', 'Renato Dizon', 'renato.dizon', 'Santa Rosa City, Laguna'],
  ['Golden Arch Renovation Works', 'Mina Bautista', 'mina.bautista', 'Calamba City, Laguna'],
  ['San Isidro Estates', 'Rafael Mercado', 'rafael.mercado', 'San Fernando City, Pampanga'],
  ['Cedarline Property Group', 'Irene Castillo', 'irene.castillo', 'Makati City, Metro Manila'],
  ['Maple Crest Contractors', 'Enrico Flores', 'enrico.flores', 'Muntinlupa City, Metro Manila'],
  [
    'Riverside School Facilities',
    'Jocelyn Garcia',
    'jocelyn.garcia',
    'Marikina City, Metro Manila',
  ],
  ['Bright Path Infrastructure', 'Manuel Cruz', 'manuel.cruz', 'Bacoor City, Cavite'],
] as const

const productFixtures = [
  {
    sku: 'BC-TEST-CEM-040',
    name: 'Portland Cement 40 kg',
    category: 'Cement',
    unit: 'bag',
    price: '285.00',
    stock: [180, 42, 96],
    reorder: [50, 50, 50],
  },
  {
    sku: 'BC-TEST-RBR-010',
    name: 'Deformed Rebar 10 mm x 6 m',
    category: 'Steel',
    unit: 'length',
    price: '365.00',
    stock: [75, 90, 18],
    reorder: [20, 20, 20],
  },
  {
    sku: 'BC-TEST-AGG-034',
    name: 'Washed Gravel 3/4 inch',
    category: 'Aggregates',
    unit: 'cubic meter',
    price: '1550.00',
    stock: [24, 16, 20],
    reorder: [5, 5, 5],
  },
  {
    sku: 'BC-TEST-PLY-012',
    name: 'Marine Plywood 1/2 inch',
    category: 'Lumber',
    unit: 'sheet',
    price: '940.00',
    stock: [26, 80, 31],
    reorder: [12, 12, 12],
  },
  {
    sku: 'BC-TEST-CHB-004',
    name: 'Concrete Hollow Block 4 inch',
    category: 'Masonry',
    unit: 'piece',
    price: '20.50',
    stock: [450, 380, 520],
    reorder: [100, 100, 100],
  },
] as const

const orderFixtures = [
  {
    key: 'BR001-UNPAID',
    branchCode: 'BR-001',
    customerIndex: 0,
    productSku: 'BC-TEST-CEM-040',
    quantity: 15,
    payment: 'none',
    destination: 'Harborview Homes, Antipolo site',
  },
  {
    key: 'BR002-PARTIAL',
    branchCode: 'BR-002',
    customerIndex: 3,
    productSku: 'BC-TEST-PLY-012',
    quantity: 10,
    payment: '3000.00',
    destination: 'Pilar Housing, Santa Rosa site',
  },
  {
    key: 'BR003-PAID',
    branchCode: 'BR-003',
    customerIndex: 5,
    productSku: 'BC-TEST-RBR-010',
    quantity: 8,
    payment: 'full',
    destination: 'San Isidro Estates, Pampanga site',
  },
  {
    key: 'BR001-COMPLETED',
    branchCode: 'BR-001',
    customerIndex: 2,
    productSku: 'BC-TEST-AGG-034',
    quantity: 2,
    payment: 'full',
    destination: 'Luntian Ridge, Antipolo job site',
  },
] as const

function assertLocalDevelopmentTarget() {
  if (process.env.NODE_ENV !== 'development' || !env.isDevelopment) {
    throw new Error('Sample data is only allowed when NODE_ENV=development.')
  }
  if (process.env.CBMS_ALLOW_SAMPLE_SEED !== 'true') {
    throw new Error('Set CBMS_ALLOW_SAMPLE_SEED=true to confirm the local sample-data operation.')
  }
  const target = new URL(env.databaseUrl)
  if (
    !['localhost', '127.0.0.1', '::1'].includes(target.hostname) ||
    target.pathname.replace(/^\//, '') !== requiredDatabaseName
  ) {
    throw new Error(
      `Sample data can only be written to the local ${requiredDatabaseName} database.`,
    )
  }
  if (!env.sampleUserPassword) {
    throw new Error('Set CBMS_SAMPLE_USER_PASSWORD to a strong development-only password first.')
  }
}

async function seedBranches() {
  const ids = new Map<string, string>()
  for (const branch of branchFixtures) {
    await pool.query(
      `insert into branches (name, code, manager_name, phone, address, status)
       values ($1,$2,$3,$4,$5,'Active') on conflict (code) do nothing`,
      [branch.name, branch.code, branch.manager, branch.phone, branch.address],
    )
    const result = await pool.query<{ id: string; name: string }>(
      'select id, name from branches where code=$1 and deleted_at is null',
      [branch.code],
    )
    if (!result.rows[0] || result.rows[0].name !== branch.name) {
      throw new Error(`Branch code ${branch.code} is already used by a different record.`)
    }
    ids.set(branch.code, result.rows[0].id)
  }
  return ids
}

async function seedRoles() {
  const managerPermissions = [
    'branches.read',
    'employees.read',
    'customers.read',
    'suppliers.read',
    'products.read',
    'inventory.read',
    'orders.read',
    'payments.read',
    'deliveries.read',
    'vehicles.read',
    'expenses.read',
    'payroll.read',
    'sales.read',
    'orders.create',
    'orders.complete',
    'orders.cancel',
    'payments.create',
    'deliveries.create',
    'deliveries.update',
    'payroll.create',
    'payroll.update',
    'payroll.process',
    'payroll.pay',
    'payroll.receive',
  ]
  const staffPermissions = [
    'customers.read',
    'products.read',
    'inventory.read',
    'orders.read',
    'payments.read',
    'deliveries.read',
    'sales.read',
    'orders.create',
    'payments.create',
  ]
  for (const permission of permissionKeys) {
    await pool.query(
      'insert into permissions (key, description) values ($1,$2) on conflict (key) do nothing',
      [permission, `Permission to use ${permission.replaceAll('.', ' ')}.`],
    )
  }
  const ids = new Map<string, string>()
  for (const [name, description, grants] of [
    ['Sample Branch Manager', 'Development-only branch-scoped manager role.', managerPermissions],
    ['Sample Branch Staff', 'Development-only branch-scoped staff role.', staffPermissions],
  ] as const) {
    await pool.query(
      'insert into roles (name, description, is_system) values ($1,$2,0) on conflict (name) do nothing',
      [name, description],
    )
    const result = await pool.query<{ id: string }>('select id from roles where name=$1', [name])
    const id = result.rows[0]?.id
    if (!id) throw new Error(`Could not prepare role ${name}.`)
    const existingGrants = await pool.query<{ permissionKey: string }>(
      'select permission_key as "permissionKey" from role_permissions where role_id=$1',
      [id],
    )
    const allowedGrants = new Set<string>(grants)
    const elevatedGrant = existingGrants.rows.find((row) => !allowedGrants.has(row.permissionKey))
    if (elevatedGrant) {
      throw new Error(
        `The existing ${name} role contains unexpected permissions; no sample accounts were created.`,
      )
    }
    ids.set(name, id)
    for (const permission of grants) {
      await pool.query(
        'insert into role_permissions (role_id, permission_key) values ($1,$2) on conflict do nothing',
        [id, permission],
      )
    }
  }
  return ids
}

async function seedEmployeesAndAccounts(
  branchIds: Map<string, string>,
  roleIds: Map<string, string>,
) {
  const passwordHash = await hashPassword(env.sampleUserPassword)
  const accounts = new Map<string, { id: string; branchId: string; employeeName: string }>()
  for (const branch of branchFixtures) {
    const branchId = branchIds.get(branch.code)
    if (!branchId) throw new Error(`Missing ${branch.code}.`)
    for (const [index, employee] of branch.employees.entries()) {
      const [employeeNumber, name, position, emailStem] = employee
      const driver = position === 'Driver'
      const email = `${emailStem}@example.com`
      await pool.query(
        `insert into employees
           (employee_number,name,email,phone,position,branch_id,status,hired_at,is_driver,license_number,license_classification,license_expires_on)
         values ($1,$2,$3,$4,$5,$6,'Active',$7,$8,$9,$10,$11) on conflict (employee_number) do nothing`,
        [
          employeeNumber,
          name,
          email,
          `+63 917 555 ${branch.code.slice(-1)}${String(index + 11).padStart(2, '0')}`,
          position,
          branchId,
          new Date(Date.UTC(2024, (index + branch.code.charCodeAt(4)) % 12, 1)),
          driver ? 1 : 0,
          driver ? `TST-${branch.code.slice(-1)}-${String(index).padStart(3, '0')}` : null,
          driver ? 'Professional' : null,
          driver ? '2028-12-31' : null,
        ],
      )
      const stored = await pool.query<{
        id: string
        name: string
        position: string
        branchId: string
      }>(
        'select id,name,position,branch_id as "branchId" from employees where employee_number=$1 and deleted_at is null',
        [employeeNumber],
      )
      const row = stored.rows[0]
      if (!row || row.name !== name || row.position !== position || row.branchId !== branchId) {
        throw new Error(`Employee fixture key ${employeeNumber} conflicts with existing data.`)
      }
      if (index > 1) continue
      const roleName = index === 0 ? 'Sample Branch Manager' : 'Sample Branch Staff'
      const roleId = roleIds.get(roleName)
      if (!roleId) throw new Error(`Missing role ${roleName}.`)
      await pool.query(
        `insert into users (email,name,password_hash,role_id,branch_id,is_cross_branch,status)
         values ($1,$2,$3,$4,$5,0,'Active') on conflict (email) do nothing`,
        [email, name, passwordHash, roleId, branchId],
      )
      const userResult = await pool.query<{
        id: string
        name: string
        roleId: string
        branchId: string | null
        status: string
      }>(
        'select id,name,role_id as "roleId",branch_id as "branchId",status from users where email=$1 and deleted_at is null',
        [email],
      )
      const user = userResult.rows[0]
      if (
        !user ||
        user.name !== name ||
        user.roleId !== roleId ||
        user.branchId !== branchId ||
        user.status !== 'Active'
      ) {
        throw new Error(`Sample login ${email} conflicts with an existing account.`)
      }
      if (index === 0) accounts.set(branch.code, { id: user.id, branchId, employeeName: name })
    }
  }
  return accounts
}

async function seedCustomers() {
  const ids: string[] = []
  for (const [name, contactName, emailStem, location] of customerFixtures) {
    const email = `${emailStem}@example.com`
    const inserted = await pool.query<{ id: string }>(
      `insert into customers (name,contact_name,email,phone,location,status)
       select $1,$2,$3,$4,$5,'Active'
       where not exists (select 1 from customers where name=$1 and deleted_at is null)
       returning id`,
      [
        name,
        contactName,
        email,
        '+63 2 8555 01' + String(ids.length + 10).padStart(2, '0'),
        location,
      ],
    )
    const row =
      inserted.rows[0] ??
      (
        await pool.query<{ id: string; email: string }>(
          'select id,email from customers where name=$1 and deleted_at is null order by created_at limit 1',
          [name],
        )
      ).rows[0]
    if (!row || ('email' in row && row.email !== email))
      throw new Error(`Customer fixture ${name} conflicts with existing data.`)
    ids.push(row.id)
  }
  return ids
}

async function seedProducts() {
  const ids = new Map<string, string>()
  for (const product of productFixtures) {
    await pool.query(
      `insert into products (name,sku,category,unit,unit_price,status)
       values ($1,$2,$3,$4,$5,'Active') on conflict (sku) do nothing`,
      [product.name, product.sku, product.category, product.unit, product.price],
    )
    const stored = await pool.query<{ id: string; name: string }>(
      'select id,name from products where sku=$1 and deleted_at is null',
      [product.sku],
    )
    if (!stored.rows[0] || stored.rows[0].name !== product.name)
      throw new Error(`Product SKU ${product.sku} conflicts with existing data.`)
    ids.set(product.sku, stored.rows[0].id)
  }
  return ids
}

async function seedInventory(
  branchIds: Map<string, string>,
  productIds: Map<string, string>,
  actors: Map<string, { id: string; branchId: string; employeeName: string }>,
) {
  for (const branch of branchFixtures) {
    const branchId = branchIds.get(branch.code)!
    const actor = actors.get(branch.code)!
    for (const product of productFixtures) {
      const productId = productIds.get(product.sku)!
      const quantity =
        product.stock[branchFixtures.findIndex((candidate) => candidate.code === branch.code)]!
      const exists = await pool.query<{ quantity: string }>(
        'select quantity::text as quantity from inventory where product_id=$1 and branch_id=$2',
        [productId, branchId],
      )
      if (!exists.rows[0]) {
        await adjustInventory(
          {
            productId,
            branchId,
            quantityDelta: quantity,
            requestKey: stableUuid(`sample-stock:${branch.code}:${product.sku}`),
            note: 'Initial sample inventory for Materials Supply Operations & Finance.',
          },
          {
            userId: actor.id,
            ipAddress: null,
            requestId: `sample-stock:${branch.code}:${product.sku}`,
          },
        )
      }
      await pool.query(
        `insert into inventory (product_id,branch_id,quantity,reorder_level)
         values ($1,$2,0,$3) on conflict (product_id,branch_id) do update set reorder_level=excluded.reorder_level,updated_at=now()`,
        [
          productId,
          branchId,
          product.reorder[branchFixtures.findIndex((candidate) => candidate.code === branch.code)],
        ],
      )
    }
  }
}

function managerUser(
  actor: { id: string; branchId: string; employeeName: string },
  branchCode: string,
): AuthenticatedUser {
  return {
    id: actor.id,
    name: actor.employeeName,
    email: `${branchCode.toLowerCase()}-manager@example.com`,
    role: 'Sample Branch Manager',
    branchId: actor.branchId,
    branch: branchCode,
    isCrossBranch: false,
    permissions: [
      'sales.read',
      'orders.create',
      'orders.complete',
      'orders.cancel',
      'payments.create',
      'deliveries.create',
      'deliveries.update',
      'payroll.create',
      'payroll.update',
      'payroll.process',
      'payroll.pay',
      'payroll.receive',
    ],
  }
}

async function findSeededOrder(requestId: string) {
  const result = await pool.query<{ id: string }>(
    `select entity_id as id from audit_logs where action='created order' and entity_type='order' and request_id=$1 limit 1`,
    [requestId],
  )
  return result.rows[0]?.id
}

async function seedOrders(
  branchIds: Map<string, string>,
  customerIds: string[],
  productIds: Map<string, string>,
  actors: Map<string, { id: string; branchId: string; employeeName: string }>,
) {
  for (const fixture of orderFixtures) {
    const actor = actors.get(fixture.branchCode)!
    const branchId = branchIds.get(fixture.branchCode)!
    const requestId = `cbms-sample-v1:${fixture.key}`
    let orderId = await findSeededOrder(requestId)
    if (!orderId) {
      const order = await placeOrder(
        {
          customerId: customerIds[fixture.customerIndex]!,
          branchId,
          items: [{ productId: productIds.get(fixture.productSku)!, quantity: fixture.quantity }],
        },
        { userId: actor.id, customerBranchScope: branchId, ipAddress: null, requestId },
      )
      orderId = order.id
    }
    const actorUser = managerUser(actor, fixture.branchCode)
    let detail = await getOrderDetail(orderId, actorUser)
    const paymentContext = {
      userId: actor.id,
      branchId,
      isCrossBranch: false,
      ipAddress: null,
      requestId: `cbms-sample-v1:payment:${fixture.key}`,
    }
    if (fixture.payment !== 'none' && detail.status !== 'Completed') {
      const amount = fixture.payment === 'full' ? detail.balance : fixture.payment
      if (Number(amount) > 0) {
        await recordPayment(
          {
            orderId,
            amount,
            method: 'Bank transfer',
            requestKey: (
              {
                'BR002-PARTIAL': '3a6b0f1e-2501-4e61-a002-001000000002',
                'BR003-PAID': '3a6b0f1e-2501-4e61-a003-001000000003',
                'BR001-COMPLETED': '3a6b0f1e-2501-4e61-a001-001000000004',
              } as Record<string, string>
            )[fixture.key],
          },
          paymentContext,
        )
      }
      detail = await getOrderDetail(orderId, actorUser)
    }
    if (fixture.key === 'BR001-COMPLETED' && detail.status !== 'Completed') {
      const item = detail.items[0]
      if (!item) throw new Error('Completed sample order has no items.')
      const existingDelivery = await pool.query<{ id: string; status: string }>(
        'select id,status from deliveries where order_id=$1 order by created_at limit 1',
        [orderId],
      )
      let deliveryId = existingDelivery.rows[0]?.id
      let deliveryStatus = existingDelivery.rows[0]?.status
      if (!deliveryId) {
        const delivery = await createDelivery(
          {
            orderId,
            destination: fixture.destination,
            driverName: 'Noel Mendoza',
            items: [{ orderItemId: item.id, quantity: item.quantity }],
          },
          { ...paymentContext, permissions: actorUser.permissions },
        )
        deliveryId = delivery.id
        deliveryStatus = delivery.status
      }
      if (deliveryStatus === 'Preparing' || deliveryStatus === 'Scheduled') {
        await updateDeliveryStatus(deliveryId, 'In Transit', {
          ...paymentContext,
          permissions: actorUser.permissions,
        })
        deliveryStatus = 'In Transit'
      }
      if (deliveryStatus === 'In Transit')
        await updateDeliveryStatus(deliveryId, 'Delivered', {
          ...paymentContext,
          permissions: actorUser.permissions,
        })
      detail = await getOrderDetail(orderId, actorUser)
      if (detail.status !== 'Completed')
        await completeOrder(orderId, {
          user: actorUser,
          ipAddress: null,
          requestId: `cbms-sample-v1:complete:${fixture.key}`,
        })
    }
  }
}

function previousMonthPeriod() {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
  const format = (date: Date) => date.toISOString().slice(0, 10)
  return { start: format(start), end: format(end) }
}

async function seedPayroll(
  branchIds: Map<string, string>,
  actors: Map<string, { id: string; branchId: string; employeeName: string }>,
) {
  const period = previousMonthPeriod()
  for (const branch of branchFixtures) {
    const branchId = branchIds.get(branch.code)!
    const actor = actors.get(branch.code)!
    const employeeResult = await pool.query<{
      id: string
      employeeNumber: string
      name: string
      position: string
    }>(
      `select id,employee_number as "employeeNumber",name,position from employees
       where branch_id=$1 and employee_number like $2 and deleted_at is null order by employee_number`,
      [branchId, `EMP-${branch.code.replace('-', '')}-%`],
    )
    if (employeeResult.rows.length !== expectedSampleEmployeeCounts.perBranch) {
      throw new Error(`Could not prepare the full sample payroll for ${branch.code}.`)
    }
    const entries = employeeResult.rows.map(
      (employee, index): CreatePayrollRunInput['entries'][number] => {
        if (employee.position === 'Branch Manager') {
          return {
            employeeId: employee.id,
            payBasis: 'Salary' as const,
            units: '1',
            rate: '42000.00',
            adjustments: [],
          }
        }
        if (employee.position === 'Staff') {
          return {
            employeeId: employee.id,
            payBasis: 'Salary' as const,
            units: '1',
            rate: '27000.00',
            adjustments: [],
          }
        }
        if (employee.position === 'Driver') {
          return {
            employeeId: employee.id,
            payBasis: 'Per-trip pay' as const,
            units: String(14 + (index % 5)),
            rate: (650 + (index % 3) * 25).toFixed(2),
            adjustments:
              index === 2
                ? [
                    {
                      kind: 'earning' as const,
                      type: 'Overtime' as const,
                      amount: '1500.00',
                      notes: 'Weekend delivery work',
                    },
                  ]
                : [],
          }
        }
        return {
          employeeId: employee.id,
          payBasis: 'Daily wage' as const,
          units: String(20 + (index % 3)),
          rate: (760 + (index % 4) * 10).toFixed(2),
          adjustments:
            index === 8
              ? [
                  {
                    kind: 'deduction' as const,
                    type: 'Cash advance recovery' as const,
                    amount: '500.00',
                    notes: 'Sample authorized recovery',
                  },
                ]
              : [],
        }
      },
    )
    const existing = await pool.query<{ id: string }>(
      `select id from payroll_runs where branch_id=$1 and period_start::date=$2::date and period_end::date=$3::date`,
      [branchId, period.start, period.end],
    )
    if (existing.rows[0]) {
      if (existing.rows.length !== 1)
        throw new Error(
          `Multiple payroll runs already exist for the sample period at ${branch.code}.`,
        )
      const saved = await pool.query<{
        employeeId: string
        payBasis: string
        units: string
        rate: string
        additionalPay: string
        deductions: string
      }>(
        `select employee_id as "employeeId",pay_basis as "payBasis",units::text,rate::text,
                additional_pay::text as "additionalPay",deductions::text
         from payroll_entries where payroll_run_id=$1 order by employee_id`,
        [existing.rows[0].id],
      )
      const matchesEntries = (expectedEntries: typeof entries) =>
        saved.rows.length === expectedEntries.length &&
        expectedEntries.every((entry) =>
          saved.rows.some(
            (row) =>
              row.employeeId === entry.employeeId &&
              row.payBasis === entry.payBasis &&
              Number(row.units) === Number(entry.units) &&
              Number(row.rate) === Number(entry.rate) &&
              Number(row.additionalPay) ===
                entry.adjustments
                  .filter((adjustment) => adjustment.kind === 'earning')
                  .reduce((sum, adjustment) => sum + Number(adjustment.amount), 0) &&
              Number(row.deductions) ===
                entry.adjustments
                  .filter((adjustment) => adjustment.kind === 'deduction')
                  .reduce((sum, adjustment) => sum + Number(adjustment.amount), 0),
          ),
        )
      const matchesCurrentCohort = matchesEntries(entries)
      const matchesPriorCohort =
        isCompatibleSamplePayrollEntryCount(saved.rows.length) &&
        saved.rows.length < entries.length &&
        matchesEntries(entries.slice(0, saved.rows.length))
      if (!matchesCurrentCohort && !matchesPriorCohort) {
        throw new Error(
          `A payroll run already occupies the sample period at ${branch.code}; it was left untouched.`,
        )
      }
      continue
    }
    await createPayrollRun(
      { branchId, periodStart: period.start, periodEnd: period.end, entries },
      {
        user: managerUser(actor, branch.code),
        ipAddress: null,
        requestId: `cbms-sample-v1:payroll:${branch.code}`,
      },
    )
  }
}

async function verify(
  branchIds: Map<string, string>,
  roleIds: Map<string, string>,
  customerIds: string[],
  productIds: Map<string, string>,
) {
  const period = previousMonthPeriod()
  const employeeCounts = await pool.query<{ code: string; count: number }>(
    `select b.code,count(e.id)::int as count from branches b left join employees e on e.branch_id=b.id and e.employee_number like 'EMP-BR%'
     where b.code=any($1::text[]) group by b.code order by b.code`,
    [branchFixtures.map((branch) => branch.code)],
  )
  if (
    employeeCounts.rows.length !== 3 ||
    employeeCounts.rows.some((row) => row.count !== expectedSampleEmployeeCounts.perBranch)
  )
    throw new Error(
      `Sample employee verification failed; expected ${expectedSampleEmployeeCounts.perBranch} sample employees per branch.`,
    )
  for (const branch of branchFixtures) {
    const roles = await pool.query<{ position: string; count: number }>(
      `select position,count(*)::int as count from employees where branch_id=$1 and employee_number like $2 group by position`,
      [branchIds.get(branch.code), `EMP-${branch.code.replace('-', '')}-%`],
    )
    const positions = roles.rows.flatMap(({ position, count }) =>
      Array.from({ length: count }, () => position),
    )
    if (!hasExpectedSampleEmployeeDistribution(positions))
      throw new Error(`Sample position verification failed for ${branch.code}.`)
  }
  const users = await pool.query<{ count: number }>(
    `select count(*)::int as count from users where email like '%@example.com' and role_id=any($1::uuid[]) and deleted_at is null`,
    [[roleIds.get('Sample Branch Manager'), roleIds.get('Sample Branch Staff')]],
  )
  const customers = await pool.query<{ count: number }>(
    `select count(*)::int as count from customers where id=any($1::uuid[]) and deleted_at is null`,
    [customerIds],
  )
  const products = await pool.query<{ count: number }>(
    `select count(*)::int as count from products where id=any($1::uuid[]) and deleted_at is null`,
    [[...productIds.values()]],
  )
  const orderStates = await pool.query<{ status: string; count: number }>(
    `select o.status,count(*)::int as count from orders o join audit_logs a on a.entity_id=o.id and a.request_id like 'cbms-sample-v1:BR%' and a.action='created order' group by o.status`,
  )
  const orderPayments = await pool.query<{
    key: string
    status: string
    total: string
    paid: string
  }>(
    `select a.request_id as key,o.status,o.total_amount::text as total,
            coalesce(sum(p.amount) filter (where p.status='Paid'),0)::text as paid
     from audit_logs a join orders o on o.id=a.entity_id
     left join payments p on p.order_id=o.id
     where a.action='created order' and a.request_id like 'cbms-sample-v1:BR%'
     group by a.request_id,o.status,o.total_amount order by a.request_id`,
  )
  const payrollSummary = await pool.query<{ runs: number; entries: number; regularPay: number }>(
    `select count(distinct r.id)::int as runs,count(e.id)::int as entries,
            count(e.id) filter (where e.regular_pay > 0)::int as "regularPay"
     from payroll_runs r join payroll_entries e on e.payroll_run_id=r.id
     join branches b on b.id=r.branch_id
     where b.code=any($1::text[]) and r.period_start::date=$2::date and r.period_end::date=$3::date
       and e.employee_number like 'EMP-BR%'`,
    [branchFixtures.map((branch) => branch.code), period.start, period.end],
  )
  const paymentStateByOrder = new Map(
    orderPayments.rows.map((row) => {
      const paid = Number(row.paid)
      const total = Number(row.total)
      return [
        row.key.split(':').at(-1)!,
        {
          orderStatus: row.status,
          paymentStatus: paid === 0 ? 'Unpaid' : paid < total ? 'Partial' : 'Paid',
        },
      ]
    }),
  )
  if (
    branchIds.size !== 3 ||
    Number(users.rows[0]?.count) !== 6 ||
    Number(customers.rows[0]?.count) !== 10 ||
    Number(products.rows[0]?.count) !== 5
  )
    throw new Error('Sample data cohort verification did not match the required counts.')
  if (
    paymentStateByOrder.size !== 4 ||
    paymentStateByOrder.get('BR001-UNPAID')?.paymentStatus !== 'Unpaid' ||
    paymentStateByOrder.get('BR002-PARTIAL')?.paymentStatus !== 'Partial' ||
    paymentStateByOrder.get('BR003-PAID')?.paymentStatus !== 'Paid' ||
    ['Completed', 'Cancelled'].includes(
      paymentStateByOrder.get('BR001-UNPAID')?.orderStatus ?? '',
    ) ||
    ['Completed', 'Cancelled'].includes(
      paymentStateByOrder.get('BR002-PARTIAL')?.orderStatus ?? '',
    ) ||
    ['Completed', 'Cancelled'].includes(paymentStateByOrder.get('BR003-PAID')?.orderStatus ?? '') ||
    paymentStateByOrder.get('BR001-COMPLETED')?.orderStatus !== 'Completed'
  ) {
    throw new Error('Sample order and payment workflow verification failed.')
  }
  if (
    Number(payrollSummary.rows[0]?.runs) !== 3 ||
    ![36, expectedSampleEmployeeCounts.total].includes(Number(payrollSummary.rows[0]?.entries)) ||
    Number(payrollSummary.rows[0]?.regularPay) !== Number(payrollSummary.rows[0]?.entries)
  ) {
    throw new Error(
      'Sample payroll verification failed; expected three compatible runs with regular pay for every entry.',
    )
  }
  console.info(
    JSON.stringify({
      verified: true,
      sampleBranches: branchIds.size,
      sampleEmployees: expectedSampleEmployeeCounts.total,
      employeeDistributionPerBranch: expectedSampleEmployeeCounts.positions,
      sampleLoginAccounts: Number(users.rows[0]?.count ?? 0),
      sampleCustomers: Number(customers.rows[0]?.count ?? 0),
      sampleProducts: Number(products.rows[0]?.count ?? 0),
      sampleOrderStates: Object.fromEntries(orderStates.rows.map((row) => [row.status, row.count])),
      sampleOrderPayments: Object.fromEntries(paymentStateByOrder),
      samplePayrollRuns: Number(payrollSummary.rows[0]?.runs ?? 0),
      samplePayrollEntries: Number(payrollSummary.rows[0]?.entries ?? 0),
      entriesWithRegularPay: Number(payrollSummary.rows[0]?.regularPay ?? 0),
    }),
  )
}

async function seed() {
  assertLocalDevelopmentTarget()
  const branchIds = await seedBranches()
  const roleIds = await seedRoles()
  const actors = await seedEmployeesAndAccounts(branchIds, roleIds)
  const customerIds = await seedCustomers()
  const productIds = await seedProducts()
  await seedInventory(branchIds, productIds, actors)
  await seedOrders(branchIds, customerIds, productIds, actors)
  await seedPayroll(branchIds, actors)
  await verify(branchIds, roleIds, customerIds, productIds)
}

try {
  await seed()
} finally {
  await pool.end()
}
