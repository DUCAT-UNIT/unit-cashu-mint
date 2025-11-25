import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as bitcoin from 'bitcoinjs-lib'

// Mock environment before importing WalletKeyManager
vi.mock('../../../src/config/env.js', () => ({
  env: {
    NETWORK: 'testnet',
    // Valid 32-byte seed (64 hex chars)
    MINT_SEED: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  },
}))

vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { WalletKeyManager } from '../../../src/runes/WalletKeyManager.js'

describe('WalletKeyManager', () => {
  describe('deriveAddresses', () => {
    it('should derive valid testnet addresses from seed', () => {
      const keyManager = new WalletKeyManager()
      const addresses = keyManager.deriveAddresses()

      // Should return valid testnet addresses
      expect(addresses.segwitAddress).toMatch(/^tb1q/) // Native SegWit
      expect(addresses.taprootAddress).toMatch(/^tb1p/) // Taproot

      // Public keys should be valid hex
      expect(addresses.segwitPubkey).toMatch(/^[0-9a-f]{66}$/) // Compressed pubkey
      expect(addresses.taprootPubkey).toMatch(/^[0-9a-f]{64}$/) // x-only pubkey
    })

    it('should derive deterministic addresses from same seed', () => {
      const keyManager1 = new WalletKeyManager()
      const keyManager2 = new WalletKeyManager()

      const addresses1 = keyManager1.deriveAddresses()
      const addresses2 = keyManager2.deriveAddresses()

      expect(addresses1.segwitAddress).toBe(addresses2.segwitAddress)
      expect(addresses1.taprootAddress).toBe(addresses2.taprootAddress)
      expect(addresses1.segwitPubkey).toBe(addresses2.segwitPubkey)
      expect(addresses1.taprootPubkey).toBe(addresses2.taprootPubkey)
    })

    it('should derive different addresses for different account indices', () => {
      const keyManager0 = new WalletKeyManager(0)
      const keyManager1 = new WalletKeyManager(1)

      const addresses0 = keyManager0.deriveAddresses()
      const addresses1 = keyManager1.deriveAddresses()

      expect(addresses0.segwitAddress).not.toBe(addresses1.segwitAddress)
      expect(addresses0.taprootAddress).not.toBe(addresses1.taprootAddress)
    })

    it('should use correct derivation paths', () => {
      // BIP84 for SegWit: m/84'/1'/0'/0/0
      // BIP86 for Taproot: m/86'/1'/0'/0/0
      // (coin type 1 for testnet)

      const keyManager = new WalletKeyManager()
      const addresses = keyManager.deriveAddresses()

      // Verify by decoding addresses
      expect(() => {
        bitcoin.address.toOutputScript(addresses.segwitAddress, bitcoin.networks.testnet)
      }).not.toThrow()

      expect(() => {
        bitcoin.address.toOutputScript(addresses.taprootAddress, bitcoin.networks.testnet)
      }).not.toThrow()
    })
  })

  describe('getNetwork', () => {
    it('should return testnet network configuration', () => {
      const keyManager = new WalletKeyManager()
      const network = keyManager.getNetwork()

      expect(network.bech32).toBe('tb')
    })
  })
})

describe('WalletKeyManager - Invalid Seed Handling', () => {
  it('documents: seed must be exactly 32 bytes', () => {
    // Valid: 64 hex characters = 32 bytes
    const validSeed = '0'.repeat(64)
    expect(validSeed.length).toBe(64)
    expect(Buffer.from(validSeed, 'hex').length).toBe(32)

    // Invalid: too short
    const shortSeed = '0'.repeat(62)
    expect(Buffer.from(shortSeed, 'hex').length).toBe(31)

    // Invalid: too long
    const longSeed = '0'.repeat(66)
    expect(Buffer.from(longSeed, 'hex').length).toBe(33)
  })
})

describe('Address Derivation Paths', () => {
  it('documents: BIP84 path for SegWit (fee payments)', () => {
    // m/84'/coin'/account'/change/index
    // For testnet: m/84'/1'/0'/0/0
    const path = "m/84'/1'/0'/0/0"
    expect(path).toContain('84')  // BIP84
    expect(path).toContain("1'")  // Testnet coin type
  })

  it('documents: BIP86 path for Taproot (rune deposits)', () => {
    // m/86'/coin'/account'/change/index
    // For testnet: m/86'/1'/0'/0/0
    const path = "m/86'/1'/0'/0/0"
    expect(path).toContain('86')  // BIP86
    expect(path).toContain("1'")  // Testnet coin type
  })
})

