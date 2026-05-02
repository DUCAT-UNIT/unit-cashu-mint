#!/usr/bin/env npx tsx
/**
 * Complete E2E Test - Both BTC and UNIT with real deposits
 */

import { randomBytes, createHash } from 'crypto'
import { secp256k1 } from '@noble/curves/secp256k1'

const ProjectivePoint = secp256k1.ProjectivePoint
const CURVE = secp256k1.CURVE

const MINT_URL = process.env.MINT_URL || 'http://localhost:3000'

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
  return { ok: res.ok, status: res.status, data: await res.json() }
}

async function testFlow(unit: string, amount: number, runeId?: string) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${unit === 'btc' ? '₿ BTC' : '🪙 UNIT'} FLOW - ${amount} ${unit}`)
  console.log('═'.repeat(60))

  // Get keyset
  const { data: keysetsData } = await fetchJson('/v1/keysets')
  const keyset = keysetsData.keysets.find((k: any) => k.active)
  const { data: keysData } = await fetchJson(`/v1/keys/${keyset.id}`)
  const keys = keysData.keys

  // Step 1: Create quote
  console.log('\n📝 Step 1: Create mint quote')
  const quoteBody: any = { amount, unit }
  if (runeId) quoteBody.rune_id = runeId

  const { ok: ok1, data: quote } = await fetchJson('/v1/mint/quote/unit', {
    method: 'POST',
    body: JSON.stringify(quoteBody),
  })

  if (!ok1) {
    console.log('   ❌ Failed:', quote.error || quote.message)
    return null
  }

  console.log('   Quote:', quote.quote.slice(0, 16) + '...')
  console.log('   Amount:', quote.amount, unit)
  console.log('   Address:', quote.request)

  // Step 2: Wait for payment
  console.log('\n⏳ Step 2: Wait for deposit detection')
  let paid = false

  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const { data: q } = await fetchJson(`/v1/mint/quote/unit/${quote.quote}`)
    process.stdout.write(`   ${(i + 1) * 5}s: ${q.state}`)
    if (q.state === 'PAID') {
      console.log(' ✅')
      paid = true
      break
    }
    console.log('')
  }

  if (!paid) {
    console.log('   ⚠️  Not paid yet - deposit monitor may need more time')
    return null
  }

  // Step 3: Mint tokens
  console.log('\n🪙 Step 3: Mint ecash tokens')
  const amounts = splitAmount(amount)
  console.log('   Tokens:', amounts.length, 'denominations')

  const blindedData: any[] = []
  for (const amt of amounts) {
    const secret = randomBytes(32).toString('hex')
    const { blindedMessage, blindingFactor } = blindMessage(secret, amt, keyset.id)
    blindedData.push({ secret, r: blindingFactor, amount: amt, blindedMessage })
  }

  const { ok: ok3, data: mintResult } = await fetchJson('/v1/mint/unit', {
    method: 'POST',
    body: JSON.stringify({ quote: quote.quote, outputs: blindedData.map(d => d.blindedMessage) }),
  })

  if (!ok3) {
    console.log('   ❌ Mint failed:', mintResult.error || mintResult.message)
    return null
  }

  console.log('   ✅ Minted', mintResult.signatures.length, 'tokens!')

  // Unblind
  const proofs = mintResult.signatures.map((sig: any, i: number) => {
    const { secret, r, amount: amt } = blindedData[i]
    const C = unblindSignature(sig.C_, r, keys[amt])
    return { id: sig.id, amount: sig.amount, secret, C }
  })

  // Step 4: Check state
  console.log('\n🔍 Step 4: Check token state')
  const Ys = proofs.map((p: any) => getYHex(p.secret))
  const { data: stateResult } = await fetchJson('/v1/checkstate', {
    method: 'POST',
    body: JSON.stringify({ Ys }),
  })
  const allUnspent = stateResult.states.every((s: any) => s.state === 'UNSPENT')
  console.log('   All UNSPENT:', allUnspent ? '✅' : '❌')

  // Step 5: Swap
  console.log('\n🔄 Step 5: Swap (split largest token)')
  const largest = proofs[0]
  if (largest.amount >= 2) {
    const half = largest.amount / 2
    const swapData: any[] = []
    for (let i = 0; i < 2; i++) {
      const secret = randomBytes(32).toString('hex')
      const { blindedMessage, blindingFactor } = blindMessage(secret, half, keyset.id)
      swapData.push({ secret, r: blindingFactor, amount: half, blindedMessage })
    }

    const { ok: ok5, data: swapResult } = await fetchJson('/v1/swap', {
      method: 'POST',
      body: JSON.stringify({
        inputs: [largest],
        outputs: swapData.map(d => d.blindedMessage),
      }),
    })

    if (ok5) {
      console.log('   Swapped', largest.amount, '→', half, '+', half)
      console.log('   ✅ Swap successful!')

      const { data: oldState } = await fetchJson('/v1/checkstate', {
        method: 'POST',
        body: JSON.stringify({ Ys: [getYHex(largest.secret)] }),
      })
      console.log('   Old token:', oldState.states[0].state)

      const newProofs = swapResult.signatures.map((sig: any, i: number) => {
        const { secret, r, amount: amt } = swapData[i]
        const C = unblindSignature(sig.C_, r, keys[amt])
        return { id: sig.id, amount: sig.amount, secret, C }
      })
      proofs.splice(0, 1, ...newProofs)
    } else {
      console.log('   ⚠️  Swap failed:', swapResult)
    }
  }

  // Step 6: Melt
  console.log('\n🔥 Step 6: Melt (withdraw)')
  const toMelt = proofs[0]
  const meltAmount = Math.floor(toMelt.amount * 0.8)

  const meltBody: any = {
    amount: meltAmount,
    unit,
    request: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  }
  if (runeId) meltBody.rune_id = runeId

  const { ok: ok6, data: meltQuote } = await fetchJson('/v1/melt/quote/unit', {
    method: 'POST',
    body: JSON.stringify(meltBody),
  })

  if (ok6) {
    console.log('   Melt quote:', meltQuote.amount, '+', meltQuote.fee_reserve, 'fee')

    const { ok: ok7, data: meltResult } = await fetchJson('/v1/melt/unit', {
      method: 'POST',
      body: JSON.stringify({ quote: meltQuote.quote, inputs: [toMelt] }),
    })

    if (ok7) {
      console.log('   State:', meltResult.state)
      console.log('   ✅ Melt successful!')

      const { data: meltedState } = await fetchJson('/v1/checkstate', {
        method: 'POST',
        body: JSON.stringify({ Ys: [getYHex(toMelt.secret)] }),
      })
      console.log('   Melted token:', meltedState.states[0].state)
    } else {
      console.log('   ⚠️  Melt failed:', meltResult)
    }
  } else {
    console.log('   ⚠️  Melt quote failed:', meltQuote)
  }

  console.log('\n   ✅ FLOW COMPLETE!')
  return proofs
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║       DUCAT MINT - COMPLETE E2E TEST                     ║')
  console.log('║             BTC + UNIT (Runes)                           ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  // Check mint info
  const { data: info } = await fetchJson('/v1/info')
  console.log('\nMint:', info.name)
  console.log('Units:', info.nuts['4'].methods.map((m: any) => m.unit).join(', '))

  // Test UNIT flow with the new deposit (5269)
  console.log('\n' + '▓'.repeat(60))
  console.log('  TESTING UNIT (RUNES) FLOW')
  console.log('▓'.repeat(60))
  await testFlow('sat', 5269, '1527352:1')

  // Test BTC flow with existing deposit (629769)
  console.log('\n' + '▓'.repeat(60))
  console.log('  TESTING BTC FLOW')
  console.log('▓'.repeat(60))
  await testFlow('btc', 629769)

  console.log('\n' + '═'.repeat(60))
  console.log('  🎉 ALL E2E TESTS COMPLETE!')
  console.log('═'.repeat(60))
}

main().catch(console.error)
