#!/usr/bin/env npx tsx
/**
 * UNIT Mint Test - Using an existing PAID quote
 */

import { randomBytes, createHash } from 'crypto'
import { secp256k1 } from '@noble/curves/secp256k1'

const ProjectivePoint = secp256k1.ProjectivePoint
const CURVE = secp256k1.CURVE

const MINT_URL = process.env.MINT_URL || 'http://localhost:3000'
const QUOTE_ID = '6df575ba9ad16634afa5931116fd985ac9f9e27b06ca8b39e5bec9fdebfc02ed'
const AMOUNT = 5000

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
    } catch { continue }
  }
  throw new Error('Could not hash to curve')
}

function blindMessage(secret: string, amount: number, keysetId: string) {
  const r = BigInt('0x' + randomBytes(32).toString('hex')) % CURVE.n
  const Y = hashToCurve(secret)
  const Y_point = new ProjectivePoint(Y.x, Y.y, 1n)
  const rG = ProjectivePoint.BASE.multiply(r)
  const B_ = Y_point.add(rG)
  return { blindedMessage: { amount, B_: B_.toHex(true), id: keysetId }, blindingFactor: r, secret }
}

function unblindSignature(C_hex: string, r: bigint, K_hex: string): string {
  const C_ = ProjectivePoint.fromHex(C_hex)
  const K = ProjectivePoint.fromHex(K_hex)
  return C_.subtract(K.multiply(r)).toHex(true)
}

function splitAmount(amount: number): number[] {
  const denominations: number[] = []
  let remaining = amount
  const powers = [8388608, 4194304, 2097152, 1048576, 524288, 262144, 131072, 65536, 32768, 16384, 8192, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1]
  for (const p of powers) {
    while (remaining >= p) {
      denominations.push(p)
      remaining -= p
    }
  }
  return denominations
}

function getYHex(secret: string): string {
  const point = hashToCurve(secret)
  return new ProjectivePoint(point.x, point.y, 1n).toHex(true)
}

async function main() {
  console.log('🪙 UNIT E2E TEST - Minting', AMOUNT, 'units\n')

  // Get keyset
  const keysetsRes = await fetch(`${MINT_URL}/v1/keysets`)
  const { keysets } = await keysetsRes.json()
  const keyset = keysets.find((k: any) => k.active && k.unit === 'sat')
  console.log('Keyset:', keyset.id)

  const keysRes = await fetch(`${MINT_URL}/v1/keys/${keyset.id}`)
  const { keys } = await keysRes.json()

  // Check quote status
  const quoteRes = await fetch(`${MINT_URL}/v1/mint/quote/unit/${QUOTE_ID}`)
  const quote = await quoteRes.json()
  console.log('Quote state:', quote.state)

  if (quote.state !== 'PAID') {
    console.log('❌ Quote is not PAID')
    return
  }

  // Split amount
  const amounts = splitAmount(AMOUNT)
  console.log('Denominations:', amounts.length, 'tokens')
  console.log('Sum:', amounts.reduce((a, b) => a + b, 0))

  // Create blinded messages
  const blindedData: any[] = []
  for (const amt of amounts) {
    const secret = randomBytes(32).toString('hex')
    const { blindedMessage, blindingFactor } = blindMessage(secret, amt, keyset.id)
    blindedData.push({ secret, r: blindingFactor, amount: amt, blindedMessage })
  }

  // Mint
  console.log('\n🪙 Minting...')
  const mintRes = await fetch(`${MINT_URL}/v1/mint/unit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quote: QUOTE_ID, outputs: blindedData.map(d => d.blindedMessage) }),
  })

  const mintResult = await mintRes.json()
  if (!mintRes.ok) {
    console.log('❌ Error:', mintResult)
    return
  }

  console.log('✅ Received', mintResult.signatures.length, 'blind signatures!')

  // Unblind
  const proofs = mintResult.signatures.map((sig: any, i: number) => {
    const { secret, r, amount } = blindedData[i]
    const C = unblindSignature(sig.C_, r, keys[amount])
    return { id: sig.id, amount: sig.amount, secret, C }
  })

  // Check state
  console.log('\n🔍 Checking state...')
  const Ys = proofs.map((p: any) => getYHex(p.secret))
  const stateRes = await fetch(`${MINT_URL}/v1/checkstate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys }),
  })
  const stateResult = await stateRes.json()
  console.log('All UNSPENT:', stateResult.states.every((s: any) => s.state === 'UNSPENT') ? '✅' : '❌')

  // Swap
  console.log('\n🔄 Swapping largest token...')
  const largest = proofs[0]
  const half = largest.amount / 2

  const swapData: any[] = []
  for (let i = 0; i < 2; i++) {
    const secret = randomBytes(32).toString('hex')
    const { blindedMessage, blindingFactor } = blindMessage(secret, half, keyset.id)
    swapData.push({ secret, r: blindingFactor, amount: half, blindedMessage })
  }

  const swapRes = await fetch(`${MINT_URL}/v1/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: [largest], outputs: swapData.map(d => d.blindedMessage) }),
  })

  if (swapRes.ok) {
    console.log('✅ Swapped', largest.amount, '→', half, '+', half)
  } else {
    console.log('❌ Swap failed:', await swapRes.json())
  }

  console.log('\n' + '═'.repeat(50))
  console.log('✅ UNIT E2E TEST COMPLETE!')
  console.log('═'.repeat(50))
}

main().catch(console.error)