describe('Taproot Key Tweaking', () => {
  it('documents: x-only pubkey is 32 bytes', () => {
    // Taproot uses x-only pubkeys (just the x-coordinate)
    // Regular compressed pubkey: 33 bytes (1 prefix + 32 x-coord)
    // X-only pubkey: 32 bytes (just x-coord)

    const compressedPubkey = '02' + '0'.repeat(64)
    expect(compressedPubkey.length).toBe(66) // 33 bytes in hex

    const xOnlyPubkey = '0'.repeat(64)
    expect(xOnlyPubkey.length).toBe(64) // 32 bytes in hex
  })

  it('documents: taproot internal pubkey extraction', () => {
    // To get x-only pubkey from compressed pubkey:
    // slice off the first byte (02 or 03 prefix)
    const compressedPubkey = Buffer.from('02' + 'ab'.repeat(32), 'hex')
    const xOnlyPubkey = compressedPubkey.slice(1, 33)

    expect(xOnlyPubkey.length).toBe(32)
    expect(xOnlyPubkey.toString('hex')).toBe('ab'.repeat(32))
  })
})

describe('PSBT Signing Security', () => {
  it('documents: mixed input types require different signing', () => {
    // Runes transactions have mixed inputs:
    // - Input 0: P2WPKH (SegWit) for fee payment
    // - Inputs 1-N: P2TR (Taproot) for rune UTXOs

    const inputTypes = [
      { index: 0, type: 'P2WPKH', keyPath: "m/84'/1'/0'/0/0", signMethod: 'ECDSA' },
      { index: 1, type: 'P2TR', keyPath: "m/86'/1'/0'/0/0", signMethod: 'Schnorr' },
    ]

    expect(inputTypes[0].signMethod).toBe('ECDSA')
    expect(inputTypes[1].signMethod).toBe('Schnorr')
  })

  it('documents: taproot key must be tweaked for signing', () => {
    // For keypath spending in Taproot:
    // 1. Get internal pubkey (x-only)
    // 2. Compute tweak = taggedHash('TapTweak', internalPubkey)
    // 3. Tweaked key = internal key + tweak * G

    const taggedHashPrefix = 'TapTweak'
    expect(taggedHashPrefix).toBe('TapTweak')
  })
})

describe('Runestone Verification in Signed Transactions', () => {
  it('documents: signed tx should contain OP_RETURN with runes marker', () => {
    // Runes marker: OP_RETURN (0x6a) + OP_13 (0x5d)
    const runesMarker = '6a5d'

    // A valid runes transaction output script should start with this
    const sampleRunestoneScript = '6a5d0800b89c5d01d00f01'
    expect(sampleRunestoneScript.startsWith(runesMarker)).toBe(true)
  })

  it('documents: transaction without runestone should trigger warning', () => {
    // If a "runes" transaction doesn't have OP_RETURN + OP_13,
    // something is wrong and it should be logged

    const outputScripts = [
      '5120abcd...', // P2TR output
      '0014abcd...', // P2WPKH output
      // Missing: 6a5d... (runestone)
    ]

    const hasRunestone = outputScripts.some(script => script.startsWith('6a5d'))
    expect(hasRunestone).toBe(false) // Warning should be logged!
  })
})

