import { sha256 } from '@noble/hashes/sha2.js'
import { signAsync } from '@noble/secp256k1'
import { bech32 } from '@scure/base'

type Bolt11Network = {
  bech32: string
}

type Bolt11InvoiceOptions = {
  network: Bolt11Network
  satoshis: number | bigint
  timestamp: number
  paymentHash: string
  description: string
  expirySeconds: number
  minFinalCltvExpiry: number
  paymentSecret?: string
  privateKey: string
}

type DecodedBolt11Invoice = {
  network: Bolt11Network
  satoshis?: number
  tags: Array<{ tagName: string; data: string | number | number[] }>
  tagsObject: Record<string, string | number | number[]>
}

const TAG_CODES = {
  payment_hash: 1,
  feature_bits: 5,
  expire_time: 6,
  description: 13,
  payment_secret: 16,
  min_final_cltv_expiry: 24,
} as const

const TAG_NAMES = new Map<number, keyof typeof TAG_CODES>(
  Object.entries(TAG_CODES).map(([name, code]) => [code, name as keyof typeof TAG_CODES])
)

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

export async function createBolt11Invoice(options: Bolt11InvoiceOptions): Promise<string> {
  const prefix = `ln${options.network.bech32}${satoshisToHrp(options.satoshis)}`.toLowerCase()
  const dataWords = [
    ...leftPadWords(intToWords(options.timestamp), 7),
    ...encodeTag(TAG_CODES.payment_hash, hexToWords(options.paymentHash)),
    ...encodeTag(TAG_CODES.description, bytesToWords(TEXT_ENCODER.encode(options.description))),
    ...encodeTag(TAG_CODES.expire_time, intToWords(options.expirySeconds)),
    ...encodeTag(TAG_CODES.min_final_cltv_expiry, intToWords(options.minFinalCltvExpiry)),
  ]

  if (options.paymentSecret) {
    dataWords.push(...encodeTag(TAG_CODES.payment_secret, hexToWords(options.paymentSecret)))
    dataWords.push(...encodeTag(TAG_CODES.feature_bits, encodeFeatureBits([9, 15], 4)))
  }

  const signingData = concatBytes(TEXT_ENCODER.encode(prefix), wordsToBytes(dataWords))
  const digest = sha256(signingData)
  const signatureWithRecovery = await signAsync(digest, hexToBytes(options.privateKey), {
    prehash: false,
    format: 'recovered',
  })

  const recoveryFlag = signatureWithRecovery[0]
  if (recoveryFlag === undefined || recoveryFlag > 3) {
    throw new Error('Failed to create recoverable bolt11 signature')
  }

  const signature = signatureWithRecovery.slice(1)
  const signatureWords = bytesToWords(concatBytes(signature, Uint8Array.of(recoveryFlag)))
  return bech32.encode(prefix, dataWords.concat(signatureWords), false)
}

export function decodeBolt11Invoice(invoice: string): DecodedBolt11Invoice {
  const decoded = bech32.decode(invoice.toLowerCase() as `${string}1${string}`, false)
  const { network, satoshis } = parsePrefix(decoded.prefix)
  const words = decoded.words.slice(0, -104)
  const tags: DecodedBolt11Invoice['tags'] = []
  const tagsObject: DecodedBolt11Invoice['tagsObject'] = {}

  let cursor = 7
  while (cursor < words.length) {
    const tagCode = words[cursor]
    const dataLength = wordsToInt(words.slice(cursor + 1, cursor + 3))
    const dataWords = words.slice(cursor + 3, cursor + 3 + dataLength)
    const tagName = tagCode === undefined ? undefined : TAG_NAMES.get(tagCode)

    if (tagName) {
      const data = decodeTagData(tagName, dataWords)
      tags.push({ tagName, data })
      tagsObject[tagName] = data
    }

    cursor += 3 + dataLength
  }

  return { network, satoshis, tags, tagsObject }
}

function encodeTag(tagCode: number, dataWords: number[]): number[] {
  return [tagCode, ...leftPadWords(intToWords(dataWords.length), 2), ...dataWords]
}

function decodeTagData(
  tagName: keyof typeof TAG_CODES,
  words: number[]
): string | number | number[] {
  if (tagName === 'description') {
    return TEXT_DECODER.decode(wordsToBytes(words, true))
  }

  if (tagName === 'payment_hash' || tagName === 'payment_secret') {
    return bytesToHex(wordsToBytes(words, true))
  }

  if (tagName === 'expire_time' || tagName === 'min_final_cltv_expiry') {
    return wordsToInt(words)
  }

  return words
}

