import { z } from 'zod'

// Quantities cross the HTTP boundary as decimal text so PostgreSQL receives the
// user's exact thousandths. JSON numbers remain accepted for existing clients.
function quantitySchema(kind: 'adjustment' | 'reorder' | 'transfer') {
  const signed = kind === 'adjustment'
  return z.union([z.string().max(30), z.number().finite()]).transform((value, context) => {
    const text = String(value).trim()
    const pattern = signed ? /^-?\d+(?:\.\d{1,3})?$/ : /^\d+(?:\.\d{1,3})?$/
    if (!pattern.test(text)) {
      context.addIssue({
        code: 'custom',
        message: 'Use a number with at most three decimal places.',
      })
      return z.NEVER
    }
    const negative = text.startsWith('-')
    const [whole = '0', fraction = ''] = text.replace(/^-/, '').split('.')
    const magnitude = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'))
    if (magnitude > 1_000_000_000n || (kind !== 'reorder' && magnitude === 0n)) {
      context.addIssue({
        code: 'custom',
        message: signed
          ? 'Use a nonzero adjustment between -1,000,000 and 1,000,000.'
          : kind === 'transfer'
            ? 'Use a transfer quantity greater than zero and up to 1,000,000.'
            : 'Use a reorder point between 0 and 1,000,000.',
      })
      return z.NEVER
    }
    return `${negative && magnitude !== 0n ? '-' : ''}${magnitude / 1000n}.${String(magnitude % 1000n).padStart(3, '0')}`
  })
}

export const inventoryAdjustmentSchema = z
  .object({
    productId: z.uuid(),
    branchId: z.uuid(),
    quantityDelta: quantitySchema('adjustment'),
    note: z.string().trim().max(500).optional(),
    requestKey: z
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .strict()

export const inventoryReorderSchema = z.object({ reorderLevel: quantitySchema('reorder') }).strict()

export const inventoryCorrectionSchema = z
  .object({
    transactionId: z.uuid().transform((value) => value.toLowerCase()),
    correctedQuantity: quantitySchema('reorder'),
    reason: z.string().trim().min(3).max(500),
    requestKey: z.uuid().transform((value) => value.toLowerCase()),
  })
  .strict()

export type InventoryCorrectionInput = z.infer<typeof inventoryCorrectionSchema>

export const inventoryDetailQuerySchema = z
  .object({
    movementPage: z.coerce.number().int().min(1).max(100_000).default(1),
    movementType: z.string().trim().max(80).default(''),
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    historyPage: z.coerce.number().int().min(1).max(100_000).default(1),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      context.addIssue({
        code: 'custom',
        path: ['dateTo'],
        message: 'End date must be on or after start date.',
      })
    }
  })

export type InventoryAdjustmentInput = z.infer<typeof inventoryAdjustmentSchema>
export type InventoryReorderInput = z.infer<typeof inventoryReorderSchema>
export type InventoryDetailQuery = z.infer<typeof inventoryDetailQuerySchema>

const transferItemSchema = z
  .object({
    productId: z.uuid().transform((value) => value.toLowerCase()),
    quantity: quantitySchema('transfer'),
  })
  .strict()

export const inventoryTransferSchema = z
  .object({
    fromBranchId: z.uuid().transform((value) => value.toLowerCase()),
    toBranchId: z.uuid().transform((value) => value.toLowerCase()),
    items: z.array(transferItemSchema).min(1).max(100),
    note: z.string().trim().max(500).optional(),
    requestKey: z
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .strict()
  .superRefine((transfer, context) => {
    if (transfer.fromBranchId === transfer.toBranchId) {
      context.addIssue({
        code: 'custom',
        path: ['toBranchId'],
        message: 'Choose a different destination branch.',
      })
    }

    const productIds = transfer.items.map((item) => item.productId)
    if (new Set(productIds).size !== productIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'Each product can only appear once in a transfer.',
      })
    }
  })

export type InventoryTransferInput = z.infer<typeof inventoryTransferSchema>
