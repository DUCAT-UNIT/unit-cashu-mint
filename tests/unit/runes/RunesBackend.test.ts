import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RunesBackend } from '../../../src/runes/RunesBackend.js'
import { Pool } from 'pg'

// Mock dependencies
vi.mock('../../../src/runes/api-client.js', () => ({
  OrdClient: vi.fn(),
  EsploraClient: vi.fn(),
}))

vi.mock('../../../src/runes/utxo-selection.js', () => ({
  UtxoSelector: vi.fn(),
}))

vi.mock('../../../src/runes/psbt-builder.js', () => ({
  RunesPsbtBuilder: vi.fn(),
}))

vi.mock('../../../src/runes/UtxoManager.js', () => ({
  UtxoManager: vi.fn().mockImplementation(() => ({
    getUnspentUtxos: vi.fn().mockResolvedValue([]),
    getSpentUtxoKeys: vi.fn().mockResolvedValue(new Set()),
    markSpent: vi.fn().mockResolvedValue(undefined),
    addUtxo: vi.fn().mockResolvedValue(undefined),
    getBalance: vi.fn().mockResolvedValue(0n),
    syncFromBlockchain: vi.fn().mockResolvedValue({ added: 0, updated: 0 }),
  })),
}))

vi.mock('../../../src/runes/WalletKeyManager.js', () => ({
  WalletKeyManager: vi.fn().mockImplementation(() => ({
    deriveAddresses: vi.fn().mockReturnValue({
      taprootAddress: 'tb1p7p74tg67aaw94vz2kewzeyuq80x0a65wpgegnat98f5hkcnpfjsqntv2em',
      segwitAddress: 'tb1qtest123',
      taprootPubkey: '02' + '0'.repeat(62),
    }),
    signAndExtract: vi.fn(),
  })),
}))

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
    MINT_SEED: '0'.repeat(64),
    MINT_CONFIRMATIONS: 1,
    ORD_URL: 'https://ord-test.example.com',
    ESPLORA_URL: 'https://esplora-test.example.com',
  },
}))

import { OrdClient, EsploraClient } from '../../../src/runes/api-client.js'
import { UtxoManager } from '../../../src/runes/UtxoManager.js'
import { DUCAT_UNIT_RUNE_NAME } from '../../../src/runes/types.js'

