import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BTCTxBuilder } from '../../../src/btc/tx-builder.js'
import { BTCUtxo } from '../../../src/btc/types.js'

// Mock environment
vi.mock('../../../src/config/env.js', () => ({
  env: {
    NETWORK: 'testnet',
    MINT_SEED: '0'.repeat(64),
  },
}))

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('BTCTxBuilder', () => {
  let txBuilder: BTCTxBuilder

  beforeEach(() => {
    vi.clearAllMocks()
    txBuilder = new BTCTxBuilder()
  })

  describe('estimateTxSize', () => {
    it('should estimate size for 1 input, 1 output', () => {
      const size = txBuilder.estimateTxSize(1, 1)
      // 68 + 31 + 10 = 109
      expect(size).toBe(109)
    })

    it('should estimate size for 1 input, 2 outputs', () => {
      const size = txBuilder.estimateTxSize(1, 2)
      // 68 + 62 + 10 = 140
      expect(size).toBe(140)
    })

    it('should estimate size for 2 inputs, 2 outputs', () => {
      const size = txBuilder.estimateTxSize(2, 2)
      // 136 + 62 + 10 = 208
      expect(size).toBe(208)
    })

    it('should scale linearly with inputs', () => {
      const size1 = txBuilder.estimateTxSize(1, 2)
      const size2 = txBuilder.estimateTxSize(2, 2)
      expect(size2 - size1).toBe(68) // One input difference
    })
  })

  describe('buildTransaction', () => {
    // Valid testnet P2WPKH addresses for testing
    const testAddress = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' // Valid testnet P2WPKH
    const destAddress = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7' // Valid testnet P2WSH
    const changeAddress = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
    const txidHex = '0000000000000000000000000000000000000000000000000000000000000001'

    it('should throw when insufficient funds', () => {
      const utxos: BTCUtxo[] = [
        { txid: txidHex, vout: 0, value: 1000, address: testAddress },
      ]

      expect(() =>
        txBuilder.buildTransaction(utxos, destAddress, 10000n, changeAddress, 5)
      ).toThrow('Insufficient funds')
    })

    it('should select UTXOs to cover amount plus fee', () => {
      const utxos: BTCUtxo[] = [
        { txid: txidHex, vout: 0, value: 50000, address: testAddress },
        { txid: txidHex, vout: 1, value: 30000, address: testAddress },
      ]

      const result = txBuilder.buildTransaction(
        utxos,
        destAddress,
        10000n,
        changeAddress,
        5
      )

      expect(result.psbt).toBeDefined()
      expect(result.fee).toBeGreaterThan(0)
      expect(result.txSize).toBeGreaterThan(0)
    })

    it('should prefer larger UTXOs first', () => {
      const txid2 = '0000000000000000000000000000000000000000000000000000000000000002'
      const txid3 = '0000000000000000000000000000000000000000000000000000000000000003'
      const utxos: BTCUtxo[] = [
        { txid: txidHex, vout: 0, value: 1000, address: testAddress },
        { txid: txid2, vout: 0, value: 100000, address: testAddress },
        { txid: txid3, vout: 0, value: 5000, address: testAddress },
      ]

      const result = txBuilder.buildTransaction(
        utxos,
        destAddress,
        10000n,
        changeAddress,
        5
      )

      // Should only need the large UTXO
      expect(result.psbt.data.inputs.length).toBe(1)
    })

    it('should calculate correct fee', () => {
      const utxos: BTCUtxo[] = [
        { txid: txidHex, vout: 0, value: 100000, address: testAddress },
      ]

      const feeRate = 10 // sats/vbyte
      const result = txBuilder.buildTransaction(
        utxos,
        destAddress,
        10000n,
        changeAddress,
        feeRate
      )

      // Fee should be txSize * feeRate
      expect(result.fee).toBe(result.txSize * feeRate)
    })
  })

  describe('getNetwork', () => {
    it('should return testnet network', () => {
      const network = txBuilder.getNetwork()
      expect(network.bech32).toBe('tb')
    })
  })
})
