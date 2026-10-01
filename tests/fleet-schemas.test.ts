import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  assignmentSchema,
  maintenanceSchema,
  allowanceSchema,
  receiveAllowanceSchema,
  vehicleSchema,
} from '@/features/fleet/fleet.schemas.js'
describe('fleet input validation', () => {
  it('accepts configurable vehicle types and independent capacity units', () => {
    expect(
      vehicleSchema.safeParse({
        name: 'Dump truck',
        plateNumber: 'xyz-123',
        vehicleType: 'Custom equipment',
        capacityValue: '10',
        capacityUnit: 'm³',
      }).success,
    ).toBe(true)
  })
  it('rejects negative odometer and excessive precision', () => {
    expect(
      vehicleSchema.safeParse({
        name: 'Truck',
        plateNumber: 'ABC',
        vehicleType: 'Truck',
        odometer: '-1',
      }).success,
    ).toBe(false)
    expect(
      assignmentSchema.safeParse({
        vehicleId: randomUUID(),
        driverId: randomUUID(),
        branchId: randomUUID(),
        destination: 'Site',
        purpose: 'Trip',
        startOdometer: '1.0001',
      }).success,
    ).toBe(false)
  })
  it('rejects negative maintenance amounts', () => {
    expect(
      maintenanceSchema.safeParse({
        branchId: randomUUID(),
        maintenanceType: 'Repair',
        description: 'Repair truck',
        laborCost: '-1',
        partsCost: '0',
        otherCost: '0',
      }).success,
    ).toBe(false)
  })
  it('rejects zero, negative and imprecise allowance money', () => {
    for (const amount of ['0', '-1', '0.001'])
      expect(
        allowanceSchema.safeParse({
          workerId: randomUUID(),
          branchId: randomUUID(),
          paymentType: 'Trip',
          amount,
          paymentTiming: 'Immediate',
          method: 'Cash',
        }).success,
      ).toBe(false)
  })
  it('requires valid receipt date and rejects unsupported financial fields', () => {
    expect(
      receiveAllowanceSchema.safeParse({ receivedAt: 'bad', acknowledgement: 'Signed' }).success,
    ).toBe(false)
    expect(
      allowanceSchema.safeParse({
        workerId: randomUUID(),
        branchId: randomUUID(),
        paymentType: 'Trip',
        amount: '1',
        paymentTiming: 'Immediate',
        method: 'Cash',
        status: 'Received',
      }).success,
    ).toBe(false)
  })
})