describe('RunesBackend', () => {
  let runesBackend: RunesBackend
  let mockOrdClient: any
  let mockEsploraClient: any
  let mockUtxoManager: any
  let mockDb: Pool

  beforeEach(() => {
    vi.clearAllMocks()

    mockOrdClient = {
      getAddressOutputs: vi.fn(),
      getOutput: vi.fn(),
    }

    mockEsploraClient = {
      getTransaction: vi.fn(),
      getBlockHeight: vi.fn(),
      getAddressUtxos: vi.fn(),
      getOutspend: vi.fn(),
      broadcastTransaction: vi.fn(),
      getTransactionHex: vi.fn(),
    }

    mockUtxoManager = {
      getUnspentUtxos: vi.fn().mockResolvedValue([]),
      getSpentUtxoKeys: vi.fn().mockResolvedValue(new Set()),
      markSpent: vi.fn().mockResolvedValue(undefined),
      addUtxo: vi.fn().mockResolvedValue(undefined),
      getBalance: vi.fn().mockResolvedValue(0n),
      syncFromBlockchain: vi.fn().mockResolvedValue({ added: 0, updated: 0 }),
    }

    // Mock the constructors
    vi.mocked(OrdClient).mockImplementation(() => mockOrdClient)
    vi.mocked(EsploraClient).mockImplementation(() => mockEsploraClient)
    vi.mocked(UtxoManager).mockImplementation(() => mockUtxoManager)

    mockDb = {} as Pool
    runesBackend = new RunesBackend(mockDb)
  })

  describe('checkDeposit', () => {
    const quoteId = 'test-quote-123'
    const depositAddress = 'tb1p7p74tg67aaw94vz2kewzeyuq80x0a65wpgegnat98f5hkcnpfjsqntv2em'

    it('should detect a new deposit with correct amount', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['abc123:0'],
        runes_balances: [[DUCAT_UNIT_RUNE_NAME, '500', '$']],
      })

      mockOrdClient.getOutput.mockResolvedValue({
        transaction: 'abc123',
        value: 10000,
        runes: {
          [DUCAT_UNIT_RUNE_NAME]: {
            amount: '500',
            id: '1527352:1',
          },
        },
      })

      mockEsploraClient.getTransaction.mockResolvedValue({
        txid: 'abc123',
        status: {
          confirmed: true,
          block_height: 100,
        },
      })

      mockEsploraClient.getBlockHeight.mockResolvedValue(105)

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      expect(result.confirmed).toBe(true)
      expect(result.amount).toBe(500n)
      expect(result.txid).toBe('abc123')
      expect(result.vout).toBe(0)
      expect(result.confirmations).toBe(6) // 105 - 100 + 1
    })

    it('should return unconfirmed when no deposits found', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: [],
        runes_balances: [],
      })

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      expect(result.confirmed).toBe(false)
      expect(result.amount).toBeUndefined()
      expect(result.confirmations).toBe(0)
    })

    it('should return unconfirmed when no runes balances', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['abc123:0'],
        runes_balances: [],
      })

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      expect(result.confirmed).toBe(false)
    })

    it('should skip already-tracked UTXOs', async () => {
      // Simulate existing UTXO in database
      mockUtxoManager.getUnspentUtxos.mockResolvedValue([
        { txid: 'old_txid', vout: 0, runeAmount: 1000n },
      ])

      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['old_txid:0', 'new_txid:1'],
        runes_balances: [[DUCAT_UNIT_RUNE_NAME, '1500', '$']],
      })

      // Only new_txid should be returned
      mockOrdClient.getOutput.mockResolvedValue({
        transaction: 'new_txid',
        value: 10000,
        runes: {
          [DUCAT_UNIT_RUNE_NAME]: {
            amount: '500',
            id: '1527352:1',
          },
        },
      })

      mockEsploraClient.getTransaction.mockResolvedValue({
        txid: 'new_txid',
        status: { confirmed: true, block_height: 100 },
      })

      mockEsploraClient.getBlockHeight.mockResolvedValue(101)

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      expect(result.txid).toBe('new_txid')
      expect(result.amount).toBe(500n)
    })

    it('should return correct amount from Ord API - THE ACTUAL BUG SCENARIO', async () => {
      // This tests the exact scenario that caused the 500 error:
      // Quote was for 500 UNIT, but client sent 2000 UNIT

      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df:1'],
        runes_balances: [[DUCAT_UNIT_RUNE_NAME, '2000', '$']],
      })

      // Ord API returns the ACTUAL amount on the UTXO: 2000
      mockOrdClient.getOutput.mockResolvedValue({
        transaction: '8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df',
        value: 10000,
        runes: {
          [DUCAT_UNIT_RUNE_NAME]: {
            amount: '2000', // The ACTUAL amount, not 500!
            id: '1527352:1',
          },
        },
      })

      mockEsploraClient.getTransaction.mockResolvedValue({
        txid: '8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df',
        status: { confirmed: true, block_height: 2647704 },
      })

      mockEsploraClient.getBlockHeight.mockResolvedValue(2647710)

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      // The backend correctly reports 2000, not 500
      expect(result.confirmed).toBe(true)
      expect(result.amount).toBe(2000n)

      // This is what MintService should check:
      const quoteAmount = 500n
      const receivedAmount = result.amount!

      // Amount mismatch detected!
      expect(receivedAmount).not.toBe(quoteAmount)
      expect(receivedAmount - quoteAmount).toBe(1500n)
    })

    it('should handle unconfirmed transaction', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['unconfirmed_tx:0'],
        runes_balances: [[DUCAT_UNIT_RUNE_NAME, '500', '$']],
      })

      mockOrdClient.getOutput.mockResolvedValue({
        transaction: 'unconfirmed_tx',
        value: 10000,
        runes: {
          [DUCAT_UNIT_RUNE_NAME]: {
            amount: '500',
            id: '1527352:1',
          },
        },
      })

      mockEsploraClient.getTransaction.mockResolvedValue({
        txid: 'unconfirmed_tx',
        status: { confirmed: false },
      })

      mockEsploraClient.getBlockHeight.mockResolvedValue(100)

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      expect(result.confirmed).toBe(false)
      expect(result.confirmations).toBe(0)
    })

    it('should skip UTXOs without DUCAT•UNIT•RUNE', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['other_rune:0', 'ducat_rune:1'],
        runes_balances: [
          ['OTHER•RUNE', '1000', '¤'],
          [DUCAT_UNIT_RUNE_NAME, '500', '$'],
        ],
      })

      // First UTXO has different rune
      mockOrdClient.getOutput
        .mockResolvedValueOnce({
          transaction: 'other_rune',
          value: 10000,
          runes: {
            'OTHER•RUNE': { amount: '1000', id: '123:1' },
          },
        })
        .mockResolvedValueOnce({
          transaction: 'ducat_rune',
          value: 10000,
          runes: {
            [DUCAT_UNIT_RUNE_NAME]: { amount: '500', id: '1527352:1' },
          },
        })

      mockEsploraClient.getTransaction.mockResolvedValue({
        txid: 'ducat_rune',
        status: { confirmed: true, block_height: 100 },
      })

      mockEsploraClient.getBlockHeight.mockResolvedValue(101)

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      expect(result.txid).toBe('ducat_rune')
      expect(result.amount).toBe(500n)
    })

    it('should handle API errors gracefully', async () => {
      mockOrdClient.getAddressOutputs.mockRejectedValue(new Error('API timeout'))

      await expect(runesBackend.checkDeposit(quoteId, depositAddress))
        .rejects.toThrow('API timeout')
    })

    it('should skip UTXO when getOutput returns no runes field', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['txid_no_runes:0', 'txid_with_runes:1'],
        runes_balances: [[DUCAT_UNIT_RUNE_NAME, '500', '$']],
      })

      // First UTXO has no runes field at all
      mockOrdClient.getOutput
        .mockResolvedValueOnce({
          transaction: 'txid_no_runes',
          value: 10000,
          // No runes field at all!
        })
        .mockResolvedValueOnce({
          transaction: 'txid_with_runes',
          value: 10000,
          runes: {
            [DUCAT_UNIT_RUNE_NAME]: { amount: '500', id: '1527352:1' },
          },
        })

      mockEsploraClient.getTransaction.mockResolvedValue({
        txid: 'txid_with_runes',
        status: { confirmed: true, block_height: 100 },
      })

      mockEsploraClient.getBlockHeight.mockResolvedValue(101)

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      // Should skip the UTXO without runes and return the one with runes
      expect(result.txid).toBe('txid_with_runes')
      expect(result.amount).toBe(500n)
    })

    it('should skip UTXO when getOutput returns null/undefined', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['txid_null:0', 'txid_valid:1'],
        runes_balances: [[DUCAT_UNIT_RUNE_NAME, '500', '$']],
      })

      // First UTXO returns null-ish response
      mockOrdClient.getOutput
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          transaction: 'txid_valid',
          value: 10000,
          runes: {
            [DUCAT_UNIT_RUNE_NAME]: { amount: '500', id: '1527352:1' },
          },
        })

      mockEsploraClient.getTransaction.mockResolvedValue({
        txid: 'txid_valid',
        status: { confirmed: true, block_height: 100 },
      })

      mockEsploraClient.getBlockHeight.mockResolvedValue(101)

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      // Should skip the null UTXO and return the valid one
      expect(result.txid).toBe('txid_valid')
      expect(result.amount).toBe(500n)
    })

    it('should return unconfirmed when all UTXOs are already tracked', async () => {
      // All outputs are already in our database
      mockUtxoManager.getUnspentUtxos.mockResolvedValue([
        { txid: 'tracked_txid1', vout: 0, runeAmount: 500n },
        { txid: 'tracked_txid2', vout: 1, runeAmount: 500n },
      ])

      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['tracked_txid1:0', 'tracked_txid2:1'],
        runes_balances: [[DUCAT_UNIT_RUNE_NAME, '1000', '$']],
      })

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      // All UTXOs are already tracked, so no NEW deposit found
      expect(result.confirmed).toBe(false)
      expect(result.amount).toBeUndefined()
      expect(result.confirmations).toBe(0)
    })

    it('should return unconfirmed when DUCAT balance not found', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['some_txid:0'],
        runes_balances: [['OTHER•RUNE', '1000', '¤']], // No DUCAT rune balance
      })

      const result = await runesBackend.checkDeposit(quoteId, depositAddress)

      expect(result.confirmed).toBe(false)
      expect(result.confirmations).toBe(0)
    })
  })

  describe('createDepositAddress', () => {
    it('should return the mint taproot address', async () => {
      const address = await runesBackend.createDepositAddress(
        'quote123',
        1000n,
        '1527352:1'
      )

      // Should return the mint's taproot address
      expect(address).toBe('tb1p7p74tg67aaw94vz2kewzeyuq80x0a65wpgegnat98f5hkcnpfjsqntv2em')
    })
  })

  describe('getBalance', () => {
    it('should return balance from UtxoManager', async () => {
      mockUtxoManager.getBalance.mockResolvedValue(50000n)

      const balance = await runesBackend.getBalance('1527352:1')

      expect(balance).toBe(50000n)
    })
  })

  describe('sendRunes', () => {
    const destination = 'tb1qrecipient123'
    const amount = 1000n
    const runeId = '1527352:1'

    let mockUtxoSelector: any
    let mockPsbtBuilder: any
    let mockWalletKeyManager: any

    beforeEach(() => {
      // We need to access the private members through the instance
      // Create fresh mocks for sendRunes tests
      mockUtxoSelector = {
        findUtxosForRunesTransfer: vi.fn(),
      }
      mockPsbtBuilder = {
        buildRunesPsbt: vi.fn(),
      }
      mockWalletKeyManager = {
        signAndExtract: vi.fn(),
        deriveAddresses: vi.fn().mockReturnValue({
          taprootAddress: 'tb1p7p74tg67aaw94vz2kewzeyuq80x0a65wpgegnat98f5hkcnpfjsqntv2em',
          segwitAddress: 'tb1qtest123',
          taprootPubkey: '02' + '0'.repeat(62),
        }),
      }

      // Recreate backend with fresh mocks
      ;(runesBackend as any).utxoSelector = mockUtxoSelector
      ;(runesBackend as any).psbtBuilder = mockPsbtBuilder
      ;(runesBackend as any).walletKeyManager = mockWalletKeyManager
    })

    it('should successfully send runes', async () => {
      const mockRumeUtxos = [
        { txid: 'rune_txid', vout: 0, value: 10000, runeAmount: 1500n, runeId: { block: 1527352n, tx: 1n } },
      ]
      const mockSatUtxo = { txid: 'sat_txid', vout: 0, value: 50000 }

      mockUtxoSelector.findUtxosForRunesTransfer.mockResolvedValue({
        runeUtxos: mockRumeUtxos,
        satUtxo: mockSatUtxo,
      })

      mockPsbtBuilder.buildRunesPsbt.mockResolvedValue({
        psbt: {},
        fee: 1000,
      })

      mockWalletKeyManager.signAndExtract.mockReturnValue({
        signedTxHex: 'signed_tx_hex',
        txid: 'broadcast_txid',
      })

      mockEsploraClient.broadcastTransaction.mockResolvedValue('broadcast_txid')

      const result = await runesBackend.sendRunes(destination, amount, runeId)

      expect(result.txid).toBe('broadcast_txid')
      expect(result.fee_paid).toBe(1000)
      expect(mockUtxoManager.markSpent).toHaveBeenCalledTimes(2) // rune + sat UTXO
      expect(mockUtxoManager.addUtxo).toHaveBeenCalled() // excess runes returned
    })

    it('should throw when no UTXOs found', async () => {
      mockUtxoSelector.findUtxosForRunesTransfer.mockResolvedValue(null)

      await expect(runesBackend.sendRunes(destination, amount, runeId))
        .rejects.toThrow('Insufficient funds')
    })

    it('should throw on TXID mismatch (MITM protection)', async () => {
      mockUtxoSelector.findUtxosForRunesTransfer.mockResolvedValue({
        runeUtxos: [{ txid: 'rune_txid', vout: 0, value: 10000, runeAmount: 1500n }],
        satUtxo: { txid: 'sat_txid', vout: 0, value: 50000 },
      })

      mockPsbtBuilder.buildRunesPsbt.mockResolvedValue({ psbt: {}, fee: 1000 })
      mockWalletKeyManager.signAndExtract.mockReturnValue({
        signedTxHex: 'signed_tx_hex',
        txid: 'expected_txid',
      })

      // Broadcast returns different txid!
      mockEsploraClient.broadcastTransaction.mockResolvedValue('different_txid')

      await expect(runesBackend.sendRunes(destination, amount, runeId))
        .rejects.toThrow('txid mismatch')
    })

    it('should not add return UTXO when no excess runes', async () => {
      const mockRumeUtxos = [
        { txid: 'rune_txid', vout: 0, value: 10000, runeAmount: 1000n, runeId: { block: 1527352n, tx: 1n } },
      ]

      mockUtxoSelector.findUtxosForRunesTransfer.mockResolvedValue({
        runeUtxos: mockRumeUtxos,
        satUtxo: { txid: 'sat_txid', vout: 0, value: 50000 },
      })

      mockPsbtBuilder.buildRunesPsbt.mockResolvedValue({ psbt: {}, fee: 1000 })
      mockWalletKeyManager.signAndExtract.mockReturnValue({
        signedTxHex: 'signed_tx_hex',
        txid: 'broadcast_txid',
      })
      mockEsploraClient.broadcastTransaction.mockResolvedValue('broadcast_txid')

      await runesBackend.sendRunes(destination, 1000n, runeId) // exact amount

      // Should NOT call addUtxo since no excess
      expect(mockUtxoManager.addUtxo).not.toHaveBeenCalled()
    })

    it('should handle errors and rethrow', async () => {
      mockUtxoSelector.findUtxosForRunesTransfer.mockRejectedValue(new Error('Network error'))

      await expect(runesBackend.sendRunes(destination, amount, runeId))
        .rejects.toThrow('Network error')
    })
  })

  describe('syncUtxos', () => {
    it('should sync UTXOs from blockchain', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['txid1:0', 'txid2:1'],
        runes_balances: [[DUCAT_UNIT_RUNE_NAME, '2000', '$']],
      })

      mockOrdClient.getOutput
        .mockResolvedValueOnce({
          transaction: 'txid1',
          value: 10000,
          runes: {
            [DUCAT_UNIT_RUNE_NAME]: { amount: '1000', id: '1527352:1' },
          },
        })
        .mockResolvedValueOnce({
          transaction: 'txid2',
          value: 10000,
          runes: {
            [DUCAT_UNIT_RUNE_NAME]: { amount: '1000', id: '1527352:1' },
          },
        })

      await runesBackend.syncUtxos()

      expect(mockUtxoManager.syncFromBlockchain).toHaveBeenCalled()
      const syncCall = mockUtxoManager.syncFromBlockchain.mock.calls[0]
      expect(syncCall[1]).toHaveLength(2) // 2 UTXOs synced
    })

    it('should use default rune ID when not provided in output', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['txid1:0'],
        runes_balances: [[DUCAT_UNIT_RUNE_NAME, '1000', '$']],
      })

      // Output without id field
      mockOrdClient.getOutput.mockResolvedValue({
        transaction: 'txid1',
        value: 10000,
        runes: {
          [DUCAT_UNIT_RUNE_NAME]: { amount: '1000' }, // No id!
        },
      })

      await runesBackend.syncUtxos()

      expect(mockUtxoManager.syncFromBlockchain).toHaveBeenCalled()
      const syncCall = mockUtxoManager.syncFromBlockchain.mock.calls[0]
      expect(syncCall[1][0].runeId.block).toBe(1527352n) // Default ID used
    })

    it('should skip outputs without DUCAT runes', async () => {
      mockOrdClient.getAddressOutputs.mockResolvedValue({
        outputs: ['txid1:0', 'txid2:0'],
        runes_balances: [],
      })

      mockOrdClient.getOutput
        .mockResolvedValueOnce({
          transaction: 'txid1',
          value: 10000,
          runes: { 'OTHER•RUNE': { amount: '1000', id: '123:1' } },
        })
        .mockResolvedValueOnce({
          transaction: 'txid2',
          value: 10000,
          // No runes at all
        })

      await runesBackend.syncUtxos()

      const syncCall = mockUtxoManager.syncFromBlockchain.mock.calls[0]
      expect(syncCall[1]).toHaveLength(0) // No DUCAT runes found
    })

    it('should handle errors and rethrow', async () => {
      mockOrdClient.getAddressOutputs.mockRejectedValue(new Error('API error'))

      await expect(runesBackend.syncUtxos()).rejects.toThrow('API error')
    })
  })

  describe('estimateFee', () => {
    it('should return fixed fee estimate', async () => {
      const fee = await runesBackend.estimateFee('tb1qtest', 1000n, '1527352:1')
      expect(fee).toBe(1000)
    })
  })
})