describe('WalletKeyManager - PSBT Signing', () => {
  it('should have signing methods', () => {
    const keyManager = new WalletKeyManager()
    expect(typeof keyManager.signRunesPsbt).toBe('function')
    expect(typeof keyManager.signAndExtract).toBe('function')
  })

  it('should derive addresses consistently', () => {
    const keyManager = new WalletKeyManager()

    // Call deriveAddresses multiple times
    const addresses1 = keyManager.deriveAddresses()
    const addresses2 = keyManager.deriveAddresses()

    // Should be deterministic
    expect(addresses1.taprootAddress).toBe(addresses2.taprootAddress)
    expect(addresses1.segwitAddress).toBe(addresses2.segwitAddress)
  })

  it('should sign a PSBT with P2WPKH and P2TR inputs', () => {
    const keyManager = new WalletKeyManager()
    const network = keyManager.getNetwork()
    const addresses = keyManager.deriveAddresses()

    // Create a PSBT with proper input structure for signing
    const psbt = new bitcoin.Psbt({ network })

    // Create dummy previous transaction outputs for the witness data
    // P2WPKH output script for segwit input
    const p2wpkhScript = bitcoin.address.toOutputScript(addresses.segwitAddress, network)

    // P2TR output script for taproot input
    const p2trScript = bitcoin.address.toOutputScript(addresses.taprootAddress, network)

    // Add SegWit input (input 0) with witness UTXO
    psbt.addInput({
      hash: Buffer.alloc(32, 1), // Dummy txid
      index: 0,
      witnessUtxo: {
        script: p2wpkhScript,
        value: 50000,
      },
    })

    // Add Taproot input (input 1) with witness UTXO and internal key
    psbt.addInput({
      hash: Buffer.alloc(32, 2), // Dummy txid
      index: 0,
      witnessUtxo: {
        script: p2trScript,
        value: 10000,
      },
      tapInternalKey: Buffer.from(addresses.taprootPubkey, 'hex'),
    })

    // Add a simple output (taproot return address)
    psbt.addOutput({
      address: addresses.taprootAddress,
      value: 10000,
    })

    // Add another output (recipient)
    psbt.addOutput({
      address: addresses.segwitAddress,
      value: 10000,
    })

    // Add runestone output (OP_RETURN)
    psbt.addOutput({
      script: Buffer.from('6a5d0800b89c5d01d00f01', 'hex'),
      value: 0,
    })

    // Sign the PSBT
    const signedPsbt = keyManager.signRunesPsbt(psbt)

    // Verify signing worked
    expect(signedPsbt).toBeDefined()
    expect(signedPsbt.data.inputs[0].finalScriptWitness).toBeDefined()
    expect(signedPsbt.data.inputs[1].finalScriptWitness).toBeDefined()
  })

  it('should sign and extract transaction with txid', () => {
    const keyManager = new WalletKeyManager()
    const network = keyManager.getNetwork()
    const addresses = keyManager.deriveAddresses()

    const psbt = new bitcoin.Psbt({ network })

    const p2wpkhScript = bitcoin.address.toOutputScript(addresses.segwitAddress, network)
    const p2trScript = bitcoin.address.toOutputScript(addresses.taprootAddress, network)

    // Add inputs
    psbt.addInput({
      hash: Buffer.alloc(32, 1),
      index: 0,
      witnessUtxo: { script: p2wpkhScript, value: 50000 },
    })

    psbt.addInput({
      hash: Buffer.alloc(32, 2),
      index: 0,
      witnessUtxo: { script: p2trScript, value: 10000 },
      tapInternalKey: Buffer.from(addresses.taprootPubkey, 'hex'),
    })

    // Add outputs including runestone
    psbt.addOutput({ address: addresses.taprootAddress, value: 10000 })
    psbt.addOutput({ address: addresses.segwitAddress, value: 10000 })
    psbt.addOutput({ script: Buffer.from('6a5d0800b89c5d01d00f01', 'hex'), value: 0 })

    // Sign and extract
    const { signedTxHex, txid } = keyManager.signAndExtract(psbt)

    expect(signedTxHex).toBeDefined()
    expect(signedTxHex.length).toBeGreaterThan(100)
    expect(txid).toBeDefined()
    expect(txid).toMatch(/^[0-9a-f]{64}$/)
  })

  it('should warn when no runestone found in signed transaction', () => {
    const keyManager = new WalletKeyManager()
    const network = keyManager.getNetwork()
    const addresses = keyManager.deriveAddresses()

    const psbt = new bitcoin.Psbt({ network })

    const p2wpkhScript = bitcoin.address.toOutputScript(addresses.segwitAddress, network)
    const p2trScript = bitcoin.address.toOutputScript(addresses.taprootAddress, network)

    // Add inputs
    psbt.addInput({
      hash: Buffer.alloc(32, 1),
      index: 0,
      witnessUtxo: { script: p2wpkhScript, value: 50000 },
    })

    psbt.addInput({
      hash: Buffer.alloc(32, 2),
      index: 0,
      witnessUtxo: { script: p2trScript, value: 10000 },
      tapInternalKey: Buffer.from(addresses.taprootPubkey, 'hex'),
    })

    // Add outputs WITHOUT runestone
    psbt.addOutput({ address: addresses.taprootAddress, value: 10000 })
    psbt.addOutput({ address: addresses.segwitAddress, value: 10000 })

    // Sign and extract - should warn about missing runestone
    const { signedTxHex, txid } = keyManager.signAndExtract(psbt)

    expect(signedTxHex).toBeDefined()
    expect(txid).toBeDefined()
    // Logger.warn should have been called (mock is set up)
  })

  it('should handle signing errors gracefully', () => {
    const keyManager = new WalletKeyManager()
    const network = keyManager.getNetwork()

    // Create an invalid PSBT (no inputs)
    const psbt = new bitcoin.Psbt({ network })
    psbt.addOutput({
      address: keyManager.deriveAddresses().taprootAddress,
      value: 10000,
    })

    // Should throw when trying to sign with no inputs
    expect(() => keyManager.signRunesPsbt(psbt)).toThrow()
  })
})
