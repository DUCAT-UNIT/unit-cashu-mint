import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'crypto'
import { Point } from '@noble/secp256k1'
import { createHash } from 'crypto'
import { KeyManager } from '../../src/core/crypto/KeyManager.js'
import { MintCrypto } from '../../src/core/crypto/MintCrypto.js'
import { MintService } from '../../src/core/services/MintService.js'
import { SwapService } from '../../src/core/services/SwapService.js'
import { MeltService } from '../../src/core/services/MeltService.js'
import { KeysetRepository } from '../../src/database/repositories/KeysetRepository.js'
import { QuoteRepository } from '../../src/database/repositories/QuoteRepository.js'
import { ProofRepository } from '../../src/database/repositories/ProofRepository.js'
import { BlindedMessage, Proof } from '../../src/types/cashu.js'
import { testConnection } from '../../src/database/db.js'
import { MockRunesBackend } from '../mocks/RunesBackend.mock.js'

// Helper: Simple blinding for tests (not cryptographically secure, just for testing flow)
function blindMessage(secret: string, amount: number, keysetId: string): {
  blindedMessage: BlindedMessage
  blindingFactor: bigint
} {
  const r = BigInt('0x' + randomBytes(32).toString('hex'))

  // Hash secret to curve
  const DOMAIN_SEPARATOR = new Uint8Array([
    83, 101, 99, 112, 50, 53, 54, 107, 49, 95, 72, 97, 115, 104, 84, 111, 67, 117, 114, 118, 101, 95,
    67, 97, 115, 104, 117, 95,
  ])

  const sha256 = (data: Uint8Array): Uint8Array => {
    return new Uint8Array(createHash('sha256').update(data).digest())
  }

  const msgToHash = sha256(new Uint8Array([...DOMAIN_SEPARATOR, ...new TextEncoder().encode(secret)]))

  let Y: Point | null = null
  for (let counter = 0; counter < 2 ** 16; counter++) {
    const counterBytes = new Uint8Array(4)
    new DataView(counterBytes.buffer).setUint32(0, counter, true)
    const hash = sha256(new Uint8Array([...msgToHash, ...counterBytes]))

    try {
      Y = Point.fromHex('02' + Buffer.from(hash).toString('hex'))
      break
    } catch {
      continue
    }
  }

  if (!Y) throw new Error('Could not hash to curve')

  // Blind: B_ = Y + r*G
  const G = Point.BASE
  const B_ = Y.add(G.multiply(r))

  return {
    blindedMessage: {
      amount,
      B_: B_.toHex(true),
      id: keysetId,
    },
    blindingFactor: r,
  }
}

// Helper: Unblind signature
function unblindSignature(
  C_: string,
  r: bigint,
  publicKey: string
): string {
  const C_point = Point.fromHex(C_)
  const K = Point.fromHex(publicKey)

  // Unblind: C = C_ - r*K
  const C = C_point.subtract(K.multiply(r))

  return C.toHex(true)
}

