const maxOrderAmountCents = 999_999_999_999_99n

export function calculateLineTotal(unitPrice: string, quantity: number) {
  return calculateLineTotalMilli(unitPrice, quantityToMilli(quantity))
}

export function calculateLineTotalMilli(unitPrice: string, quantityMilli: bigint) {
  const unitPriceCents = moneyToCents(unitPrice)
  const lineCents = (unitPriceCents * quantityMilli + 500n) / 1000n
  return formatMoneyCents(lineCents)
}

export function quantityToMilli(quantity: string | number) {
  const value = String(quantity).trim()
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole = '0', fraction = ''] = unsigned.split('.')
  const milli = BigInt(whole || '0') * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3))
  return negative ? -milli : milli
}

export function formatQuantityMilli(quantity: bigint) {
  const negative = quantity < 0n
  const absolute = negative ? -quantity : quantity
  return `${negative ? '-' : ''}${absolute / 1000n}.${String(absolute % 1000n).padStart(3, '0')}`
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

export function moneyToCents(amount: string) {
  const value = amount.trim()
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole = '0', fraction = ''] = unsigned.split('.')
  const cents = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
  return negative ? -cents : cents
}

export function formatMoneyCents(amount: bigint) {
  const negative = amount < 0n
  const absolute = negative ? -amount : amount
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}
