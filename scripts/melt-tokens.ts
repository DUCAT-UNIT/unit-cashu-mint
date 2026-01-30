#!/usr/bin/env npx tsx
/**
 * Melt (withdraw) ecash tokens
 */

import { createHash } from 'crypto'
import { secp256k1 } from '@noble/curves/secp256k1'

const ProjectivePoint = secp256k1.ProjectivePoint

const MINT_URL = process.env.MINT_URL || 'http://localhost:3000'
const RUNE_ID = '1527352:1'

// Use one of the 512 tokens from the swap
const proofToMelt = {
  "id": "00a57d2ce41481",
  "amount": 512,
  "secret": "fd2bbc355463bcdef6c96b1f93e8f22c537473f12462bedcf832365368a0da75",
  "C": "02fae176c2c29c1988c0023c142e8ff6e8cef47b85a473e8a4a49db0f51bbd16ee"
}

// Destination address (your address to receive UNIT tokens back)
const DESTINATION = process.env.DESTINATION || 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

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

async function main() {
  console.log('🔥 Melting (withdrawing) tokens')
  console.log(`   Input: ${proofToMelt.amount} sat`)
  console.log(`   Destination: ${DESTINATION}`)
  console.log('')

  // Step 1: Create melt quote
  console.log('📝 Creating melt quote...')
  const meltAmount = proofToMelt.amount - 100 // Leave room for fee

  const quoteRes = await fetch(`${MINT_URL}/v1/melt/quote/unit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: meltAmount,
      unit: 'sat',
      rune_id: RUNE_ID,
      request: DESTINATION,
    }),
  })

  const quote = await quoteRes.json()

  if (!quoteRes.ok) {
    console.error('❌ Failed to create melt quote:', quote)
    process.exit(1)
  }

  console.log('   Quote ID:', quote.quote)
  console.log('   Amount:', quote.amount)
  console.log('   Fee reserve:', quote.fee_reserve)
  console.log('   Total needed:', quote.amount + quote.fee_reserve)
  console.log('')

  // Step 2: Submit melt request
  console.log('💸 Submitting melt request...')

  const meltRes = await fetch(`${MINT_URL}/v1/melt/unit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quote: quote.quote,
      inputs: [proofToMelt],
    }),
  })

  const meltResult = await meltRes.json()

  if (!meltRes.ok) {
    console.error('❌ Melt failed:', meltResult)
    process.exit(1)
  }

  console.log('   State:', meltResult.state)
  if (meltResult.txid) {
    console.log('   TX ID:', meltResult.txid)
  }
  if (meltResult.change) {
    console.log('   Change:', meltResult.change)
  }

  // Step 3: Check token state
  console.log('\n🔍 Checking token state...')
  const Y = hashToCurve(proofToMelt.secret)
  const YHex = new ProjectivePoint(Y.x, Y.y, 1n).toHex(true)

  const stateRes = await fetch(`${MINT_URL}/v1/checkstate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys: [YHex] }),
  })
  const stateResult = await stateRes.json()

  console.log('   Token state:', stateResult.states?.[0]?.state || 'unknown')

  console.log('\n✅ Done!')
  if (meltResult.state === 'PAID') {
    console.log(`   ${meltAmount} UNIT tokens should be sent to ${DESTINATION}`)
  }
}

main().catch(console.error)
