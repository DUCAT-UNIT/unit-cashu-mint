#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { encode, sign } from 'bolt11'

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

const invoice = encode(
  {
    network: REGTEST,
    satoshis: amount,
    timestamp: Math.floor(Date.now() / 1000),
    tags: [
      { tagName: 'payment_hash', data: sha256Hex(`payment:${label}:${nonce}:${amount}`) },
      { tagName: 'description', data: `Ducat ${label}` },
      { tagName: 'min_final_cltv_expiry', data: 80 },
      { tagName: 'expire_time', data: 86400 },
      { tagName: 'payment_secret', data: sha256Hex(`secret:${label}:${nonce}:${amount}`) },
      {
        tagName: 'feature_bits',
        data: {
          word_length: 4,
          payment_secret: {
            required: false,
            supported: true,
          },
        },
      },
    ],
  },
  true
)

const signed = sign(invoice, PRIVATE_KEY)
if (!signed.paymentRequest) {
  throw new Error('Failed to build fake bolt11 invoice')
}

console.log(signed.paymentRequest)
