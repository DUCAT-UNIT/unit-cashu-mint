#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import { signAsync } from '@noble/secp256k1'
import { bech32 } from '@scure/base'

const REGTEST = {
  bech32: 'bcrt',
  pubKeyHash: 111,
  scriptHash: 196,
  validWitnessVersions: [0, 1],
}
const PRIVATE_KEY = '11'.repeat(32)

function readArg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return fallback
  }

  return process.argv[index + 1] ?? fallback
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

const amount = Number(readArg('--amount', '62'))
const label = readArg('--label', 'interop')
const nonce = readArg('--nonce', `${process.pid}:${Date.now()}`)

if (!Number.isInteger(amount) || amount <= 0) {
  throw new Error(`Invalid invoice amount: ${amount}`)
}

const invoice = await createBolt11Invoice({
  network: REGTEST,
  satoshis: amount,
  timestamp: Math.floor(Date.now() / 1000),
  paymentHash: sha256Hex(`payment:${label}:${nonce}:${amount}`),
  description: `Ducat ${label}`,
  minFinalCltvExpiry: 80,
  expirySeconds: 86400,
  paymentSecret: sha256Hex(`secret:${label}:${nonce}:${amount}`),
  privateKey: PRIVATE_KEY,
})

console.log(invoice)

async function createBolt11Invoice(options) {
  const prefix = `ln${options.network.bech32}${satoshisToHrp(options.satoshis)}`.toLowerCase()
  const dataWords = [
    ...leftPadWords(intToWords(options.timestamp), 7),
    ...encodeTag(1, hexToWords(options.paymentHash)),
    ...encodeTag(13, bytesToWords(new TextEncoder().encode(options.description))),
    ...encodeTag(24, intToWords(options.minFinalCltvExpiry)),
    ...encodeTag(6, intToWords(options.expirySeconds)),
    ...encodeTag(16, hexToWords(options.paymentSecret)),
    ...encodeTag(5, encodeFeatureBits([9, 15], 4)),
  ]

  const signingData = concatBytes(new TextEncoder().encode(prefix), wordsToBytes(dataWords))
  const digest = sha256(signingData)
  const signatureWithRecovery = await signAsync(digest, hexToBytes(options.privateKey), {
    prehash: false,
    format: 'recovered',
  })
  const recoveryFlag = signatureWithRecovery[0]
  if (recoveryFlag === undefined || recoveryFlag > 3) {
    throw new Error('Failed to build fake bolt11 invoice')
  }

  const signature = signatureWithRecovery.slice(1)
  const signatureWords = bytesToWords(concatBytes(signature, Uint8Array.of(recoveryFlag)))
  return bech32.encode(prefix, dataWords.concat(signatureWords), false)
}

function encodeTag(tagCode, dataWords) {
  return [tagCode, ...leftPadWords(intToWords(dataWords.length), 2), ...dataWords]
}

function satoshisToHrp(value) {
  const satoshis = BigInt(value)
  const millisatoshis = satoshis * 1000n
  const amountValue = millisatoshis.toString()

  if (amountValue.length > 11 && amountValue.endsWith('0'.repeat(11))) {
    return `${millisatoshis / 100_000_000_000n}`
  }
  if (amountValue.length > 8 && amountValue.endsWith('0'.repeat(8))) {
    return `${millisatoshis / 100_000_000n}m`
  }
  if (amountValue.length > 5 && amountValue.endsWith('0'.repeat(5))) {
    return `${millisatoshis / 100_000n}u`
  }
  if (amountValue.length > 2 && amountValue.endsWith('00')) {
    return `${millisatoshis / 100n}n`
  }
  return `${millisatoshis * 10n}p`
}

function intToWords(value) {
  if (value === 0) {
    return [0]
  }

  const words = []
  let remaining = value
  while (remaining > 0) {
    words.push(remaining & 31)
    remaining = Math.floor(remaining / 32)
  }
  return words.reverse()
}

function leftPadWords(words, length) {
  return [...Array(Math.max(0, length - words.length)).fill(0), ...words]
}

function encodeFeatureBits(supportedBits, wordLength) {
  const bits = Array(wordLength * 5).fill(false)
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

function hexToBytes(hex) {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function hexToWords(hex) {
  return bytesToWords(hexToBytes(hex))
}

function bytesToWords(bytes) {
  return bech32.toWords(bytes)
}

function wordsToBytes(words) {
  let value = 0
  let bits = 0
  const result = []

  for (const item of words) {
    value = (value << 5) | item
    bits += 5

    while (bits >= 8) {
      bits -= 8
      result.push((value >> bits) & 255)
    }
  }

  if (bits > 0) {
    result.push((value << (8 - bits)) & 255)
  }

  return Uint8Array.from(result)
}

function concatBytes(...chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
