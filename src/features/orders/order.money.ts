import { formatMoneyCents, moneyToCents, quantityToMilli } from '@/shared/domain/fixed-point.js'

const maxOrderAmountCents = 999_999_999_999_99n

export function calculateLineTotal(unitPrice: string, quantity: number) {
  return calculateLineTotalMilli(unitPrice, quantityToMilli(quantity))
}

export function calculateLineTotalMilli(unitPrice: string, quantityMilli: bigint) {
  const unitPriceCents = moneyToCents(unitPrice)
  const lineCents = (unitPriceCents * quantityMilli + 500n) / 1000n
  return formatMoneyCents(lineCents)
}

export function isOrderAmountRepresentable(lines: string[]) {
  let total = 0n
  for (const line of lines) {
    const lineTotal = moneyToCents(line)
    if (lineTotal > maxOrderAmountCents) return false
    total += lineTotal
    if (total > maxOrderAmountCents) return false
  }
  return true
}

export function calculateOrderTotal(lines: string[]) {
  return formatMoneyCents(lines.reduce((total, line) => total + moneyToCents(line), 0n))
}
