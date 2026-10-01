import { z } from 'zod'
import { productPriceSchema } from './record-money.schema.js'

export const createSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  customers: z
    .object({
      branchId: z.uuid().nullable().optional(),
      name: z.string().trim().min(2).max(180),
      contactName: z.string().trim().max(180).optional(),
      email: z.union([z.string().trim().max(254).pipe(z.email()), z.literal('')]).optional(),
      phone: z.string().trim().max(40).optional(),
      location: z.string().trim().max(240).optional(),
    })
    .strict(),
  suppliers: z
    .object({
      name: z.string().trim().min(2).max(180),
      contactName: z.string().trim().max(180).optional(),
      email: z.union([z.string().trim().max(254).pipe(z.email()), z.literal('')]).optional(),
      phone: z.string().trim().max(40).optional(),
      category: z.string().trim().max(120).optional(),
      paymentTerms: z.string().trim().max(120).optional(),
    })
    .strict(),
  branches: z
    .object({
      name: z.string().trim().min(2).max(120),
      code: z
        .string()
        .trim()
        .min(2)
        .max(24)
        .regex(/^[a-z0-9-]+$/i),
      managerName: z.string().trim().max(180).optional(),
      phone: z.string().trim().max(40).optional(),
      email: z.union([z.string().trim().max(254).pipe(z.email()), z.literal('')]).optional(),
      address: z.string().trim().max(400).optional(),
    })
    .strict(),
  products: z
    .object({
      name: z.string().trim().min(2).max(180),
      sku: z.string().trim().min(2).max(80),
      category: z.string().trim().min(2).max(120),
      unit: z.string().trim().min(1).max(40),
      unitPrice: productPriceSchema,
      description: z.string().trim().max(2000).optional(),
      supplierId: z.uuid().optional(),
    })
    .strict(),
}

export const insertModels: Record<string, { table: string; columns: Record<string, string> }> = {
  customers: {
    table: 'customers',
    columns: {
      branchId: 'branch_id',
      name: 'name',
      contactName: 'contact_name',
      email: 'email',
      phone: 'phone',
      location: 'location',
    },
  },
  suppliers: {
    table: 'suppliers',
    columns: {
      name: 'name',
      contactName: 'contact_name',
      email: 'email',
      phone: 'phone',
      category: 'category',
      paymentTerms: 'payment_terms',
    },
  },
  branches: {
    table: 'branches',
    columns: {
      name: 'name',
      code: 'code',
      managerName: 'manager_name',
      phone: 'phone',
      email: 'email',
      address: 'address',
    },
  },
  products: {
    table: 'products',
    columns: {
      name: 'name',
      sku: 'sku',
      category: 'category',
      unit: 'unit',
      description: 'description',
      unitPrice: 'unit_price',
      supplierId: 'supplier_id',
    },
  },
}

export const orderSchema = z
  .object({
    customerId: z.uuid().transform((value) => value.toLowerCase()),
    branchId: z.uuid().transform((value) => value.toLowerCase()),
    requestKey: z
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
    items: z
      .array(
        z
          .object({
            productId: z.uuid().transform((value) => value.toLowerCase()),
            quantity: z.coerce
              .number()
              .positive()
              .max(1_000_000)
              .finite()
              .refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .superRefine(({ items }, context) => {
    const productIds = new Set<string>()
    for (const [index, item] of items.entries()) {
      if (productIds.has(item.productId)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'productId'],
          message: 'Each product can only appear once in an order.',
        })
      }
      productIds.add(item.productId)
    }
  })
  .strict()