describe('RunesBackend Constructor - Environment Configuration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('should use addresses from environment when all three are provided', async () => {
    // Mock env with all address vars set
    vi.doMock('../../../src/config/env.js', () => ({
      env: {
        MINT_TAPROOT_ADDRESS: 'tb1p_from_env',
        MINT_SEGWIT_ADDRESS: 'tb1q_from_env',
        MINT_TAPROOT_PUBKEY: '03' + '1'.repeat(62),
        MINT_CONFIRMATIONS: 1,
        ORD_URL: 'https://ord-test.example.com',
        ESPLORA_URL: 'https://esplora-test.example.com',
      },
    }))

    vi.doMock('../../../src/runes/api-client.js', () => ({
      OrdClient: vi.fn().mockImplementation(() => ({})),
      EsploraClient: vi.fn().mockImplementation(() => ({})),
    }))

    vi.doMock('../../../src/runes/utxo-selection.js', () => ({
      UtxoSelector: vi.fn().mockImplementation(() => ({})),
    }))

    vi.doMock('../../../src/runes/psbt-builder.js', () => ({
      RunesPsbtBuilder: vi.fn().mockImplementation(() => ({})),
    }))

    vi.doMock('../../../src/runes/UtxoManager.js', () => ({
      UtxoManager: vi.fn().mockImplementation(() => ({})),
    }))

    vi.doMock('../../../src/runes/WalletKeyManager.js', () => ({
      WalletKeyManager: vi.fn().mockImplementation(() => ({
        deriveAddresses: vi.fn(),
      })),
    }))

    vi.doMock('../../../src/utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }))

    const { RunesBackend: RB } = await import('../../../src/runes/RunesBackend.js')
    const mockDb = {} as Pool

    const backend = new RB(mockDb)

    // Access private members to verify
    expect((backend as any).taprootAddress).toBe('tb1p_from_env')
    expect((backend as any).segwitAddress).toBe('tb1q_from_env')
    expect((backend as any).taprootPubkey).toBe('03' + '1'.repeat(62))
  })

  it('should throw when no configuration is provided', async () => {
    vi.doMock('../../../src/config/env.js', () => ({
      env: {
        // No MINT_SEED, no address vars
        MINT_CONFIRMATIONS: 1,
        ORD_URL: 'https://ord-test.example.com',
        ESPLORA_URL: 'https://esplora-test.example.com',
      },
    }))

    vi.doMock('../../../src/runes/api-client.js', () => ({
      OrdClient: vi.fn().mockImplementation(() => ({})),
      EsploraClient: vi.fn().mockImplementation(() => ({})),
    }))

    vi.doMock('../../../src/runes/utxo-selection.js', () => ({
      UtxoSelector: vi.fn().mockImplementation(() => ({})),
    }))

    vi.doMock('../../../src/runes/psbt-builder.js', () => ({
      RunesPsbtBuilder: vi.fn().mockImplementation(() => ({})),
    }))

    vi.doMock('../../../src/runes/UtxoManager.js', () => ({
      UtxoManager: vi.fn().mockImplementation(() => ({})),
    }))

    vi.doMock('../../../src/runes/WalletKeyManager.js', () => ({
      WalletKeyManager: vi.fn().mockImplementation(() => ({
        deriveAddresses: vi.fn(),
      })),
    }))

    vi.doMock('../../../src/utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }))

    const { RunesBackend: RB } = await import('../../../src/runes/RunesBackend.js')
    const mockDb = {} as Pool

    expect(() => new RB(mockDb)).toThrow('Either MINT_SEED or all of')
  })
})

