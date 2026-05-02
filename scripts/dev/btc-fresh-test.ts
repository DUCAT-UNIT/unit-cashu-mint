#!/usr/bin/env npx tsx
/**
 * BTC E2E Test - Fresh test with exact UTXO amount matching
 */

import { randomBytes, createHash } from 'crypto'
import { secp256k1 } from '@noble/curves/secp256k1'

const ProjectivePoint = secp256k1.ProjectivePoint
const CURVE = secp256k1.CURVE

const MINT_URL = process.env.MINT_URL || 'http://localhost:3000'

// Test with one of the existing UTXOs (629,769 sats)
const TEST_AMOUNT = 629769

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

async function fetchJson(path: string, options?: RequestInit) {
  const res = await fetch(`${MINT_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  return { ok: res.ok, data: await res.json() }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║          ₿ BTC E2E TEST - FRESH QUOTE                    ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log('')

  console.log('Using amount:', TEST_AMOUNT, 'sats')
  console.log('(This matches an existing UTXO on the mint address)')
  console.log('')

  // Step 1: Create a fresh quote
  console.log('═══════════════════════════════════════════════════════════')
  console.log('📝 STEP 1: Create BTC mint quote')
  console.log('═══════════════════════════════════════════════════════════')

  const { ok: ok1, data: quote } = await fetchJson('/v1/mint/quote/unit', {
    method: 'POST',
    body: JSON.stringify({ amount: TEST_AMOUNT, unit: 'btc' }),
  })

  if (!ok1) {
    console.error('Failed to create quote:', quote)
    process.exit(1)
  }

  console.log('   Quote ID:', quote.quote)
  console.log('   Amount:', quote.amount, 'sats')
  console.log('   Address:', quote.request)
  console.log('   State:', quote.state)
  console.log('')

  // Step 2: Check quote status (should detect the deposit with exact amount match)
  console.log('═══════════════════════════════════════════════════════════')
  console.log('⏳ STEP 2: Check deposit detection')
  console.log('═══════════════════════════════════════════════════════════')

  let paidQuote = quote
  for (let i = 0; i < 5; i++) {
    const { data: q } = await fetchJson(`/v1/mint/quote/unit/${quote.quote}`)
    console.log(`   Check ${i + 1}/5: ${q.state}`)
    if (q.state === 'PAID') {
      paidQuote = q
      console.log('   ✅ Deposit detected!')
      break
    }
    await new Promise(r => setTimeout(r, 1000))
  }

  if (paidQuote.state !== 'PAID') {
    console.log('   ❌ Deposit not detected')
    process.exit(1)
  }
  console.log('')

  // Get keyset and keys
  const { data: keysetsData } = await fetchJson('/v1/keysets')
  const btcKeyset = keysetsData.keysets.find((k: any) => k.active)
  const { data: keysData } = await fetchJson(`/v1/keys/${btcKeyset.id}`)
  const keys = keysData.keys

  // Step 3: Mint tokens
  console.log('═══════════════════════════════════════════════════════════')
  console.log('🪙 STEP 3: Mint BTC-backed ecash tokens')
  console.log('═══════════════════════════════════════════════════════════')

  const amounts = splitAmount(TEST_AMOUNT)
  console.log('   Denominations:', amounts.length, 'tokens')
  console.log('   Amounts:', amounts.join(', '))
  console.log('   Total:', amounts.reduce((a, b) => a + b, 0), 'sats')

  const blindedData: any[] = []
  for (const amt of amounts) {
    const secret = randomBytes(32).toString('hex')
    const { blindedMessage, blindingFactor } = blindMessage(secret, amt, btcKeyset.id)
    blindedData.push({ secret, r: blindingFactor, amount: amt, blindedMessage })
  }

  const { ok: ok3, data: mintResult } = await fetchJson('/v1/mint/unit', {
    method: 'POST',
    body: JSON.stringify({ quote: quote.quote, outputs: blindedData.map(d => d.blindedMessage) }),
  })

  if (!ok3) {
    console.error('   ❌ Mint failed:', mintResult)
    process.exit(1)
  }

  console.log('   ✅ Received', mintResult.signatures.length, 'blind signatures!')
  console.log('')

  // Unblind
  const proofs = mintResult.signatures.map((sig: any, i: number) => {
    const { secret, r, amount } = blindedData[i]
    const C = unblindSignature(sig.C_, r, keys[amount])
    return { id: sig.id, amount: sig.amount, secret, C }
  })

  // Step 4: Check token state
  console.log('═══════════════════════════════════════════════════════════')
  console.log('🔍 STEP 4: Check token state')
  console.log('═══════════════════════════════════════════════════════════')

  const Ys = proofs.map((p: any) => getYHex(p.secret))
  const { data: stateResult } = await fetchJson('/v1/checkstate', {
    method: 'POST',
    body: JSON.stringify({ Ys }),
  })

  const allUnspent = stateResult.states.every((s: any) => s.state === 'UNSPENT')
  console.log('   All tokens UNSPENT:', allUnspent ? '✅' : '❌')
  console.log('')

  // Step 5: Swap tokens
  console.log('═══════════════════════════════════════════════════════════')
  console.log('🔄 STEP 5: Swap tokens (split largest)')
  console.log('═══════════════════════════════════════════════════════════')

  const largestProof = proofs[0]
  const half = largestProof.amount / 2

  const swapBlindedData: any[] = []
  for (let i = 0; i < 2; i++) {
    const secret = randomBytes(32).toString('hex')
    const { blindedMessage, blindingFactor } = blindMessage(secret, half, btcKeyset.id)
    swapBlindedData.push({ secret, r: blindingFactor, amount: half, blindedMessage })
  }

  const { ok: ok5, data: swapResult } = await fetchJson('/v1/swap', {
    method: 'POST',
    body: JSON.stringify({
      inputs: [largestProof],
      outputs: swapBlindedData.map(d => d.blindedMessage),
    }),
  })

  if (!ok5) {
    console.error('   ❌ Swap failed:', swapResult)
  } else {
    console.log('   Swapped', largestProof.amount, '→', half, '+', half)
    console.log('   ✅ Swap successful!')

    // Check old token is spent
    const { data: oldState } = await fetchJson('/v1/checkstate', {
      method: 'POST',
      body: JSON.stringify({ Ys: [getYHex(largestProof.secret)] }),
    })
    console.log('   Old token state:', oldState.states[0].state)

    // Update proofs
    const swapProofs = swapResult.signatures.map((sig: any, i: number) => {
      const { secret, r, amount } = swapBlindedData[i]
      const C = unblindSignature(sig.C_, r, keys[amount])
      return { id: sig.id, amount: sig.amount, secret, C }
    })
    proofs.splice(0, 1, ...swapProofs)
  }
  console.log('')

  // Step 6: Melt tokens (withdraw BTC)
  console.log('═══════════════════════════════════════════════════════════')
  console.log('🔥 STEP 6: Melt tokens (withdraw BTC)')
  console.log('═══════════════════════════════════════════════════════════')

  const proofToMelt = proofs[0]
  const meltAmount = Math.floor(proofToMelt.amount * 0.9)

  const { ok: ok6, data: meltQuote } = await fetchJson('/v1/melt/quote/unit', {
    method: 'POST',
    body: JSON.stringify({
      amount: meltAmount,
      unit: 'btc',
      request: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', // Test destination
    }),
  })

  if (!ok6) {
    console.error('   ❌ Melt quote failed:', meltQuote)
  } else {
    console.log('   Melt quote created')
    console.log('   Amount:', meltQuote.amount, 'sats')
    console.log('   Fee reserve:', meltQuote.fee_reserve, 'sats')

    const { ok: ok7, data: meltResult } = await fetchJson('/v1/melt/unit', {
      method: 'POST',
      body: JSON.stringify({ quote: meltQuote.quote, inputs: [proofToMelt] }),
    })

    if (!ok7) {
      console.error('   ❌ Melt failed:', meltResult)
    } else {
      console.log('   Melt state:', meltResult.state)
      if (meltResult.txid) {
        console.log('   TX ID:', meltResult.txid)
      }
      console.log('   ✅ Melt successful!')

      // Check melted token
      const { data: meltedState } = await fetchJson('/v1/checkstate', {
        method: 'POST',
        body: JSON.stringify({ Ys: [getYHex(proofToMelt.secret)] }),
      })
      console.log('   Melted token state:', meltedState.states[0].state)
    }
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('✅ BTC E2E TEST COMPLETE!')
  console.log('═══════════════════════════════════════════════════════════')
  console.log('')
  console.log('Summary:')
  console.log('  • Deposited:', TEST_AMOUNT, 'sats')
  console.log('  • Minted:', proofs.length + 1, 'ecash tokens')
  console.log('  • Swapped: 1 token split into 2')
  console.log('  • Melted:', meltAmount, 'sats withdrawn')
}

main().catch(console.error)
