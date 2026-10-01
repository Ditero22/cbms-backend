import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import app from '@/app.js'
import {
  createSessionToken,
  hashSessionToken,
  sessionCookieName,
} from '@/shared/security/session.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/database/client.js'
import { permissionKeys } from '@/database/permissions.js'
import type { AuthenticatedUser } from '@/shared/types/auth.js'
import {
  createEmployee,
  updateEmployee,
  archiveEmployee,
  getEmployeeDetail,
} from '@/features/employees/employee.service.js'
import {
  createVehicle,
  updateVehicle,
  getVehicleDetail,
  changeVehicleStatus,
  archiveVehicle,
} from '@/features/fleet/vehicle.service.js'
import {
  createAssignment,
  transitionAssignment,
  getAssignmentDetail,
} from '@/features/fleet/assignment.service.js'
import {
  createMaintenance,
  transitionMaintenance,
  updateMaintenance,
  getMaintenanceDetail,
} from '@/features/fleet/maintenance.service.js'
import {
  createAllowance,
  transitionAllowance,
  updateAllowance,
  getAllowanceDetail,
} from '@/features/fleet/allowance.service.js'
import { listFleetRecords } from '@/features/fleet/fleet-list.repository.js'
import { fleetOptions } from '@/features/fleet/fleet-options.repository.js'
import { placeOrder } from '@/features/orders/order.service.js'
import { createDelivery, updateDeliveryStatus } from '@/features/deliveries/delivery.service.js'
import { uploadProof } from '@/features/attachments/attachment.service.js'
import { removeStoredProof } from '@/features/attachments/attachment.storage.js'

let actor: AuthenticatedUser
let branchId: string
let otherBranchId: string
let customerId: string
let productId: string
const ownedProofKeys: string[] = []
const context = () => ({ user: actor, ipAddress: null, requestId: null })
const deliveryContext = () => ({
  userId: actor.id,
  customerBranchScope: branchId,
  branchId,
  isCrossBranch: true,
  permissions: permissionKeys,
  ipAddress: null,
  requestId: null,
})
async function insertId(sql: string, values: unknown[]) {
  const result = await pool.query<{ id: string }>(sql, values)
  if (!result.rows[0]) throw new Error('Fixture failed')
  return result.rows[0].id
}
async function resources(resourceBranchId = branchId) {
  const token = randomUUID().slice(0, 8)
  const worker = await createEmployee(
    {
      employeeNumber: `DRV-${token}`,
      name: 'Juan Dela Cruz',
      position: 'Delivery Driver',
      branchId: resourceBranchId,
      isDriver: true,
      licenseNumber: `LICENSE-${token}`,
      licenseClassification: 'Professional',
      licenseExpiresOn: '2099-12-31',
      driverAvailability: 'Available',
    },
    context(),
  )
  const vehicle = await createVehicle(
    {
      name: 'Water truck',
      plateNumber: `TRK-${token}`,
      vehicleType: 'Water Truck',
      branchId: resourceBranchId,
      capacityValue: '5000',
      capacityUnit: 'L',
      odometer: '100',
      defaultDriverId: worker.id,
    },
    context(),
  )
  return { workerId: worker.id, vehicleId: vehicle.id }
}
async function historicalAllowance(
  workerId: string,
  values: { paymentType: string; amount: string; paymentTiming: string; method: string },
) {
  const id = await insertId(
    `insert into driver_allowances(reference,worker_id,branch_id,payment_type,amount,payment_timing,method,status,created_by)
     values($1,$2,$3,$4,$5,$6,$7,'Pending',$8) returning id`,
    [
      `LEGACY-${randomUUID()}`,
      workerId,
      branchId,
      values.paymentType,
      values.amount,
      values.paymentTiming,
      values.method,
      actor.id,
    ],
  )
  await pool.query(
    `insert into audit_logs(user_id,branch_id,action,entity_type,entity_id,new_value)
     values($1,$2,'created driver allowance','driver-allowance',$3,$4)`,
    [actor.id, branchId, id, values],
  )
  return { id, status: 'Pending' as const }
}
beforeAll(async () => {
  const token = randomUUID().slice(0, 8)
  const roleId = await insertId('insert into roles(name) values($1) returning id', [
    `Fleet test ${token}`,
  ])
  branchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    'Fleet North',
    `fn-${token}`,
  ])
  otherBranchId = await insertId('insert into branches(name,code) values($1,$2) returning id', [
    'Fleet South',
    `fs-${token}`,
  ])
  const id = await insertId(
    `insert into users(name,email,password_hash,role_id,branch_id,is_cross_branch) values('Fleet actor',$1,'unused',$2,$3,1) returning id`,
    [`fleet-${token}@example.invalid`, roleId, branchId],
  )
  actor = {
    id,
    name: 'Fleet actor',
    email: `fleet-${token}@example.invalid`,
    role: 'Fleet test',
    branch: 'Fleet North',
    branchId,
    isCrossBranch: true,
    permissions: permissionKeys,
  }
  customerId = await insertId(
    `insert into customers(name,branch_id) values('Fleet customer',$1) returning id`,
    [branchId],
  )
  productId = await insertId(
    `insert into products(name,sku,category,unit,unit_price) values('Fleet water',$1,'Water','L',10) returning id`,
    [`FLEET-${token}`],
  )
  await pool.query(`insert into inventory(product_id,branch_id,quantity) values($1,$2,100)`, [
    productId,
    branchId,
  ])
})
afterAll(async () => {
  for (const key of ownedProofKeys) await removeStoredProof(key)
  await pool.end()
})

