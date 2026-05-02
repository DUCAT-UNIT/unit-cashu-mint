#!/usr/bin/env npx tsx
/**
 * Mint tokens from a PAID quote
 */

import { randomBytes, createHash } from 'crypto'
import { secp256k1 } from '@noble/curves/secp256k1'
const ProjectivePoint = secp256k1.ProjectivePoint
const CURVE = secp256k1.CURVE

const MINT_URL = process.env.MINT_URL || 'http://localhost:3000'
const QUOTE_ID = process.env.QUOTE_ID

if (!QUOTE_ID) {
  console.error('Usage: QUOTE_ID=<quote_id> npx tsx scripts/dev/mint-tokens.ts')
  process.exit(1)
}

// Domain separator for hash_to_curve per NUT-00
const DOMAIN_SEPARATOR = new Uint8Array([
  83, 101, 99, 112, 50, 53, 54, 107, 49, 95, 72, 97, 115, 104, 84, 111, 67, 117, 114, 118, 101, 95,
  67, 97, 115, 104, 117, 95,
])

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

function hashToCurve(secret: string): { x: bigint; y: bigint } {
  const secretBytes = new TextEncoder().encode(secret)
  const msgToHash = sha256(new Uint8Array([...DOMAIN_SEPARATOR, ...secretBytes]))

  for (let counter = 0; counter < 2 ** 16; counter++) {
    const counterBytes = new Uint8Array(4)
    new DataView(counterBytes.buffer).setUint32(0, counter, true)
    const hash = sha256(new Uint8Array([...msgToHash, ...counterBytes]))

    try {
      const point = ProjectivePoint.fromHex('02' + Buffer.from(hash).toString('hex'))
      return { x: point.x, y: point.y }
    } catch {
      continue
    }
  }
  throw new Error('Could not hash to curve')
}

function blindMessage(secret: string, amount: number, keysetId: string) {
  const r = BigInt('0x' + randomBytes(32).toString('hex')) % CURVE.n

  const Y = hashToCurve(secret)
  const Y_point = new ProjectivePoint(Y.x, Y.y, 1n)
  const rG = ProjectivePoint.BASE.multiply(r)
  const B_ = Y_point.add(rG)

  return {
    blindedMessage: { amount, B_: B_.toHex(true), id: keysetId },
    blindingFactor: r,
    secret,
  }
}

function unblindSignature(C_hex: string, r: bigint, K_hex: string): string {
  const C_ = ProjectivePoint.fromHex(C_hex)
  const K = ProjectivePoint.fromHex(K_hex)
  const rK = K.multiply(r)
  const C = C_.subtract(rK)
  return C.toHex(true)
}

// Split amount into power-of-2 denominations
function splitAmount(amount: number): number[] {
  const denominations: number[] = []
  let remaining = amount
  let power = 1

  while (power <= remaining) power *= 2
  power /= 2

  while (remaining > 0 && power >= 1) {
    if (power <= remaining) {
      denominations.push(power)
      remaining -= power
    }
    power /= 2
  }

  return denominations
}

async function main() {
  console.log('🪙 Minting tokens from quote:', QUOTE_ID)
  console.log('')

  // Get quote
  const quoteRes = await fetch(`${MINT_URL}/v1/mint/quote/unit/${QUOTE_ID}`)
  const quote = await quoteRes.json()
  console.log('Quote:', JSON.stringify(quote, null, 2))

  if (quote.state !== 'PAID') {
    console.error('❌ Quote is not PAID. Current state:', quote.state)
    process.exit(1)
  }

  // Get keyset
  const keysetsRes = await fetch(`${MINT_URL}/v1/keysets`)
  const { keysets } = await keysetsRes.json()
  const keyset = keysets.find((k: any) => k.active)

  const keysRes = await fetch(`${MINT_URL}/v1/keys/${keyset.id}`)
  const { keys } = await keysRes.json()

  // Split amount into denominations
  const amounts = splitAmount(quote.amount)
  console.log('\nDenominations:', amounts.join(' + '), '=', amounts.reduce((a: number, b: number) => a + b, 0))

  // Create blinded messages
  const blindedData: { secret: string; r: bigint; amount: number; blindedMessage: any }[] = []

  for (const amount of amounts) {
    const secret = randomBytes(32).toString('hex')
    const { blindedMessage, blindingFactor } = blindMessage(secret, amount, keyset.id)
    blindedData.push({ secret, r: blindingFactor, amount, blindedMessage })
  }

  console.log('\nSending mint request with', blindedData.length, 'blinded messages...')

  // Mint tokens
  const mintRes = await fetch(`${MINT_URL}/v1/mint/unit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quote: QUOTE_ID,
      outputs: blindedData.map(d => d.blindedMessage),
    }),
  })

  const mintResult = await mintRes.json()

  if (!mintRes.ok) {
    console.error('❌ Mint failed:', mintResult)
    process.exit(1)
  }

  console.log('✅ Received', mintResult.signatures.length, 'blind signatures!')

  // Unblind to create proofs
  const proofs = mintResult.signatures.map((sig: any, i: number) => {
    const { secret, r, amount } = blindedData[i]
    const C = unblindSignature(sig.C_, r, keys[amount])
    return { id: sig.id, amount: sig.amount, secret, C }
  })

  console.log('\n📜 Ecash Proofs:')
  console.log(JSON.stringify(proofs, null, 2))

  // Encode as cashu token
  const token = {
    token: [{
      mint: MINT_URL,
      proofs,
    }],
    unit: quote.unit,
  }

  const tokenStr = 'cashuA' + Buffer.from(JSON.stringify(token)).toString('base64url')
  console.log('\n🎫 Cashu Token:')
  console.log(tokenStr)

  // Check token state
  console.log('\n🔍 Checking token state...')
  const Ys = proofs.map((p: any) => {
    const point = hashToCurve(p.secret)
    return new ProjectivePoint(point.x, point.y, 1n).toHex(true)
  })

  const stateRes = await fetch(`${MINT_URL}/v1/checkstate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys }),
  })
  const stateResult = await stateRes.json()
  console.log('States:', stateResult.states?.map((s: any) => s.state).join(', ') || stateResult)

  console.log('\n✅ Done! You have minted', quote.amount, quote.unit, 'worth of ecash tokens.')
}

main().catch(console.error)
