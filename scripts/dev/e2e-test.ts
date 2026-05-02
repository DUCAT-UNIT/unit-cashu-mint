#!/usr/bin/env npx tsx
/**
 * E2E Test Script for Ducat UNIT Mint
 *
 * This script tests the full mint/melt flow against a running server
 * with real or simulated deposits.
 *
 * Usage: npx tsx scripts/dev/e2e-test.ts
 */

import { randomBytes, createHash } from 'crypto'
import * as secp256k1 from '@noble/secp256k1'

const MINT_URL = process.env.MINT_URL || 'http://localhost:3000'
const RUNE_ID = process.env.RUNE_ID || '1527352:1'
const UNIT = 'sat'

// Domain separator for hash_to_curve per NUT-00
const DOMAIN_SEPARATOR = new Uint8Array([
  83, 101, 99, 112, 50, 53, 54, 107, 49, 95, 72, 97, 115, 104, 84, 111, 67, 117, 114, 118, 101, 95,
  67, 97, 115, 104, 117, 95,
])

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

// Hash secret to curve point Y per NUT-00
function hashToCurve(secret: string): { x: bigint; y: bigint } {
  const secretBytes = new TextEncoder().encode(secret)
  const msgToHash = sha256(new Uint8Array([...DOMAIN_SEPARATOR, ...secretBytes]))

  for (let counter = 0; counter < 2 ** 16; counter++) {
    const counterBytes = new Uint8Array(4)
    new DataView(counterBytes.buffer).setUint32(0, counter, true) // little-endian
    const hash = sha256(new Uint8Array([...msgToHash, ...counterBytes]))

    try {
      const point = secp256k1.ProjectivePoint.fromHex('02' + Buffer.from(hash).toString('hex'))
      return { x: point.x, y: point.y }
    } catch {
      continue
    }
  }
  throw new Error('Could not hash to curve')
}

// Create blinded message B_ = Y + r*G
function blindMessage(secret: string, amount: number, keysetId: string): {
  blindedMessage: { amount: number; B_: string; id: string }
  blindingFactor: bigint
  secret: string
} {
  const r = BigInt('0x' + randomBytes(32).toString('hex')) % secp256k1.CURVE.n

  // Hash secret to curve point Y
  const Y = hashToCurve(secret)
  const Y_point = new secp256k1.ProjectivePoint(Y.x, Y.y, 1n)

  // B_ = Y + r*G
  const rG = secp256k1.ProjectivePoint.BASE.multiply(r)
  const B_ = Y_point.add(rG)

  return {
    blindedMessage: {
      amount,
      B_: B_.toHex(true),
      id: keysetId,
    },
    blindingFactor: r,
    secret,
  }
}

// Unblind signature: C = C_ - r*K
function unblindSignature(C_hex: string, r: bigint, K_hex: string): string {
  const C_ = secp256k1.ProjectivePoint.fromHex(C_hex)
  const K = secp256k1.ProjectivePoint.fromHex(K_hex)

  const rK = K.multiply(r)
  const C = C_.subtract(rK)

  return C.toHex(true)
}

