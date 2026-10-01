import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
const keyLength = 64
const cost = 32_768

function deriveKey(
  password: string,
  salt: Buffer,
  options: { N: number; r: number; p: number; maxmem: number },
) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derivedKey = await deriveKey(password, salt, {
    N: cost,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })

  return `scrypt$${cost}$8$1$${salt.toString('hex')}$${derivedKey.toString('hex')}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, costValue, blockSize, parallelization, saltHex, hashHex] = encoded.split('$')

  if (
    algorithm !== 'scrypt' ||
    !costValue ||
    !blockSize ||
    !parallelization ||
    !saltHex ||
    !hashHex
  ) {
    return false
  }

  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')

  if (salt.length !== 16 || expected.length !== keyLength) {
    return false
  }

  const actual = await deriveKey(password, salt, {
    N: Number(costValue),
    r: Number(blockSize),
    p: Number(parallelization),
    maxmem: 64 * 1024 * 1024,
  })

  return timingSafeEqual(actual, expected)
}
