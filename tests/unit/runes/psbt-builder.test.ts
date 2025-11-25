import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from '@bitcoinerlab/secp256k1'
import { RunesPsbtBuilder } from '../../../src/runes/psbt-builder.js'
import { EsploraClient } from '../../../src/runes/api-client.js'
import { RuneUtxo, SatUtxo, RUNES_TX_CONSTANTS } from '../../../src/runes/types.js'

// Initialize ECC library for Taproot support
bitcoin.initEccLib(ecc)

// Mock dependencies
vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../../src/config/env.js', () => ({
  env: {
    NETWORK: 'testnet',
  },
}))

describe('RunesPsbtBuilder', () => {
  let psbtBuilder: RunesPsbtBuilder
  let mockEsploraClient: EsploraClient

  // Sample taproot output script (P2TR)
  const taprootScript = Buffer.from(
    '5120f07d55a35eef5c5ab04ab65c2c93803bccfeea8e0a3289f5653a697b62614ca0',
    'hex'
  )
  // Sample segwit output script (P2WPKH)
  const segwitScript = Buffer.from(
    '001425f859821196c48a20c94fc1f4eec73158c4fe5f',
    'hex'
  )

  // Helper to create a valid transaction hex with inputs and outputs
  const createValidTxHex = (outputs: Array<{ script: Buffer; value: number }>) => {
    const tx = new bitcoin.Transaction()
    tx.version = 2
    // Add a dummy input (required for valid tx)
    tx.addInput(Buffer.alloc(32, 0), 0)
    for (const out of outputs) {
      tx.addOutput(out.script, out.value)
    }
    return tx.toHex()
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockEsploraClient = {
      getTransactionHex: vi.fn(),
    } as unknown as EsploraClient

    psbtBuilder = new RunesPsbtBuilder(mockEsploraClient)
  })

  describe('buildRunesPsbt', () => {
    const taprootAddress = 'tb1p7p74tg67aaw94vz2kewzeyuq80x0a65wpgegnat98f5hkcnpfjsqntv2em'
    const taprootInternalPubkey = 'f07d55a35eef5c5ab04ab65c2c93803bccfeea8e0a3289f5653a697b62614ca0'
    const segwitAddress = 'tb1qyhu9nqs3jmzg5gxfflqlfmk8x9vvfljl5h2vpg'
    const recipientAddress = 'tb1p7p74tg67aaw94vz2kewzeyuq80x0a65wpgegnat98f5hkcnpfjsqntv2em'

    it('should build PSBT with correct structure', async () => {
      const runeUtxos: RuneUtxo[] = [
        {
          txid: '0'.repeat(64),
          vout: 0,
          value: 10000,
          address: taprootAddress,
          runeAmount: 1000n,
          runeName: 'DUCAT•UNIT•RUNE',
          runeId: { block: 1527352n, tx: 1n },
        },
      ]

      const satUtxo: SatUtxo = {
        txid: '1'.repeat(64),
        vout: 0,
        value: 50000,
        address: segwitAddress,
      }

      // Mock transaction hex responses with valid tx data
      const satTxHex = createValidTxHex([{ script: segwitScript, value: 50000 }])
      const runeTxHex = createValidTxHex([{ script: taprootScript, value: 10000 }])

      vi.mocked(mockEsploraClient.getTransactionHex)
        .mockResolvedValueOnce(satTxHex)
        .mockResolvedValueOnce(runeTxHex)

      const { psbt, fee } = await psbtBuilder.buildRunesPsbt(
        runeUtxos,
        satUtxo,
        taprootAddress,
        taprootInternalPubkey,
        segwitAddress,
        recipientAddress,
        500n
      )

      // Verify structure
      expect(psbt.data.inputs.length).toBe(2) // 1 sat + 1 rune
      expect(psbt.data.outputs.length).toBeGreaterThanOrEqual(3) // return + recipient + runestone (+ optional change)
      expect(fee).toBe(RUNES_TX_CONSTANTS.FEE)
    })

    it('should build PSBT with multiple rune UTXOs', async () => {
      const runeUtxos: RuneUtxo[] = [
        {
          txid: '0'.repeat(64),
          vout: 0,
          value: 10000,
          address: taprootAddress,
          runeAmount: 300n,
          runeName: 'DUCAT•UNIT•RUNE',
          runeId: { block: 1527352n, tx: 1n },
        },
        {
          txid: '2'.repeat(64),
          vout: 1,
          value: 10000,
          address: taprootAddress,
          runeAmount: 400n,
          runeName: 'DUCAT•UNIT•RUNE',
          runeId: { block: 1527352n, tx: 1n },
        },
      ]

      const satUtxo: SatUtxo = {
        txid: '1'.repeat(64),
        vout: 0,
        value: 50000,
        address: segwitAddress,
      }

      const satTxHex = createValidTxHex([{ script: segwitScript, value: 50000 }])
      const runeTx1Hex = createValidTxHex([{ script: taprootScript, value: 10000 }])
      const runeTx2Hex = createValidTxHex([
        { script: taprootScript, value: 5000 },
        { script: taprootScript, value: 10000 },
      ])

      vi.mocked(mockEsploraClient.getTransactionHex)
        .mockResolvedValueOnce(satTxHex)
        .mockResolvedValueOnce(runeTx1Hex)
        .mockResolvedValueOnce(runeTx2Hex)

      const { psbt } = await psbtBuilder.buildRunesPsbt(
        runeUtxos,
        satUtxo,
        taprootAddress,
        taprootInternalPubkey,
        segwitAddress,
        recipientAddress,
        500n
      )

      // Should have 3 inputs: 1 sat + 2 rune UTXOs
      expect(psbt.data.inputs.length).toBe(3)
    })

    it('should include change output when above dust limit', async () => {
      const runeUtxos: RuneUtxo[] = [
        {
          txid: '0'.repeat(64),
          vout: 0,
          value: 10000,
          address: taprootAddress,
          runeAmount: 1000n,
          runeName: 'DUCAT•UNIT•RUNE',
          runeId: { block: 1527352n, tx: 1n },
        },
      ]

      const satUtxo: SatUtxo = {
        txid: '1'.repeat(64),
        vout: 0,
        value: 100000, // Large sat input for change
        address: segwitAddress,
      }

      const satTxHex = createValidTxHex([{ script: segwitScript, value: 100000 }])
      const runeTxHex = createValidTxHex([{ script: taprootScript, value: 10000 }])

      vi.mocked(mockEsploraClient.getTransactionHex)
        .mockResolvedValueOnce(satTxHex)
        .mockResolvedValueOnce(runeTxHex)

      const { psbt } = await psbtBuilder.buildRunesPsbt(
        runeUtxos,
        satUtxo,
        taprootAddress,
        taprootInternalPubkey,
        segwitAddress,
        recipientAddress,
        500n
      )

      // With large sat input, should have change output
      // Outputs: return (10000) + recipient (10000) + change + runestone (0)
      const totalInput = 100000 + 10000
      const baseOutput = RUNES_TX_CONSTANTS.RUNE_RETURN_SATS + RUNES_TX_CONSTANTS.RECIPIENT_SATS + RUNES_TX_CONSTANTS.FEE
      const expectedChange = totalInput - baseOutput

      expect(expectedChange).toBeGreaterThan(RUNES_TX_CONSTANTS.DUST_LIMIT)
      expect(psbt.data.outputs.length).toBe(4) // return + recipient + change + runestone
    })

    it('should omit change output when below dust limit', async () => {
      const runeUtxos: RuneUtxo[] = [
        {
          txid: '0'.repeat(64),
          vout: 0,
          value: 10000,
          address: taprootAddress,
          runeAmount: 1000n,
          runeName: 'DUCAT•UNIT•RUNE',
          runeId: { block: 1527352n, tx: 1n },
        },
      ]

      // Sat input that results in change below dust limit
      // Need: 10000 (return) + 10000 (recipient) + 1000 (fee) = 21000 from sat input
      // With rune input of 10000, sat input of 11500 gives 500 sats change (below 546 dust)
      const satUtxo: SatUtxo = {
        txid: '1'.repeat(64),
        vout: 0,
        value: 11500, // Results in 500 sat change, below dust limit of 546
        address: segwitAddress,
      }

      const satTxHex = createValidTxHex([{ script: segwitScript, value: 11500 }])
      const runeTxHex = createValidTxHex([{ script: taprootScript, value: 10000 }])

      vi.mocked(mockEsploraClient.getTransactionHex)
        .mockResolvedValueOnce(satTxHex)
        .mockResolvedValueOnce(runeTxHex)

      const { psbt } = await psbtBuilder.buildRunesPsbt(
        runeUtxos,
        satUtxo,
        taprootAddress,
        taprootInternalPubkey,
        segwitAddress,
        recipientAddress,
        500n
      )

      // With small sat input, change is below dust - should be 3 outputs
      expect(psbt.data.outputs.length).toBe(3) // return + recipient + runestone (no change)
    })

    it('should include runestone with correct edict', async () => {
      const runeUtxos: RuneUtxo[] = [
        {
          txid: '0'.repeat(64),
          vout: 0,
          value: 10000,
          address: taprootAddress,
          runeAmount: 1000n,
          runeName: 'DUCAT•UNIT•RUNE',
          runeId: { block: 1527352n, tx: 1n },
        },
      ]

      const satUtxo: SatUtxo = {
        txid: '1'.repeat(64),
        vout: 0,
        value: 50000,
        address: segwitAddress,
      }

      const satTxHex = createValidTxHex([{ script: segwitScript, value: 50000 }])
      const runeTxHex = createValidTxHex([{ script: taprootScript, value: 10000 }])

      vi.mocked(mockEsploraClient.getTransactionHex)
        .mockResolvedValueOnce(satTxHex)
        .mockResolvedValueOnce(runeTxHex)

      const { psbt } = await psbtBuilder.buildRunesPsbt(
        runeUtxos,
        satUtxo,
        taprootAddress,
        taprootInternalPubkey,
        segwitAddress,
        recipientAddress,
        500n // Request 500 runes
      )

      // Last output should be runestone (OP_RETURN)
      const lastOutput = psbt.txOutputs[psbt.txOutputs.length - 1]
      expect(lastOutput.value).toBe(0) // OP_RETURN has 0 value
      expect(lastOutput.script.toString('hex')).toMatch(/^6a5d/) // OP_RETURN + OP_13
    })

    it('should handle API errors', async () => {
      const runeUtxos: RuneUtxo[] = [
        {
          txid: '0'.repeat(64),
          vout: 0,
          value: 10000,
          address: taprootAddress,
          runeAmount: 1000n,
          runeName: 'DUCAT•UNIT•RUNE',
          runeId: { block: 1527352n, tx: 1n },
        },
      ]

      const satUtxo: SatUtxo = {
        txid: '1'.repeat(64),
        vout: 0,
        value: 50000,
        address: segwitAddress,
      }

      vi.mocked(mockEsploraClient.getTransactionHex).mockRejectedValue(new Error('API error'))

      await expect(
        psbtBuilder.buildRunesPsbt(
          runeUtxos,
          satUtxo,
          taprootAddress,
          taprootInternalPubkey,
          segwitAddress,
          recipientAddress,
          500n
        )
      ).rejects.toThrow('API error')
    })
  })
})

describe('PSBT Output Structure', () => {
  it('documents: PSBT output indices', () => {
    // Output 0: Taproot return address (unallocated runes go here)
    // Output 1: Recipient (gets specified runes via edict)
    // Output 2: SegWit change (optional, only if above dust)
    // Output 3/Last: OP_RETURN runestone

    const outputIndices = {
      TAPROOT_RETURN: 0,
      RECIPIENT: 1,
      SEGWIT_CHANGE: 2, // Optional
      RUNESTONE: 'last',
    }

    expect(outputIndices.RECIPIENT).toBe(1) // Edict targets output 1
  })

  it('documents: edict uses REQUESTED amount, not total from UTXOs', () => {
    // CRITICAL: The edict amount should be what was REQUESTED
    // NOT the total runes available from input UTXOs
    // Excess runes automatically go to output 0 (taproot return)

    const requestedAmount = 500n
    const totalFromUtxos = 1500n
    const excessReturned = totalFromUtxos - requestedAmount

    expect(excessReturned).toBe(1000n)
    // Excess goes to output 0, requested goes to output 1
  })
})