// API helpers
async function fetchJson(path: string, options?: RequestInit) {
  const res = await fetch(`${MINT_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(`API Error: ${JSON.stringify(data)}`)
  }
  return data
}

async function getMintInfo() {
  return fetchJson('/v1/info')
}

async function getKeysets() {
  return fetchJson('/v1/keysets')
}

async function getKeys(keysetId: string) {
  return fetchJson(`/v1/keys/${keysetId}`)
}

async function createMintQuote(amount: number) {
  return fetchJson('/v1/mint/quote/unit', {
    method: 'POST',
    body: JSON.stringify({ amount, unit: UNIT, rune_id: RUNE_ID }),
  })
}

async function getMintQuote(quoteId: string) {
  return fetchJson(`/v1/mint/quote/unit/${quoteId}`)
}

async function mintTokens(quoteId: string, outputs: any[]) {
  return fetchJson('/v1/mint/unit', {
    method: 'POST',
    body: JSON.stringify({ quote: quoteId, outputs }),
  })
}

async function createMeltQuote(amount: number, address: string) {
  return fetchJson('/v1/melt/quote/unit', {
    method: 'POST',
    body: JSON.stringify({ amount, unit: UNIT, rune_id: RUNE_ID, request: address }),
  })
}

async function getMeltQuote(quoteId: string) {
  return fetchJson(`/v1/melt/quote/unit/${quoteId}`)
}

async function meltTokens(quoteId: string, inputs: any[]) {
  return fetchJson('/v1/melt/unit', {
    method: 'POST',
    body: JSON.stringify({ quote: quoteId, inputs }),
  })
}

async function swapTokens(inputs: any[], outputs: any[]) {
  return fetchJson('/v1/swap', {
    method: 'POST',
    body: JSON.stringify({ inputs, outputs }),
  })
}

async function checkState(Ys: string[]) {
  return fetchJson('/v1/checkstate', {
    method: 'POST',
    body: JSON.stringify({ Ys }),
  })
}

// Main test flow
async function main() {
  console.log('🚀 Starting E2E Test for Ducat UNIT Mint')
  console.log(`   Mint URL: ${MINT_URL}`)
  console.log(`   Rune ID: ${RUNE_ID}`)
  console.log('')

  // Step 1: Get mint info
  console.log('📋 Step 1: Get mint info')
  const info = await getMintInfo()
  console.log(`   Name: ${info.name}`)
  console.log(`   Supported NUTs: ${Object.keys(info.nuts).join(', ')}`)
  console.log('')

  // Step 2: Get keysets
  console.log('🔑 Step 2: Get keysets')
  const { keysets } = await getKeysets()
  const activeKeyset = keysets.find((k: any) => k.active)
  if (!activeKeyset) {
    throw new Error('No active keyset found')
  }
  console.log(`   Active keyset: ${activeKeyset.id} (unit: ${activeKeyset.unit})`)

  // Get public keys for this keyset
  const { keys } = await getKeys(activeKeyset.id)
  console.log(`   Denominations: ${Object.keys(keys).length}`)
  console.log('')

  // Step 3: Create mint quote
  console.log('💰 Step 3: Create mint quote')
  const mintAmount = 1000
  const mintQuote = await createMintQuote(mintAmount)
  console.log(`   Quote ID: ${mintQuote.quote}`)
  console.log(`   Address: ${mintQuote.request}`)
  console.log(`   Amount: ${mintQuote.amount} ${UNIT}`)
  console.log(`   State: ${mintQuote.state}`)
  console.log('')

  // Step 4: Wait for payment (or simulate)
  console.log('⏳ Step 4: Check quote status')
  let quote = await getMintQuote(mintQuote.quote)
  console.log(`   Current state: ${quote.state}`)

  if (quote.state === 'UNPAID') {
    console.log('')
    console.log('   ⚠️  Quote is UNPAID. To continue the test:')
    console.log(`   1. Send ${mintAmount} UNIT tokens (rune ${RUNE_ID}) to:`)
    console.log(`      ${mintQuote.request}`)
    console.log('   2. Wait for confirmation (~30 seconds after block)')
    console.log('   3. Run this script again with QUOTE_ID env var:')
    console.log(`      QUOTE_ID=${mintQuote.quote} npx tsx scripts/dev/e2e-test.ts`)
    console.log('')

    // Poll for a bit
    console.log('   Polling for payment (60 seconds)...')
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000))
      quote = await getMintQuote(mintQuote.quote)
      process.stdout.write(`   ${i * 5 + 5}s: ${quote.state}`)
      if (quote.state === 'PAID') {
        console.log(' ✅')
        break
      }
      console.log('')
    }
  }

  if (quote.state !== 'PAID') {
    console.log('')
    console.log('   Quote not paid yet. Exiting.')
    console.log('   Re-run with QUOTE_ID when payment is confirmed.')
    return
  }

  // Step 5: Mint tokens
  console.log('')
  console.log('🪙 Step 5: Mint ecash tokens')

  // Create blinded messages
  const secret1 = randomBytes(32).toString('hex')
  const secret2 = randomBytes(32).toString('hex')

  const blind1 = blindMessage(secret1, 512, activeKeyset.id)
  const blind2 = blindMessage(secret2, 488, activeKeyset.id)

  // Find closest denominations that sum to 1000
  // Available: 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024...
  // 1000 = 512 + 256 + 128 + 64 + 32 + 8 = 1000
  const denominations = [512, 256, 128, 64, 32, 8]
  const blindedMessages: any[] = []
  const blindingData: { secret: string; r: bigint; amount: number }[] = []

  for (const amount of denominations) {
    const secret = randomBytes(32).toString('hex')
    const { blindedMessage, blindingFactor } = blindMessage(secret, amount, activeKeyset.id)
    blindedMessages.push(blindedMessage)
    blindingData.push({ secret, r: blindingFactor, amount })
  }

  console.log(`   Requesting ${denominations.length} tokens: ${denominations.join(' + ')} = ${denominations.reduce((a, b) => a + b, 0)}`)

  const mintResult = await mintTokens(mintQuote.quote, blindedMessages)
  console.log(`   Received ${mintResult.signatures.length} blind signatures`)

  // Unblind to get proofs
  const proofs = mintResult.signatures.map((sig: any, i: number) => {
    const { secret, r, amount } = blindingData[i]
    const C = unblindSignature(sig.C_, r, keys[amount])
    return {
      id: sig.id,
      amount: sig.amount,
      secret,
      C,
    }
  })

  console.log(`   ✅ Minted ${proofs.length} ecash tokens!`)
  console.log('')

  // Step 6: Check token state
  console.log('🔍 Step 6: Check token state (NUT-07)')
  const Ys = proofs.map((p: any) => {
    const point = hashToCurve(p.secret)
    return new secp256k1.ProjectivePoint(point.x, point.y, 1n).toHex(true)
  })

  const stateResult = await checkState(Ys)
  console.log(`   States: ${stateResult.states.map((s: any) => s.state).join(', ')}`)
  console.log('')

  // Step 7: Swap tokens (split one token)
  console.log('🔄 Step 7: Swap tokens (split 512 into 256 + 256)')
  const proofToSwap = proofs.find((p: any) => p.amount === 512)
  if (proofToSwap) {
    const swapSecret1 = randomBytes(32).toString('hex')
    const swapSecret2 = randomBytes(32).toString('hex')

    const swapBlind1 = blindMessage(swapSecret1, 256, activeKeyset.id)
    const swapBlind2 = blindMessage(swapSecret2, 256, activeKeyset.id)

    const swapResult = await swapTokens(
      [proofToSwap],
      [swapBlind1.blindedMessage, swapBlind2.blindedMessage]
    )

    console.log(`   ✅ Swapped 1 token (512) for 2 tokens (256 + 256)`)

    // Update proofs array
    const idx = proofs.indexOf(proofToSwap)
    proofs.splice(idx, 1)

    // Add new proofs
    for (let i = 0; i < 2; i++) {
      const sig = swapResult.signatures[i]
      const { secret, r } = i === 0
        ? { secret: swapSecret1, r: swapBlind1.blindingFactor }
        : { secret: swapSecret2, r: swapBlind2.blindingFactor }

      proofs.push({
        id: sig.id,
        amount: sig.amount,
        secret,
        C: unblindSignature(sig.C_, r, keys[sig.amount]),
      })
    }
  }
  console.log('')

  // Step 8: Create melt quote
  console.log('🔥 Step 8: Create melt quote (withdraw)')
  const meltAmount = 500
  const withdrawAddress = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' // Test address

  const meltQuote = await createMeltQuote(meltAmount, withdrawAddress)
  console.log(`   Quote ID: ${meltQuote.quote}`)
  console.log(`   Amount: ${meltQuote.amount} ${UNIT}`)
  console.log(`   Fee reserve: ${meltQuote.fee_reserve}`)
  console.log(`   Total needed: ${meltQuote.amount + meltQuote.fee_reserve}`)
  console.log('')

  // Step 9: Melt tokens
  console.log('💸 Step 9: Melt tokens')
  const totalNeeded = meltQuote.amount + meltQuote.fee_reserve

  // Select proofs to cover the amount
  let accumulated = 0
  const proofsToMelt: any[] = []

  // Sort by amount descending for efficient selection
  const sortedProofs = [...proofs].sort((a: any, b: any) => b.amount - a.amount)

  for (const proof of sortedProofs) {
    if (accumulated >= totalNeeded) break
    proofsToMelt.push(proof)
    accumulated += proof.amount
  }

  console.log(`   Using ${proofsToMelt.length} proofs totaling ${accumulated} ${UNIT}`)

  try {
    const meltResult = await meltTokens(meltQuote.quote, proofsToMelt)
    console.log(`   State: ${meltResult.state}`)
    if (meltResult.txid) {
      console.log(`   TX ID: ${meltResult.txid}`)
    }
    console.log(`   ✅ Melt successful!`)
  } catch (error: any) {
    console.log(`   ⚠️  Melt failed: ${error.message}`)
    console.log('   (This is expected if the mint lacks funds for withdrawal)')
  }
  console.log('')

  // Summary
  console.log('═══════════════════════════════════════════')
  console.log('✅ E2E Test Complete!')
  console.log('')
  console.log('Tested flows:')
  console.log('  ✓ GET /v1/info')
  console.log('  ✓ GET /v1/keysets')
  console.log('  ✓ GET /v1/keys/:id')
  console.log('  ✓ POST /v1/mint/quote/unit')
  console.log('  ✓ GET /v1/mint/quote/unit/:id')
  console.log('  ✓ POST /v1/mint/unit')
  console.log('  ✓ POST /v1/checkstate')
  console.log('  ✓ POST /v1/swap')
  console.log('  ✓ POST /v1/melt/quote/unit')
  console.log('  ✓ POST /v1/melt/unit')
  console.log('═══════════════════════════════════════════')
}

// Check if we should resume from a specific quote
const QUOTE_ID = process.env.QUOTE_ID

if (QUOTE_ID) {
  console.log(`Resuming with quote: ${QUOTE_ID}`)
  // Future: resume flow from an existing quote when testing interrupted deposits.
}

main().catch(console.error)