describe('Mint Integration Tests', () => {
  let keyManager: KeyManager
  let mintCrypto: MintCrypto
  let mintService: MintService
  let swapService: SwapService
  let meltService: MeltService

  let keysetRepo: KeysetRepository
  let quoteRepo: QuoteRepository
  let proofRepo: ProofRepository
  let runesBackend: MockRunesBackend

  let testKeysetId: string
  let testPublicKeys: Record<number, string>

  const RUNE_ID = '840000:3' // DUCAT•UNIT•RUNE
  const UNIT = 'unit' // UNIT tokens, not sats!

  beforeAll(async () => {
    // Test database connection
    await testConnection()

    // Initialize repositories
    keysetRepo = new KeysetRepository()
    quoteRepo = new QuoteRepository()
    proofRepo = new ProofRepository()

    // Initialize mock Runes backend
    runesBackend = new MockRunesBackend()

    // Set initial balance for tests (100 million sats worth of runes)
    runesBackend.setBalance(RUNE_ID, 100_000_000n)

    // Initialize crypto
    keyManager = new KeyManager(keysetRepo)
    mintCrypto = new MintCrypto(keyManager)

    // Initialize services with RunesBackend
    mintService = new MintService(mintCrypto, quoteRepo, runesBackend)
    swapService = new SwapService(mintCrypto, proofRepo)
    meltService = new MeltService(mintCrypto, quoteRepo, proofRepo, runesBackend)

    // Generate a test keyset
    const keyset = await keyManager.generateKeyset(RUNE_ID, UNIT)
    testKeysetId = keyset.id
    testPublicKeys = keyset.public_keys

    console.log('Test keyset generated:', testKeysetId)
  })

  describe('Mint Flow', () => {
    it('should create a mint quote', async () => {
      const amount = 1000

      const quote = await mintService.createMintQuote(amount, UNIT, RUNE_ID)

      expect(quote.quote).toBeDefined()
      expect(quote.quote).toHaveLength(64) // 32 bytes hex
      expect(quote.amount).toBe(amount)
      expect(quote.unit).toBe(UNIT)
      expect(quote.state).toBe('UNPAID')
      expect(quote.request).toMatch(/^bc1p/) // Bitcoin address
      expect(quote.expiry).toBeGreaterThan(Date.now() / 1000)
    })

    it('should get mint quote status', async () => {
      const amount = 2000
      const created = await mintService.createMintQuote(amount, UNIT, RUNE_ID)

      const quote = await mintService.getMintQuote(created.quote)

      expect(quote.quote).toBe(created.quote)
      expect(quote.state).toBe('UNPAID')
      expect(quote.amount).toBe(amount)
    })

    it('should mint tokens after quote is paid', async () => {
      const amount = 1024 // 1024 = perfect split into denominations

      // 1. Create quote
      const quote = await mintService.createMintQuote(amount, UNIT, RUNE_ID)

      // 2. Simulate payment by updating quote state
      await quoteRepo.updateMintQuoteState(quote.quote, 'PAID')

      // 3. Create blinded messages for the amount
      // Split 1024 into denominations: 1024
      const secrets = [randomBytes(32).toString('hex')]
      const blindedMessages: BlindedMessage[] = []
      const blindingFactors: bigint[] = []

      const { blindedMessage, blindingFactor } = blindMessage(secrets[0], 1024, testKeysetId)
      blindedMessages.push(blindedMessage)
      blindingFactors.push(blindingFactor)

      // 4. Mint tokens
      const result = await mintService.mintTokens(quote.quote, blindedMessages)

      expect(result.signatures).toHaveLength(1)
      expect(result.signatures[0].amount).toBe(1024)
      expect(result.signatures[0].id).toBe(testKeysetId)
      expect(result.signatures[0].C_).toBeDefined()

      // 5. Verify quote is now ISSUED
      const updatedQuote = await mintService.getMintQuote(quote.quote)
      expect(updatedQuote.state).toBe('ISSUED')
    })

    it('should reject minting with unpaid quote', async () => {
      const amount = 512
      const quote = await mintService.createMintQuote(amount, UNIT, RUNE_ID)

      const { blindedMessage } = blindMessage(randomBytes(32).toString('hex'), 512, testKeysetId)

      await expect(
        mintService.mintTokens(quote.quote, [blindedMessage])
      ).rejects.toThrow('not paid')
    })

    it('should reject minting with amount mismatch', async () => {
      const amount = 1000
      const quote = await mintService.createMintQuote(amount, UNIT, RUNE_ID)
      await quoteRepo.updateMintQuoteState(quote.quote, 'PAID')

      // Try to mint 512 instead of 1000
      const { blindedMessage } = blindMessage(randomBytes(32).toString('hex'), 512, testKeysetId)

      await expect(
        mintService.mintTokens(quote.quote, [blindedMessage])
      ).rejects.toThrow('mismatch')
    })
  })

  describe('Swap Flow', () => {
    let validProofs: Proof[]

    beforeAll(async () => {
      // Mint some tokens first
      const amount = 2048
      const quote = await mintService.createMintQuote(amount, UNIT, RUNE_ID)
      await quoteRepo.updateMintQuoteState(quote.quote, 'PAID')

      // Create 2 proofs: 1024 + 1024
      const secrets = [
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
      ]

      const blindedMessages: BlindedMessage[] = []
      const blindingFactors: bigint[] = []

      for (let i = 0; i < 2; i++) {
        const { blindedMessage, blindingFactor } = blindMessage(secrets[i], 1024, testKeysetId)
        blindedMessages.push(blindedMessage)
        blindingFactors.push(blindingFactor)
      }

      const result = await mintService.mintTokens(quote.quote, blindedMessages)

      // Unblind signatures to create proofs
      validProofs = result.signatures.map((sig, i) => {
        const C = unblindSignature(sig.C_, blindingFactors[i], testPublicKeys[sig.amount])

        return {
          id: sig.id,
          amount: sig.amount,
          secret: secrets[i],
          C,
        }
      })

      console.log('Valid proofs created for swap tests')
    })

    it('should swap proofs for new signatures', async () => {
      // Swap 2x1024 for 4x512
      const newSecrets = [
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
      ]

      const outputs: BlindedMessage[] = []
      for (const secret of newSecrets) {
        const { blindedMessage } = blindMessage(secret, 512, testKeysetId)
        outputs.push(blindedMessage)
      }

      const result = await swapService.swap(validProofs, outputs)

      expect(result.signatures).toHaveLength(4)
      expect(result.signatures.every(s => s.amount === 512)).toBe(true)
    })

    it('should reject swap with amount mismatch', async () => {
      const { blindedMessage } = blindMessage(randomBytes(32).toString('hex'), 1000, testKeysetId)

      await expect(
        swapService.swap(validProofs, [blindedMessage])
      ).rejects.toThrow('mismatch')
    })

    it('should reject swap with invalid proof signature', async () => {
      const invalidProof: Proof = {
        id: testKeysetId,
        amount: 1024,
        secret: randomBytes(32).toString('hex'),
        C: Point.BASE.toHex(true), // Invalid C
      }

      const { blindedMessage } = blindMessage(randomBytes(32).toString('hex'), 1024, testKeysetId)

      await expect(
        swapService.swap([invalidProof], [blindedMessage])
      ).rejects.toThrow('Invalid')
    })

    it('should prevent double spending', async () => {
      // Create fresh proofs for this test
      const amount = 2048
      const quote = await mintService.createMintQuote(amount, UNIT, RUNE_ID)
      await quoteRepo.updateMintQuoteState(quote.quote, 'PAID')

      const secrets = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
      const blindedMessages: BlindedMessage[] = []
      const blindingFactors: bigint[] = []

      for (const secret of secrets) {
        const { blindedMessage, blindingFactor } = blindMessage(secret, 1024, testKeysetId)
        blindedMessages.push(blindedMessage)
        blindingFactors.push(blindingFactor)
      }

      const result = await mintService.mintTokens(quote.quote, blindedMessages)

      // Unblind to create proofs
      const proofs: Proof[] = result.signatures.map((sig, i) => {
        const C = unblindSignature(sig.C_, blindingFactors[i], testPublicKeys[sig.amount])
        return {
          id: sig.id,
          amount: sig.amount,
          secret: secrets[i],
          C
        }
      })

      // First swap should succeed
      const { blindedMessage: output1 } = blindMessage(randomBytes(32).toString('hex'), 2048, testKeysetId)
      await swapService.swap(proofs, [output1])

      // Second swap with same proofs should fail with ProofAlreadySpentError
      const { blindedMessage: output2 } = blindMessage(randomBytes(32).toString('hex'), 2048, testKeysetId)

      // Should throw error
      let error: any
      try {
        await swapService.swap(proofs, [output2])
      } catch (err) {
        error = err
      }

      // Verify error was thrown with correct properties
      expect(error).toBeDefined()
      expect(error.message).toContain('spent')
      expect(error.code).toBe(11001)
    })
  })

  describe('Melt Flow', () => {
    let freshProofs: Proof[]

    beforeAll(async () => {
      // Mint fresh tokens for melt tests
      const amount = 4096
      const quote = await mintService.createMintQuote(amount, UNIT, RUNE_ID)
      await quoteRepo.updateMintQuoteState(quote.quote, 'PAID')

      const secrets = [
        randomBytes(32).toString('hex'),
        randomBytes(32).toString('hex'),
      ]

      const blindedMessages: BlindedMessage[] = []
      const blindingFactors: bigint[] = []

      for (let i = 0; i < 2; i++) {
        const { blindedMessage, blindingFactor } = blindMessage(secrets[i], 2048, testKeysetId)
        blindedMessages.push(blindedMessage)
        blindingFactors.push(blindingFactor)
      }

      const result = await mintService.mintTokens(quote.quote, blindedMessages)

      freshProofs = result.signatures.map((sig, i) => {
        const C = unblindSignature(sig.C_, blindingFactors[i], testPublicKeys[sig.amount])

        return {
          id: sig.id,
          amount: sig.amount,
          secret: secrets[i],
          C,
        }
      })

      console.log('Fresh proofs created for melt tests')
    })

    it('should create a melt quote', async () => {
      const amount = 3000
      const destination = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

      const quote = await meltService.createMeltQuote(amount, UNIT, RUNE_ID, destination)

      expect(quote.quote).toBeDefined()
      expect(quote.quote).toHaveLength(64)
      expect(quote.amount).toBe(amount)
      expect(quote.unit).toBe(UNIT)
      expect(quote.state).toBe('UNPAID')
      expect(quote.request).toBe(destination)
      expect(quote.fee_reserve).toBeGreaterThan(0)
      expect(quote.expiry).toBeGreaterThan(Date.now() / 1000)
    })

    it('should get melt quote status', async () => {
      const amount = 2000
      const destination = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

      const created = await meltService.createMeltQuote(amount, UNIT, RUNE_ID, destination)
      const quote = await meltService.getMeltQuote(created.quote)

      expect(quote.quote).toBe(created.quote)
      expect(quote.state).toBe('UNPAID')
      expect(quote.amount).toBe(amount)
    })

    it('should melt tokens and complete withdrawal', async () => {
      const amount = 3000
      const destination = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

      // 1. Create melt quote
      const quote = await meltService.createMeltQuote(amount, UNIT, RUNE_ID, destination)

      // 2. Melt tokens (4096 total from freshProofs covers 3000 + fee)
      const result = await meltService.meltTokens(quote.quote, freshProofs)

      // With the RunesBackend integration, withdrawal completes immediately in tests
      expect(result.state).toBe('PAID')
      expect(result.txid).toBeDefined()

      // 3. Verify quote is PAID
      const updatedQuote = await meltService.getMeltQuote(quote.quote)
      expect(updatedQuote.state).toBe('PAID')
      expect(updatedQuote.txid).toBeDefined()

      // 4. Verify proofs are spent
      const Y_values = freshProofs.map(p => mintCrypto.hashSecret(p.secret))
      const spent = await proofRepo.checkSpent(Y_values)
      expect(spent).toHaveLength(2)
    })

    it('should complete melt automatically with RunesBackend', async () => {
      const amount = 1000
      const destination = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

      // Create and mint tokens
      const mintQuote = await mintService.createMintQuote(2048, UNIT, RUNE_ID)
      await quoteRepo.updateMintQuoteState(mintQuote.quote, 'PAID')

      const secret = randomBytes(32).toString('hex')
      const { blindedMessage, blindingFactor } = blindMessage(secret, 2048, testKeysetId)
      const mintResult = await mintService.mintTokens(mintQuote.quote, [blindedMessage])

      const proof: Proof = {
        id: testKeysetId,
        amount: 2048,
        secret,
        C: unblindSignature(mintResult.signatures[0].C_, blindingFactor, testPublicKeys[2048]),
      }

      // Create melt quote and melt
      const meltQuote = await meltService.createMeltQuote(amount, UNIT, RUNE_ID, destination)
      const result = await meltService.meltTokens(meltQuote.quote, [proof])

      // Melt completes immediately with mock RunesBackend
      expect(result.state).toBe('PAID')
      expect(result.txid).toBeDefined()

      // Verify quote is PAID
      const completedQuote = await meltService.getMeltQuote(meltQuote.quote)
      expect(completedQuote.state).toBe('PAID')
      expect(completedQuote.txid).toBeDefined()
    })

    it('should reject melt with insufficient amount', async () => {
      const amount = 10000 // More than we have
      const destination = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

      const quote = await meltService.createMeltQuote(amount, UNIT, RUNE_ID, destination)

      // Mint small amount
      const mintQuote = await mintService.createMintQuote(1024, UNIT, RUNE_ID)
      await quoteRepo.updateMintQuoteState(mintQuote.quote, 'PAID')

      const secret = randomBytes(32).toString('hex')
      const { blindedMessage, blindingFactor } = blindMessage(secret, 1024, testKeysetId)
      const mintResult = await mintService.mintTokens(mintQuote.quote, [blindedMessage])

      const proof: Proof = {
        id: testKeysetId,
        amount: 1024,
        secret,
        C: unblindSignature(mintResult.signatures[0].C_, blindingFactor, testPublicKeys[1024]),
      }

      await expect(
        meltService.meltTokens(quote.quote, [proof])
      ).rejects.toThrow('mismatch')
    })
  })

  describe('End-to-End Flow', () => {
    it('should complete full lifecycle: mint → swap → melt', async () => {
      const initialAmount = 8192

      // 1. MINT: Create quote and mint tokens
      const mintQuote = await mintService.createMintQuote(initialAmount, UNIT, RUNE_ID)
      await quoteRepo.updateMintQuoteState(mintQuote.quote, 'PAID')

      // Mint as 2x4096
      const mintSecrets = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
      const mintBlinded: BlindedMessage[] = []
      const mintBlindingFactors: bigint[] = []

      for (const secret of mintSecrets) {
        const { blindedMessage, blindingFactor } = blindMessage(secret, 4096, testKeysetId)
        mintBlinded.push(blindedMessage)
        mintBlindingFactors.push(blindingFactor)
      }

      const mintResult = await mintService.mintTokens(mintQuote.quote, mintBlinded)

      const proofs: Proof[] = mintResult.signatures.map((sig, i) => ({
        id: sig.id,
        amount: sig.amount,
        secret: mintSecrets[i],
        C: unblindSignature(sig.C_, mintBlindingFactors[i], testPublicKeys[sig.amount]),
      }))

      // 2. SWAP: Split into smaller denominations (8x1024)
      const swapSecrets = Array.from({ length: 8 }, () => randomBytes(32).toString('hex'))
      const swapOutputs: BlindedMessage[] = []
      const swapBlindingFactors: bigint[] = []

      for (const secret of swapSecrets) {
        const { blindedMessage, blindingFactor } = blindMessage(secret, 1024, testKeysetId)
        swapOutputs.push(blindedMessage)
        swapBlindingFactors.push(blindingFactor)
      }

      const swapResult = await swapService.swap(proofs, swapOutputs)

      const swappedProofs: Proof[] = swapResult.signatures.map((sig, i) => ({
        id: sig.id,
        amount: sig.amount,
        secret: swapSecrets[i],
        C: unblindSignature(sig.C_, swapBlindingFactors[i], testPublicKeys[sig.amount]),
      }))

      // 3. MELT: Redeem 5x1024 = 5120 sats
      // But we need to provide exactly amount + fee_reserve
      const meltAmount = 5000
      const destination = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'

      const meltQuote = await meltService.createMeltQuote(meltAmount, UNIT, RUNE_ID, destination)

      // Quote requires amount + fee_reserve (5000 + 1000 = 6000)
      // Use 6 proofs for melt (6 * 1024 = 6144, which covers 6000)
      const proofsToMelt = swappedProofs.slice(0, 6)
      const meltResult = await meltService.meltTokens(meltQuote.quote, proofsToMelt)

      // Melt completes immediately with mock RunesBackend
      expect(meltResult.state).toBe('PAID')
      expect(meltResult.txid).toBeDefined()

      const finalQuote = await meltService.getMeltQuote(meltQuote.quote)
      expect(finalQuote.state).toBe('PAID')
      expect(finalQuote.txid).toBeDefined()

      console.log('✅ Full lifecycle complete: Mint → Swap → Melt')
    })
  })
})
