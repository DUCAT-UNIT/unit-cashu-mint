#!/usr/bin/env npx tsx
/**
 * Swap ecash tokens (split or combine)
 */

import { randomBytes, createHash } from 'crypto'
import { secp256k1 } from '@noble/curves/secp256k1'

const ProjectivePoint = secp256k1.ProjectivePoint
const CURVE = secp256k1.CURVE

const MINT_URL = process.env.MINT_URL || 'http://localhost:3000'

// Example proof to swap (the 1024 token from previous mint)
const proofToSwap = {
  "id": "00a57d2ce41481",
  "amount": 1024,
  "secret": "1267b9e387f623b09608bddfaa4b3ded837523e4b5a8e5720235455fd0e10715",
  "C": "02fdcedace0cb7787b662f74dab4aa62f0f70267da895828f95f73939665330bde"
}

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

async function main() {
  console.log('🔄 Swapping tokens')
  console.log(`   Input: ${proofToSwap.amount} sat`)
  console.log('')

  // Get keyset keys
  const keysRes = await fetch(`${MINT_URL}/v1/keys/${proofToSwap.id}`)
  const { keys } = await keysRes.json()

  // Split 1024 into 2x512
  const outputAmounts = [512, 512]
  console.log(`   Output: ${outputAmounts.join(' + ')} = ${outputAmounts.reduce((a, b) => a + b, 0)}`)

  // Create blinded outputs
  const blindedData: { secret: string; r: bigint; amount: number; blindedMessage: any }[] = []

  for (const amount of outputAmounts) {
    const secret = randomBytes(32).toString('hex')
    const { blindedMessage, blindingFactor } = blindMessage(secret, amount, proofToSwap.id)
    blindedData.push({ secret, r: blindingFactor, amount, blindedMessage })
  }

  // Send swap request
  const swapRes = await fetch(`${MINT_URL}/v1/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: [proofToSwap],
      outputs: blindedData.map(d => d.blindedMessage),
    }),
  })

  const swapResult = await swapRes.json()

  if (!swapRes.ok) {
    console.error('❌ Swap failed:', swapResult)
    process.exit(1)
  }

  console.log('✅ Swap successful!')
  console.log(`   Received ${swapResult.signatures.length} new tokens`)

  // Unblind
  const newProofs = swapResult.signatures.map((sig: any, i: number) => {
    const { secret, r, amount } = blindedData[i]
    const C = unblindSignature(sig.C_, r, keys[amount])
    return { id: sig.id, amount: sig.amount, secret, C }
  })

  console.log('\n📜 New proofs:')
  console.log(JSON.stringify(newProofs, null, 2))

  // Check states
  console.log('\n🔍 Checking states...')

  // Old token should be spent
  const oldY = hashToCurve(proofToSwap.secret)
  const oldYHex = new ProjectivePoint(oldY.x, oldY.y, 1n).toHex(true)

  // New tokens should be unspent
  const newYs = newProofs.map((p: any) => {
    const point = hashToCurve(p.secret)
    return new ProjectivePoint(point.x, point.y, 1n).toHex(true)
  })

  const stateRes = await fetch(`${MINT_URL}/v1/checkstate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys: [oldYHex, ...newYs] }),
  })
  const stateResult = await stateRes.json()

  console.log('   Old token (1024):', stateResult.states?.[0]?.state || 'unknown')
  console.log('   New token (512):', stateResult.states?.[1]?.state || 'unknown')
  console.log('   New token (512):', stateResult.states?.[2]?.state || 'unknown')

  console.log('\n✅ Done!')
}

main().catch(console.error)
