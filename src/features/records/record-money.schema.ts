import { z } from 'zod'
import { formatMoneyCents, moneyToCents } from '@/shared/domain/fixed-point.js'

/** Preserve cents and reject blank/boolean/exponent coercions on both create and edit. */
export const productPriceSchema = z
  .union([z.string().max(30), z.number().finite()])
  .transform((value, context) => {
    const text = String(value).trim()
    if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) {
      context.addIssue({
        code: 'custom',
        message: 'Use a non-negative price with at most two decimal places.',
      })
      return z.NEVER
    }
    const cents = moneyToCents(text)
    if (cents > 99_999_999_999_999n) {
      context.addIssue({
        code: 'custom',
        message: 'Use a price no greater than 999,999,999,999.99.',
      })
      return z.NEVER
    }
    return formatMoneyCents(cents)
  })