describe('Fleet resources, maintenance and financial lifecycle', () => {
  it('preserves employees as drivers and formats truck capacity without replacing legacy text', async () => {
    const { workerId, vehicleId } = await resources()
    const detail = await getEmployeeDetail(workerId, actor)
    expect(detail.employee).toMatchObject({
      isDriver: true,
      licenseClassification: 'Professional',
      driverAvailability: 'Available',
    })
    const vehicle = await getVehicleDetail(vehicleId, actor)
    expect(vehicle.vehicle).toMatchObject({
      status: 'Available',
      capacityValue: '5000.000',
      capacityUnit: 'L',
      defaultDriverId: workerId,
      defaultDriverName: 'Juan Dela Cruz',
    })
    const list = await listFleetRecords('vehicles', { search: 'Water truck' }, actor)
    expect(list.data.find((row: Record<string, string>) => row.id === vehicleId)?.Capacity).toBe(
      '5,000 L',
    )
    const noAudit = { ...actor, permissions: ['employees.read'] }
    expect((await getEmployeeDetail(workerId, noAudit)).history).toEqual([])
    for (const [value, unit] of [
      ['5000', null],
      [null, 'L'],
      ['-1', 'L'],
      ['5000', ''],
    ]) {
      await expect(
        pool.query('update vehicles set capacity_value=$2,capacity_unit=$3 where id=$1', [
          vehicleId,
          value,
          unit,
        ]),
      ).rejects.toMatchObject({ code: '23514' })
    }
    expect((await getVehicleDetail(vehicleId, actor)).vehicle.capacityValue).toBe('5000.000')
  })
  it('isolates vehicle records and selectors by branch and validates branch relationships', async () => {
    const north = await resources(branchId)
    const south = await resources(otherBranchId)
    const northManager = { ...actor, isCrossBranch: false, role: 'Branch Manager' }

    const branchList = await listFleetRecords(
      'vehicles',
      {
        page: 1,
        limit: 100,
        search: '',
        order: 'asc',
        branchId: otherBranchId,
      },
      northManager,
    )
    expect(branchList.data.map((row: { id: string }) => row.id)).toContain(north.vehicleId)
    expect(branchList.data.map((row: { id: string }) => row.id)).not.toContain(south.vehicleId)

    const options = await fleetOptions(northManager)
    expect(options.vehicles.map((vehicle) => vehicle.id)).toContain(north.vehicleId)
    expect(options.vehicles.map((vehicle) => vehicle.id)).not.toContain(south.vehicleId)
    await expect(getVehicleDetail(south.vehicleId, northManager)).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
    })
    await expect(
      updateVehicle(
        south.vehicleId,
        { notes: 'changed cross-branch' },
        {
          ...context(),
          user: northManager,
        },
      ),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' })
    await expect(
      changeVehicleStatus(south.vehicleId, 'Unavailable', {
        ...context(),
        user: northManager,
      }),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' })
    await expect(
      archiveVehicle(south.vehicleId, { ...context(), user: northManager }),
    ).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
    })
    await expect(
      createVehicle(
        {
          name: 'Spoofed truck',
          plateNumber: `SP-${randomUUID().slice(0, 8)}`,
          vehicleType: 'Truck',
          branchId: otherBranchId,
        },
        { ...context(), user: northManager },
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_FORBIDDEN' })
    await expect(
      createVehicle(
        {
          name: 'Wrong driver truck',
          plateNumber: `WD-${randomUUID().slice(0, 8)}`,
          vehicleType: 'Truck',
          branchId,
          defaultDriverId: south.workerId,
        },
        { ...context(), user: northManager },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_DRIVER' })
    await expect(
      createAssignment(
        {
          vehicleId: south.vehicleId,
          driverId: north.workerId,
          branchId,
          destination: 'North worksite',
          purpose: 'Branch isolation check',
        },
        { ...context(), user: northManager },
      ),
    ).rejects.toMatchObject({ code: 'VEHICLE_NOT_FOUND' })

    const adminAll = await listFleetRecords(
      'vehicles',
      { page: 1, limit: 100, search: '', order: 'asc' },
      actor,
    )
    const adminBranch = await listFleetRecords(
      'vehicles',
      {
        page: 1,
        limit: 100,
        search: '',
        order: 'asc',
        branchId: otherBranchId,
      },
      actor,
    )
    expect(adminAll.data.map((row: { id: string }) => row.id)).toContain(south.vehicleId)
    expect(adminBranch.data.map((row: { id: string }) => row.id)).toContain(south.vehicleId)
    expect(adminBranch.data.map((row: { id: string }) => row.id)).not.toContain(north.vehicleId)

    await expect(
      listFleetRecords(
        'vehicles',
        { page: 1, limit: 25, search: '', order: 'asc' },
        {
          ...northManager,
          branchId: null,
        },
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_REQUIRED' })
  })
  it('enforces vehicle branch scope through authenticated HTTP routes', async () => {
    const north = await resources(branchId)
    const south = await resources(otherBranchId)
    const suffix = randomUUID().slice(0, 8)
    const roleId = await insertId('insert into roles(name) values($1) returning id', [
      `Fleet manager ${suffix}`,
    ])
    await pool.query(
      `insert into permissions(key,description)
       select key,key from unnest($1::text[]) as available(key)
       on conflict do nothing`,
      [permissionKeys],
    )
    await pool.query(
      `insert into role_permissions(role_id,permission_key)
       select $1, permission_key from unnest($2::text[]) as granted(permission_key)
       on conflict do nothing`,
      [roleId, ['vehicles.read', 'vehicles.create', 'vehicles.update', 'vehicles.assign']],
    )
    const managerId = await insertId(
      `insert into users(name,email,password_hash,role_id,branch_id)
       values('North manager',$1,'unused',$2,$3) returning id`,
      [`fleet-manager-${suffix}@example.invalid`, roleId, branchId],
    )
    const token = createSessionToken()
    const sessionId = await insertId(
      `insert into user_sessions(user_id,token_hash,expires_at)
       values($1,$2,now()+interval '1 hour') returning id`,
      [managerId, hashSessionToken(token)],
    )
    const server = app.listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('HTTP fixture server did not start')
      const base = `http://127.0.0.1:${address.port}/api/v1`
      const headers = {
        Cookie: `${sessionCookieName}=${token}`,
        'Content-Type': 'application/json',
      }

      const invalidReportOptions = await fetch(`${base}/reports/options?branchId=invalid`, {
        headers,
      })
      expect(invalidReportOptions.status).toBe(400)
      expect(await invalidReportOptions.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      })

      const list = await fetch(`${base}/vehicles?branchId=${otherBranchId}`, { headers })
      expect(list.status).toBe(200)
      const listed = (await list.json()) as { data: { id: string }[] }
      expect(listed.data.map((vehicle) => vehicle.id)).toContain(north.vehicleId)
      expect(listed.data.map((vehicle) => vehicle.id)).not.toContain(south.vehicleId)

      const options = await fetch(`${base}/vehicles/options`, { headers })
      expect(options.status).toBe(200)
      const choices = (await options.json()) as { vehicles: { id: string }[] }
      expect(choices.vehicles.map((vehicle) => vehicle.id)).toContain(north.vehicleId)
      expect(choices.vehicles.map((vehicle) => vehicle.id)).not.toContain(south.vehicleId)

      for (const [path, method, body] of [
        [`/vehicles/${south.vehicleId}`, 'GET', undefined],
        [`/vehicles/${south.vehicleId}`, 'PATCH', { notes: 'cross-branch edit' }],
        [`/vehicles/${south.vehicleId}/archive`, 'PATCH', {}],
        [
          '/vehicle-assignments',
          'POST',
          {
            vehicleId: south.vehicleId,
            driverId: north.workerId,
            branchId,
            destination: 'North worksite',
            purpose: 'Branch-scope API check',
          },
        ],
      ] as const) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        expect(response.status).toBe(404)
        await expect(response.json()).resolves.toMatchObject({
          error: { code: expect.stringMatching(/RECORD_NOT_FOUND|VEHICLE_NOT_FOUND/) },
        })
      }
      const foreignDriver = await fetch(`${base}/vehicle-assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          vehicleId: north.vehicleId,
          driverId: south.workerId,
          branchId,
          destination: 'North worksite',
          purpose: 'Foreign driver scope check',
        }),
      })
      expect(foreignDriver.status).toBe(409)
      await expect(foreignDriver.json()).resolves.toMatchObject({
        error: { code: 'DRIVER_UNAVAILABLE' },
      })

      const spoofedCreate = await fetch(`${base}/vehicles`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Spoofed branch truck',
          plateNumber: `HT-${suffix}`,
          vehicleType: 'Truck',
          branchId: otherBranchId,
        }),
      })
      expect(spoofedCreate.status).toBe(403)
      await expect(spoofedCreate.json()).resolves.toMatchObject({
        error: { code: 'BRANCH_FORBIDDEN' },
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await pool.query(`delete from user_sessions where id=$1`, [sessionId])
    }
  })
  it('reserves resources, rejects conflicting edits and releases vehicle with odometer on completion', async () => {
    const { workerId, vehicleId } = await resources()
    const assignment = await createAssignment(
      {
        vehicleId,
        driverId: workerId,
        branchId,
        destination: 'Jobsite',
        purpose: 'Water delivery',
        startOdometer: '100',
      },
      context(),
    )
    expect((await getVehicleDetail(vehicleId, actor)).vehicle.status).toBe('On Service')
    await expect(updateEmployee(workerId, { status: 'Inactive' }, context())).rejects.toMatchObject(
      { code: 'DEFAULT_DRIVER_IN_USE' },
    )
    await expect(archiveEmployee(workerId, context())).rejects.toMatchObject({
      code: 'DEFAULT_DRIVER_IN_USE',
    })
    await expect(archiveVehicle(vehicleId, context())).rejects.toMatchObject({
      code: 'RECORD_IN_USE',
    })
    await expect(
      changeVehicleStatus(vehicleId, 'Under Maintenance', context()),
    ).rejects.toMatchObject({ code: 'VEHICLE_ASSIGNED' })
    await transitionAssignment(assignment.id, 'start', {}, context())
    await expect(
      transitionAssignment(assignment.id, 'complete', { endOdometer: '99' }, context()),
    ).rejects.toMatchObject({ code: 'ODOMETER_INVALID' })
    await transitionAssignment(assignment.id, 'complete', { endOdometer: '150' }, context())
    expect((await getVehicleDetail(vehicleId, actor)).vehicle).toMatchObject({
      status: 'Available',
      odometer: '150.000',
    })
    expect((await getAssignmentDetail(assignment.id, actor)).assignment).toMatchObject({
      status: 'Completed',
      driverName: 'Juan Dela Cruz',
    })
  })
  it('serializes competing assignments across vehicles for the same driver', async () => {
    const first = await resources(),
      second = await resources()
    const attempts = await Promise.allSettled(
      [first.vehicleId, second.vehicleId].map((vehicleId) =>
        createAssignment(
          {
            vehicleId,
            driverId: first.workerId,
            branchId,
            destination: 'Jobsite',
            purpose: 'Delivery',
          },
          context(),
        ),
      ),
    )
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const rows = await pool.query(
      `select count(*)::int as total from vehicle_assignments where driver_id=$1 and status in ('Scheduled','Active')`,
      [first.workerId],
    )
    expect(rows.rows[0]?.total).toBe(1)
  })
  it('blocks inactive, unavailable and expired drivers and preserves unavailable legacy holds', async () => {
    const { workerId, vehicleId } = await resources()
    await updateEmployee(workerId, { driverAvailability: 'Unavailable' }, context())
    await expect(
      createAssignment(
        { vehicleId, driverId: workerId, branchId, destination: 'Site', purpose: 'Trip' },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' })
    await updateEmployee(
      workerId,
      { driverAvailability: 'Available', licenseExpiresOn: '2000-01-01' },
      context(),
    )
    await expect(
      createAssignment(
        { vehicleId, driverId: workerId, branchId, destination: 'Site', purpose: 'Trip' },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'DRIVER_LICENSE_EXPIRED' })
    await updateEmployee(workerId, { licenseExpiresOn: '2099-01-01' }, context())
    await changeVehicleStatus(vehicleId, 'Unavailable', context())
    await expect(
      createAssignment(
        { vehicleId, driverId: workerId, branchId, destination: 'Site', purpose: 'Trip' },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'VEHICLE_UNAVAILABLE' })
  })
  it('tracks repair costs and posts one Pending expense when maintenance completes', async () => {
    const { workerId, vehicleId } = await resources()
    const maintenance = await createMaintenance(
      vehicleId,
      {
        branchId,
        maintenanceType: 'Engine Repair',
        description: 'Repair engine',
        problemReported: 'Overheating',
        serviceProvider: 'Local repair shop',
        laborCost: '1500.10',
        partsCost: '2000.20',
        otherCost: '50.30',
      },
      context(),
    )
    await transitionMaintenance(maintenance.id, 'start', { startedOn: '2026-09-01' }, context())
    expect((await getVehicleDetail(vehicleId, actor)).currentMaintenance).toMatchObject({
      problemReported: 'Overheating',
      totalCost: '3550.60',
    })
    await expect(
      createAssignment(
        { vehicleId, driverId: workerId, branchId, destination: 'Site', purpose: 'Delivery' },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'VEHICLE_UNAVAILABLE' })
    const decisions = await Promise.allSettled(
      [1, 2].map(() =>
        transitionMaintenance(maintenance.id, 'complete', { completedOn: '2026-09-03' }, context()),
      ),
    )
    expect(decisions.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const detail = await getMaintenanceDetail(maintenance.id, actor)
    expect(detail.maintenance).toMatchObject({ status: 'Completed', totalCost: '3550.60' })
    const expense = await pool.query(`select amount::text,status from expenses where id=$1`, [
      detail.maintenance.expenseId,
    ])
    expect(expense.rows[0]).toEqual({ amount: '3550.60', status: 'Pending' })
    expect((await getVehicleDetail(vehicleId, actor)).totalMaintenanceCost).toBe('3550.60')
    expect((await getVehicleDetail(vehicleId, actor)).vehicle.status).toBe('Available')
    await expect(
      updateMaintenance(maintenance.id, { laborCost: '1' }, context()),
    ).rejects.toMatchObject({ code: 'MAINTENANCE_CLOSED' })
  })
  it('does not expose monetary maintenance to vehicle-only readers and enforces branch/action permission', async () => {
    const { vehicleId } = await resources()
    const maintenance = await createMaintenance(
      vehicleId,
      {
        branchId,
        maintenanceType: 'Inspection',
        description: 'Vehicle inspection',
        laborCost: '100',
        partsCost: '0',
        otherCost: '0',
      },
      context(),
    )
    const reader = { ...actor, permissions: ['vehicles.read', 'audit.read'] }
    expect((await getVehicleDetail(vehicleId, reader)).maintenance).toEqual([])
    await expect(getMaintenanceDetail(maintenance.id, reader)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      getMaintenanceDetail(maintenance.id, {
        ...actor,
        isCrossBranch: false,
        branchId: otherBranchId,
      }),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' })
    expect((await getVehicleDetail(vehicleId, { ...actor, isCrossBranch: false })).vehicle.id).toBe(
      vehicleId,
    )
  })
  it('preserves allowance approval, release, receipt evidence and one approved expense', async () => {
    const { workerId } = await resources()
    await expect(createAllowance({}, context())).rejects.toMatchObject({
      code: 'LEGACY_ALLOWANCE_RETIRED',
    })
    const allowance = await historicalAllowance(workerId, {
      paymentType: 'Trip allowance',
      amount: '1500.01',
      paymentTiming: 'Immediate',
      method: 'Cash',
    })
    await expect(transitionAllowance(allowance.id, 'release', {}, context())).rejects.toMatchObject(
      { code: 'INVALID_ALLOWANCE_TRANSITION' },
    )
    await transitionAllowance(allowance.id, 'approve', {}, context())
    await expect(updateAllowance(allowance.id, { amount: '1' }, context())).rejects.toMatchObject({
      code: 'ALLOWANCE_LOCKED',
    })
    const releases = await Promise.allSettled(
      [1, 2].map(() => transitionAllowance(allowance.id, 'release', {}, context())),
    )
    expect(releases.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const released = await getAllowanceDetail(allowance.id, actor)
    expect(released.allowance).toMatchObject({ status: 'Released', releasedByName: 'Fleet actor' })
    await expect(
      transitionAllowance(
        allowance.id,
        'receive',
        { receivedAt: new Date().toISOString() },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'RECEIPT_CONFIRMATION_REQUIRED' })
    await transitionAllowance(
      allowance.id,
      'receive',
      {
        receivedAt: new Date().toISOString(),
        acknowledgement: 'Worker signed acknowledgement ALW-1',
      },
      context(),
    )
    const received = await getAllowanceDetail(allowance.id, actor)
    expect(received.allowance).toMatchObject({ status: 'Received', confirmedByName: 'Fleet actor' })
    expect(received.history).toHaveLength(4)
    const expense = await pool.query(`select amount::text,status from expenses where id=$1`, [
      received.allowance.expenseId,
    ])
    expect(expense.rows[0]).toEqual({ amount: '1500.01', status: 'Approved' })
    await expect(transitionAllowance(allowance.id, 'cancel', {}, context())).rejects.toMatchObject({
      code: 'INVALID_ALLOWANCE_TRANSITION',
    })
  })
  it('rejects proof ownership mismatch and lower roles cannot approve, release or view other-branch payments', async () => {
    const { workerId } = await resources()
    const allowance = await historicalAllowance(workerId, {
      paymentType: 'Meal allowance',
      amount: '100',
      paymentTiming: 'After trip',
      method: 'GCash',
    })
    await expect(
      transitionAllowance(
        allowance.id,
        'approve',
        {},
        { ...context(), user: { ...actor, permissions: ['driver-allowances.create'] } },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await transitionAllowance(allowance.id, 'approve', {}, context())
    await transitionAllowance(allowance.id, 'release', {}, context())
    const proofId = await insertId(
      `insert into attachments(file_name,object_key,mime_type,file_size,uploaded_by,entity_type,entity_id) values('proof.png',$1,'image/png',100,$2,'driver-allowance',$3) returning id`,
      [`test/${randomUUID()}`, actor.id, randomUUID()],
    )
    await expect(
      transitionAllowance(
        allowance.id,
        'receive',
        { receivedAt: new Date().toISOString(), proofAttachmentId: proofId },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PROOF' })
    await pool.query(`update attachments set entity_id=$1 where id=$2`, [allowance.id, proofId])
    await expect(
      transitionAllowance(
        allowance.id,
        'receive',
        { receivedAt: new Date().toISOString(), proofAttachmentId: proofId },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'PROOF_NOT_FOUND' })
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=',
      'base64',
    )
    const proof = await uploadProof(
      { entityType: 'driver-allowance', entityId: allowance.id },
      'receipt.png',
      'image/png',
      bytes,
      context(),
    )
    const stored = await pool.query(`select object_key from attachments where id=$1`, [proof.id])
    ownedProofKeys.push(stored.rows[0].object_key)
    await transitionAllowance(
      allowance.id,
      'receive',
      { receivedAt: new Date().toISOString(), proofAttachmentId: proof.id },
      context(),
    )
    await expect(
      getAllowanceDetail(allowance.id, { ...actor, isCrossBranch: false, branchId: otherBranchId }),
    ).rejects.toMatchObject({ code: 'RECORD_NOT_FOUND' })
  })
  it('reserves and releases fleet inside existing delivery posting and prevents direct linked-trip mutations', async () => {
    const { workerId, vehicleId } = await resources()
    const order = await placeOrder(
      { customerId, branchId, items: [{ productId, quantity: 1 }] },
      deliveryContext(),
    )
    const items = await pool.query(`select id from order_items where order_id=$1`, [order.id])
    const delivery = await createDelivery(
      {
        orderId: order.id,
        destination: 'Fleet customer',
        driverId: workerId,
        vehicleId,
        items: [{ orderItemId: items.rows[0].id, quantity: '1' }],
      },
      deliveryContext(),
    )
    const assignment = await pool.query(`select id from vehicle_assignments where delivery_id=$1`, [
      delivery.id,
    ])
    expect((await getVehicleDetail(vehicleId, actor)).vehicle.status).toBe('On Service')
    await expect(
      transitionAssignment(assignment.rows[0].id, 'cancel', {}, context()),
    ).rejects.toMatchObject({ code: 'DELIVERY_MANAGED_ASSIGNMENT' })
    await updateDeliveryStatus(delivery.id, 'In Transit', deliveryContext())
    await updateDeliveryStatus(delivery.id, 'Delivered', deliveryContext(), { endOdometer: '120' })
    expect((await getAssignmentDetail(assignment.rows[0].id, actor)).assignment.status).toBe(
      'Completed',
    )
    expect((await getVehicleDetail(vehicleId, actor)).vehicle).toMatchObject({
      status: 'Available',
      odometer: '120.000',
    })
    const stock = await pool.query(
      `select quantity::text from inventory where product_id=$1 and branch_id=$2`,
      [productId, branchId],
    )
    expect(stock.rows[0]?.quantity).toBe('99.000')
  })
  it('preserves explicit maintenance holds and rejects impossible actual dates', async () => {
    const { vehicleId } = await resources()
    await changeVehicleStatus(vehicleId, 'Under Maintenance', context())
    const maintenance = await createMaintenance(
      vehicleId,
      {
        branchId,
        maintenanceType: 'Repair',
        description: 'Repair hold',
        laborCost: '0',
        partsCost: '0',
        otherCost: '0',
      },
      context(),
    )
    await expect(
      transitionMaintenance(maintenance.id, 'start', { startedOn: '2099-01-01' }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_MAINTENANCE_DATE' })
    await transitionMaintenance(maintenance.id, 'start', { startedOn: '2026-09-01' }, context())
    await expect(
      transitionMaintenance(maintenance.id, 'complete', { completedOn: '2026-08-01' }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_MAINTENANCE_DATE' })
    await transitionMaintenance(
      maintenance.id,
      'complete',
      { completedOn: '2026-09-02' },
      context(),
    )
    expect((await getVehicleDetail(vehicleId, actor)).vehicle.status).toBe('Under Maintenance')
    await changeVehicleStatus(vehicleId, 'Available', context())
    expect((await getVehicleDetail(vehicleId, actor)).vehicle.status).toBe('Available')
    expect((await getMaintenanceDetail(maintenance.id, actor)).maintenance.expenseId).toBeNull()
    await expect(
      pool.query(`update employees set license_expires_on='2026-02-30' where id=$1`, [
        (await resources()).workerId,
      ]),
    ).rejects.toBeTruthy()
  })
  it('paginates actual history without leaking scope or clearing record data', async () => {
    const { vehicleId } = await resources()
    for (let index = 0; index < 21; index++)
      await pool.query(
        `insert into audit_logs(user_id,entity_type,entity_id,action,new_value) values($1,'vehicles',$2,'test history',$3)`,
        [actor.id, vehicleId, { index }],
      )
    const first = await getVehicleDetail(vehicleId, actor, 1),
      second = await getVehicleDetail(vehicleId, actor, 2)
    expect(first.history).toHaveLength(20)
    expect(second.history).toHaveLength(2)
    expect(second.historyTotal).toBe(22)
    expect(new Set([...first.history, ...second.history].map((row) => row.id)).size).toBe(22)
  })
  it('keeps older activity reachable and current maintenance independent of the selected page', async () => {
    const { vehicleId } = await resources()
    const current = await insertId(
      `insert into vehicle_maintenance(reference,vehicle_id,branch_id,maintenance_type,description,status,created_by,created_at) values($1,$2,$3,'Repair','Old open repair','In Progress',$4,now()-interval '1 year') returning id`,
      [`PAGE-${randomUUID()}`, vehicleId, branchId, actor.id],
    )
    for (let index = 0; index < 21; index++)
      await pool.query(
        `insert into vehicle_maintenance(reference,vehicle_id,branch_id,maintenance_type,description,status,labor_cost,created_by) values($1,$2,$3,'Inspection','Completed inspection','Completed',1.01,$4)`,
        [`PAGE-${randomUUID()}`, vehicleId, branchId, actor.id],
      )
    const first = await getVehicleDetail(vehicleId, actor, 1, { maintenancePage: 1 })
    const second = await getVehicleDetail(vehicleId, actor, 1, { maintenancePage: 2 })
    expect(first.maintenance).toHaveLength(20)
    expect(second.maintenance).toHaveLength(2)
    expect(second.maintenanceTotal).toBe(22)
    expect(new Set([...first.maintenance, ...second.maintenance].map((row) => row.id)).size).toBe(
      22,
    )
    expect(first.currentMaintenance?.id).toBe(current)
    expect(second.currentMaintenance?.id).toBe(current)
    expect(second.totalMaintenanceCost).toBe('21.21')
    const limited = await getVehicleDetail(vehicleId, { ...actor, permissions: ['vehicles.read'] })
    expect(limited.maintenanceTotal).toBe(0)
    expect(limited.currentMaintenance).toBeNull()
  })
  it('whitelists HTTP delivery transition fields when completing a linked fleet assignment', async () => {
    const { workerId, vehicleId } = await resources()
    const order = await placeOrder(
      { customerId, branchId, items: [{ productId, quantity: 1 }] },
      deliveryContext(),
    )
    const items = await pool.query(`select id from order_items where order_id=$1`, [order.id])
    const delivery = await createDelivery(
      {
        orderId: order.id,
        destination: 'HTTP lifecycle',
        driverId: workerId,
        vehicleId,
        items: [{ orderItemId: items.rows[0].id, quantity: '1' }],
      },
      deliveryContext(),
    )
    await pool.query(
      `insert into role_permissions(role_id,permission_key) select role_id,'deliveries.update' from users where id=$1 on conflict do nothing`,
      [actor.id],
    )
    const token = createSessionToken()
    const sessionId = await insertId(
      `insert into user_sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id`,
      [actor.id, hashSessionToken(token)],
    )
    const server = app.listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('HTTP fixture server did not start')
      for (const status of ['In Transit', 'Delivered']) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/v1/deliveries/${delivery.id}/status`,
          {
            method: 'PATCH',
            headers: {
              Cookie: `${sessionCookieName}=${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              status,
              ...(status === 'Delivered'
                ? { endOdometer: '130', notes: 'Delivery handed over' }
                : {}),
            }),
          },
        )
        expect(response.status).toBe(200)
        expect((await response.json()).status).toBe(status)
      }
      const assignment = await pool.query(
        `select status,end_odometer::text,notes from vehicle_assignments where delivery_id=$1`,
        [delivery.id],
      )
      expect(assignment.rows[0]).toMatchObject({
        status: 'Completed',
        end_odometer: '130.000',
        notes: 'Delivery handed over',
      })
      expect((await getVehicleDetail(vehicleId, actor)).vehicle.status).toBe('Available')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await pool.query(`delete from user_sessions where id=$1`, [sessionId])
    }
  })
  it('rejects duplicate plate edits with a useful conflict without changing either vehicle', async () => {
    const first = await resources(),
      second = await resources()
    const original = (await getVehicleDetail(first.vehicleId, actor)).vehicle.plateNumber as string
    await expect(
      updateVehicle(second.vehicleId, { plateNumber: original }, context()),
    ).rejects.toMatchObject({ code: 'DUPLICATE_VEHICLE', status: 409 })
    expect((await getVehicleDetail(second.vehicleId, actor)).vehicle.plateNumber).not.toBe(original)
  })
})
