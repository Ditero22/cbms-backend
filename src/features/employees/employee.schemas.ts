import { z } from 'zod'

const employeeFields = {
  employeeNumber: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(180),
  position: z.string().trim().min(2).max(120),
  branchId: z.uuid(),
  email: z.email().optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(400).nullable().optional(),
  hiredAt: z.iso.date().optional(),
  isDriver: z.boolean().optional(),
  licenseNumber: z.string().trim().max(80).nullable().optional(),
  licenseClassification: z.string().trim().max(180).nullable().optional(),
  licenseExpiresOn: z.iso.date().nullable().optional(),
  driverAvailability: z.enum(['Available', 'Unavailable']).optional(),
  emergencyContactName: z.string().trim().max(180).nullable().optional(),
  emergencyContactPhone: z.string().trim().max(40).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}

export const createEmployeeSchema = z.object(employeeFields).strict()

export const updateEmployeeSchema = z
  .object({
    ...employeeFields,
    hiredAt: z.iso.date().nullable().optional(),
    status: z.enum(['Active', 'Inactive']),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.')

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>
