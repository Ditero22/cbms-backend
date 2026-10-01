import { z } from 'zod'
import { productPriceSchema } from './record-money.schema.js'

export const managedModuleIds = ['branches', 'customers', 'suppliers', 'products'] as const

export type ManagedModuleId = (typeof managedModuleIds)[number]

export function isManagedModule(moduleId: string): moduleId is ManagedModuleId {
  return (managedModuleIds as readonly string[]).includes(moduleId)
}

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()
const requiredText = (min: number, max: number) => z.string().trim().min(min).max(max).optional()
const optionalEmail = z
  .union([z.string().trim().max(254).pipe(z.email()), z.literal(''), z.null()])
  .optional()
const activeStatus = z.enum(['Active', 'Inactive']).optional()

export const updateRecordSchemas = {
  branches: z
    .object({
      name: requiredText(2, 120),
      code: z
        .string()
        .trim()
        .min(2)
        .max(24)
        .regex(/^[a-z0-9-]+$/i)
        .optional(),
      managerName: optionalText(180),
      phone: optionalText(40),
      email: z
        .union([z.string().trim().max(254).pipe(z.email()), z.literal(''), z.null()])
        .optional(),
      address: optionalText(400),
      status: activeStatus,
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.'),
  customers: z
    .object({
      name: requiredText(2, 180),
      contactName: optionalText(180),
      email: optionalEmail,
      phone: optionalText(40),
      location: optionalText(240),
      status: activeStatus,
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.'),
  suppliers: z
    .object({
      name: requiredText(2, 180),
      contactName: optionalText(180),
      email: optionalEmail,
      phone: optionalText(40),
      category: optionalText(120),
      paymentTerms: optionalText(120),
      status: activeStatus,
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.'),
  products: z
    .object({
      name: requiredText(2, 180),
      sku: requiredText(2, 80),
      category: requiredText(2, 120),
      unit: requiredText(1, 40),
      unitPrice: productPriceSchema.optional(),
      description: optionalText(2000),
      supplierId: z.union([z.uuid(), z.literal(''), z.null()]).optional(),
      status: activeStatus,
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.'),
}

export const managedStatusValues: Record<ManagedModuleId, readonly string[]> = {
  branches: ['Active', 'Inactive'],
  customers: ['Active', 'Inactive'],
  suppliers: ['Active', 'Inactive'],
  products: ['Active', 'Inactive'],
}
