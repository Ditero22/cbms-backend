import { z } from 'zod'
import { moneyToCents } from '@/shared/domain/fixed-point.js'

const text = (max: number) => z.string().trim().max(max).nullable().optional()
const date = z.iso.date().nullable().optional()
export const decimal = z
  .string()
  .trim()
  .regex(/^\d{1,11}(?:\.\d{1,3})?$/)
export const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/)
const vehicleFields = {
  branchId: z.uuid().optional(),
  name: z.string().trim().min(2).max(120),
  plateNumber: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .transform((value) => value.toUpperCase()),
  vehicleType: z.string().trim().min(2).max(80),
  brand: text(80),
  model: text(80),
  year: z.number().int().min(1900).max(2200).nullable().optional(),
  color: text(60),
  fuelType: text(60),
  odometer: decimal.nullable().optional(),
  capacityValue: decimal
    .refine((value) => Number(value) > 0)
    .nullable()
    .optional(),
  capacityUnit: text(40),
  defaultDriverId: z.uuid().nullable().optional(),
  registrationExpiresOn: date,
  insuranceProvider: text(180),
  insuranceReference: text(180),
  insuranceExpiresOn: date,
  nextServiceAt: z
    .union([z.iso.date(), z.iso.datetime({ offset: true })])
    .nullable()
    .optional(),
  notes: text(2000),
}
export const vehicleSchema = z.object(vehicleFields).strict()
export const updateVehicleSchema = z
  .object(vehicleFields)
  .omit({ branchId: true })
  .partial()
  .strict()
export const vehicleStatusSchema = z
  .object({ status: z.enum(['Available', 'Under Maintenance', 'Unavailable']) })
  .strict()
export const assignmentSchema = z
  .object({
    vehicleId: z.uuid(),
    driverId: z.uuid(),
    branchId: z.uuid(),
    deliveryId: z.uuid().optional(),
    destination: z.string().trim().min(2).max(500),
    purpose: z.string().trim().min(2).max(240),
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
    startOdometer: decimal.optional(),
    notes: text(2000),
  })
  .strict()
export const assignmentActionSchema = z
  .object({ endOdometer: decimal.optional(), notes: text(2000) })
  .strict()
const maintenanceFields = {
  maintenanceType: z.string().trim().min(2).max(120),
  description: z.string().trim().min(2).max(500),
  problemReported: text(1000),
  startedOn: date,
  serviceProvider: text(180),
  contactPerson: text(180),
  laborCost: money,
  partsCost: money,
  otherCost: money,
  receiptReference: text(180),
  notes: text(2000),
}
export const maintenanceSchema = z.object({ branchId: z.uuid(), ...maintenanceFields }).strict()
export const updateMaintenanceSchema = z.object(maintenanceFields).partial().strict()
export const maintenanceActionSchema = z.object({ startedOn: date, completedOn: date }).strict()
const allowanceFields = {
  workerId: z.uuid(),
  branchId: z.uuid(),
  assignmentId: z.uuid().nullable().optional(),
  deliveryId: z.uuid().nullable().optional(),
  paymentType: z.enum([
    'Trip allowance',
    'Delivery allowance',
    'Meal allowance',
    'Fuel allowance',
    'Cash advance',
    'Reimbursement',
    'Other',
  ]),
  amount: money.refine((value) => moneyToCents(value) > 0n, 'Amount must be positive.'),
  paymentTiming: z.enum(['Immediate', 'After trip', 'Scheduled payday', 'Pending release']),
  method: z.enum(['Cash', 'GCash', 'Bank Transfer', 'Payroll', 'Other']),
  referenceNumber: text(180),
  notes: text(2000),
}
export const allowanceSchema = z.object(allowanceFields).strict()
export const updateAllowanceSchema = z.object(allowanceFields).partial().strict()
export const receiveAllowanceSchema = z
  .object({
    receivedAt: z.iso.datetime({ offset: true }),
    acknowledgement: text(1000),
    proofAttachmentId: z.uuid().optional(),
  })
  .strict()
export type VehicleInput = z.infer<typeof vehicleSchema>
export type AssignmentInput = z.infer<typeof assignmentSchema>
export type MaintenanceInput = z.infer<typeof maintenanceSchema>
export type AllowanceInput = z.infer<typeof allowanceSchema>