function satoshisToHrp(value: number | bigint): string {
  const satoshis = BigInt(value)
  if (satoshis <= 0n) {
    throw new Error('bolt11 invoice amount must be positive')
  }

  const millisatoshis = satoshis * 1000n
  const amount = millisatoshis.toString()

  if (amount.length > 11 && amount.endsWith('0'.repeat(11))) {
    return `${millisatoshis / 100_000_000_000n}`
  }

  if (amount.length > 8 && amount.endsWith('0'.repeat(8))) {
    return `${millisatoshis / 100_000_000n}m`
  }

  if (amount.length > 5 && amount.endsWith('0'.repeat(5))) {
    return `${millisatoshis / 100_000n}u`
  }

  if (amount.length > 2 && amount.endsWith('00')) {
    return `${millisatoshis / 100n}n`
  }

  return `${millisatoshis * 10n}p`
}

function parsePrefix(prefix: string): { network: Bolt11Network; satoshis?: number } {
  const match = prefix.match(/^ln([a-z]+)(\d*)([munp]?)$/)
  if (!match) {
    throw new Error('Invalid bolt11 invoice prefix')
  }

  const [, bech32Prefix, amount, suffix] = match
  if (!amount) {
    return { network: { bech32: bech32Prefix } }
  }

  const amountValue = BigInt(amount)
  const millisatoshis =
    suffix === ''
      ? amountValue * 100_000_000_000n
      : suffix === 'm'
        ? amountValue * 100_000_000n
        : suffix === 'u'
          ? amountValue * 100_000n
          : suffix === 'n'
            ? amountValue * 100n
            : amountValue / 10n

  return {
    network: { bech32: bech32Prefix },
    satoshis: Number(millisatoshis / 1000n),
  }
}

function intToWords(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('bolt11 integer field must be a non-negative safe integer')
  }

  if (value === 0) {
    return [0]
  }

  const words: number[] = []
  let remaining = value
  while (remaining > 0) {
    words.push(remaining & 31)
    remaining = Math.floor(remaining / 32)
  }
  return words.reverse()
}

function wordsToInt(words: number[]): number {
  return words.reduce((total, word) => total * 32 + word, 0)
}

function leftPadWords(words: number[], length: number): number[] {
  return [...Array(Math.max(0, length - words.length)).fill(0), ...words]
}

function encodeFeatureBits(supportedBits: number[], wordLength: number): number[] {
  const bitLength = wordLength * 5
  const bits = Array<boolean>(bitLength).fill(false)
  for (const bit of supportedBits) {
    bits[bit] = true
  }

  const words = Array.from({ length: wordLength }, (_, wordIndex) => {
    const offset = wordIndex * 5
    return (
      Number(bits[offset]) |
      (Number(bits[offset + 1]) << 1) |
      (Number(bits[offset + 2]) << 2) |
      (Number(bits[offset + 3]) << 3) |
      (Number(bits[offset + 4]) << 4)
    )
  })
  return words.reverse()
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^([a-fA-F0-9]{2})+$/.test(hex)) {
    throw new Error('Expected an even-length hex string')
  }

  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexToWords(hex: string): number[] {
  return bytesToWords(hexToBytes(hex))
}

function bytesToWords(bytes: Uint8Array): number[] {
  return bech32.toWords(bytes)
}

function wordsToBytes(words: number[], trimPadding = false): Uint8Array {
  const bytes = convertBits(words, 5, 8)
  if (trimPadding && (words.length * 5) % 8 !== 0) {
    return bytes.slice(0, -1)
  }
  return bytes
}

function convertBits(data: number[], fromBits: number, toBits: number): Uint8Array {
  let value = 0
  let bits = 0
  const maxValue = (1 << toBits) - 1
  const result: number[] = []

  for (const item of data) {
    value = (value << fromBits) | item
    bits += fromBits

    while (bits >= toBits) {
      bits -= toBits
      result.push((value >> bits) & maxValue)
    }
  }

  if (bits > 0) {
    result.push((value << (toBits - bits)) & maxValue)
  }

  return Uint8Array.from(result)
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