describe('Deposit Amount Verification Scenarios', () => {
  // These tests document the various deposit amount scenarios

  it('documents: exact amount match should succeed', () => {
    const quoteAmount = 500n
    const receivedAmount = 500n

    expect(receivedAmount).toBe(quoteAmount)
  })

  it('documents: overpayment should be detected', () => {
    const quoteAmount = 500n
    const receivedAmount = 2000n // User sent too much

    expect(receivedAmount).not.toBe(quoteAmount)
    expect(receivedAmount > quoteAmount).toBe(true)
  })

  it('documents: underpayment should be detected', () => {
    const quoteAmount = 500n
    const receivedAmount = 100n // User sent too little

    expect(receivedAmount).not.toBe(quoteAmount)
    expect(receivedAmount < quoteAmount).toBe(true)
  })

  it('documents: zero amount should be detected', () => {
    const quoteAmount = 500n
    const receivedAmount = 0n

    expect(receivedAmount).not.toBe(quoteAmount)
  })

  it('documents: string to bigint conversion should preserve precision', () => {
    // Ord API returns amount as string
    const ordAmount = '2000'
    const receivedAmount = BigInt(ordAmount)

    expect(receivedAmount).toBe(2000n)
    expect(typeof receivedAmount).toBe('bigint')
  })

  it('documents: large amounts should be handled correctly', () => {
    const ordAmount = '99999999999999'
    const receivedAmount = BigInt(ordAmount)

    expect(receivedAmount).toBe(99999999999999n)
  })
})
