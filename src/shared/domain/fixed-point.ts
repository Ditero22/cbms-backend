/**
 * Exact decimal conversion for schema-validated amounts (2 dp) and quantities (3 dp).
 * Business limits and rounding rules belong to the calling domain.
 */
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
