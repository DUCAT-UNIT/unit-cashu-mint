import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UtxoSelector } from '../../../src/runes/utxo-selection.js'
import { OrdClient, EsploraClient } from '../../../src/runes/api-client.js'
import { RUNES_TX_CONSTANTS } from '../../../src/runes/types.js'

// Mock the logger
vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

describe('UtxoSelector', () => {
  let utxoSelector: UtxoSelector
  let mockOrdClient: OrdClient
  let mockEsploraClient: EsploraClient

  const DUCAT_RUNE_NAME = 'DUCAT•UNIT•RUNE'
  const DUCAT_RUNE_ID = { block: 1527352n, tx: 1n }

  beforeEach(() => {
    mockOrdClient = {
      getAddressOutputs: vi.fn(),
      getOutput: vi.fn(),
    } as unknown as OrdClient

    mockEsploraClient = {
      getAddressUtxos: vi.fn(),
      getOutspend: vi.fn(),
    } as unknown as EsploraClient

    utxoSelector = new UtxoSelector(mockOrdClient, mockEsploraClient)
  })

  describe('findRuneUtxos', () => {
    it('should find a single UTXO with sufficient runes', async () => {
      const taprootAddress = 'tb1ptest123'

      vi.mocked(mockOrdClient.getAddressOutputs).mockResolvedValue({
        outputs: ['txid1:0'],
        runes_balances: [[DUCAT_RUNE_NAME, '1000', '$']],
      })

      vi.mocked(mockOrdClient.getOutput).mockResolvedValue({
        transaction: 'txid1',
        value: 10000,
        runes: {
          [DUCAT_RUNE_NAME]: {
            amount: '1000',
            id: '1527352:1',
          },
        },
      })

      vi.mocked(mockEsploraClient.getOutspend).mockResolvedValue({
        spent: false,
      })

      const result = await utxoSelector.findRuneUtxos(
        taprootAddress,
        500n,
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID
      )

      expect(result).not.toBeNull()
      expect(result).toHaveLength(1)
      expect(result![0].runeAmount).toBe(1000n)
      expect(result![0].txid).toBe('txid1')
      expect(result![0].vout).toBe(0)
    })

    it('should combine multiple UTXOs when single one is insufficient', async () => {
      const taprootAddress = 'tb1ptest123'

      vi.mocked(mockOrdClient.getAddressOutputs).mockResolvedValue({
        outputs: ['txid1:0', 'txid2:0', 'txid3:0'],
        runes_balances: [[DUCAT_RUNE_NAME, '1500', '$']],
      })

      // Each UTXO has 500 runes
      vi.mocked(mockOrdClient.getOutput)
        .mockResolvedValueOnce({
          transaction: 'txid1',
          value: 10000,
          runes: { [DUCAT_RUNE_NAME]: { amount: '500', id: '1527352:1' } },
        })
        .mockResolvedValueOnce({
          transaction: 'txid2',
          value: 10000,
          runes: { [DUCAT_RUNE_NAME]: { amount: '500', id: '1527352:1' } },
        })
        .mockResolvedValueOnce({
          transaction: 'txid3',
          value: 10000,
          runes: { [DUCAT_RUNE_NAME]: { amount: '500', id: '1527352:1' } },
        })

      vi.mocked(mockEsploraClient.getOutspend).mockResolvedValue({ spent: false })

      // Request 1200 runes - needs 3 UTXOs
      const result = await utxoSelector.findRuneUtxos(
        taprootAddress,
        1200n,
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID
      )

      expect(result).not.toBeNull()
      expect(result).toHaveLength(3)

      const totalRunes = result!.reduce((sum, utxo) => sum + utxo.runeAmount, 0n)
      expect(totalRunes).toBe(1500n)
    })

    it('should return null when insufficient runes available', async () => {
      const taprootAddress = 'tb1ptest123'

      vi.mocked(mockOrdClient.getAddressOutputs).mockResolvedValue({
        outputs: ['txid1:0'],
        runes_balances: [[DUCAT_RUNE_NAME, '100', '$']],
      })

      vi.mocked(mockOrdClient.getOutput).mockResolvedValue({
        transaction: 'txid1',
        value: 10000,
        runes: { [DUCAT_RUNE_NAME]: { amount: '100', id: '1527352:1' } },
      })

      vi.mocked(mockEsploraClient.getOutspend).mockResolvedValue({ spent: false })

      const result = await utxoSelector.findRuneUtxos(
        taprootAddress,
        500n, // Need 500 but only have 100
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID
      )

      expect(result).toBeNull()
    })

    it('should skip already-spent UTXOs from spentUtxos set', async () => {
      const taprootAddress = 'tb1ptest123'
      const spentUtxos = new Set(['txid1:0'])

      vi.mocked(mockOrdClient.getAddressOutputs).mockResolvedValue({
        outputs: ['txid1:0', 'txid2:0'],
        runes_balances: [[DUCAT_RUNE_NAME, '2000', '$']],
      })

      // Only txid2 should be checked (txid1 is in spentUtxos)
      vi.mocked(mockOrdClient.getOutput).mockResolvedValue({
        transaction: 'txid2',
        value: 10000,
        runes: { [DUCAT_RUNE_NAME]: { amount: '1000', id: '1527352:1' } },
      })

      vi.mocked(mockEsploraClient.getOutspend).mockResolvedValue({ spent: false })

      const result = await utxoSelector.findRuneUtxos(
        taprootAddress,
        500n,
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID,
        spentUtxos
      )

      expect(result).not.toBeNull()
      expect(result).toHaveLength(1)
      expect(result![0].txid).toBe('txid2')

      // getOutput should only be called once (for txid2)
      expect(mockOrdClient.getOutput).toHaveBeenCalledTimes(1)
    })

    it('should skip UTXOs that are spent on-chain', async () => {
      const taprootAddress = 'tb1ptest123'

      vi.mocked(mockOrdClient.getAddressOutputs).mockResolvedValue({
        outputs: ['txid1:0', 'txid2:0'],
        runes_balances: [[DUCAT_RUNE_NAME, '2000', '$']],
      })

      vi.mocked(mockOrdClient.getOutput)
        .mockResolvedValueOnce({
          transaction: 'txid1',
          value: 10000,
          runes: { [DUCAT_RUNE_NAME]: { amount: '1000', id: '1527352:1' } },
        })
        .mockResolvedValueOnce({
          transaction: 'txid2',
          value: 10000,
          runes: { [DUCAT_RUNE_NAME]: { amount: '1000', id: '1527352:1' } },
        })

      // First UTXO is spent on-chain
      vi.mocked(mockEsploraClient.getOutspend)
        .mockResolvedValueOnce({ spent: true, txid: 'spending_tx' })
        .mockResolvedValueOnce({ spent: false })

      const result = await utxoSelector.findRuneUtxos(
        taprootAddress,
        500n,
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID
      )

      expect(result).not.toBeNull()
      expect(result).toHaveLength(1)
      expect(result![0].txid).toBe('txid2')
    })

    it('should skip UTXOs without the required rune', async () => {
      const taprootAddress = 'tb1ptest123'

      vi.mocked(mockOrdClient.getAddressOutputs).mockResolvedValue({
        outputs: ['txid1:0', 'txid2:0'],
        runes_balances: [[DUCAT_RUNE_NAME, '1000', '$']],
      })

      // First UTXO has a different rune
      vi.mocked(mockOrdClient.getOutput)
        .mockResolvedValueOnce({
          transaction: 'txid1',
          value: 10000,
          runes: { 'OTHER•RUNE': { amount: '5000', id: '123:1' } },
        })
        .mockResolvedValueOnce({
          transaction: 'txid2',
          value: 10000,
          runes: { [DUCAT_RUNE_NAME]: { amount: '1000', id: '1527352:1' } },
        })

      vi.mocked(mockEsploraClient.getOutspend).mockResolvedValue({ spent: false })

      const result = await utxoSelector.findRuneUtxos(
        taprootAddress,
        500n,
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID
      )

      expect(result).not.toBeNull()
      expect(result).toHaveLength(1)
      expect(result![0].txid).toBe('txid2')
    })

    it('should return null when no runes at address', async () => {
      const taprootAddress = 'tb1ptest123'

      vi.mocked(mockOrdClient.getAddressOutputs).mockResolvedValue({
        outputs: [],
        runes_balances: [],
      })

      const result = await utxoSelector.findRuneUtxos(
        taprootAddress,
        500n,
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID
      )

      expect(result).toBeNull()
    })

    it('should throw when API error occurs', async () => {
      const taprootAddress = 'tb1ptest123'

      vi.mocked(mockOrdClient.getAddressOutputs).mockRejectedValue(new Error('API timeout'))

      await expect(utxoSelector.findRuneUtxos(
        taprootAddress,
        500n,
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID
      )).rejects.toThrow('API timeout')
    })
  })

  describe('findSatUtxo', () => {
    it('should find a suitable sat UTXO for fees', async () => {
      const segwitAddress = 'tb1qtest123'

      vi.mocked(mockEsploraClient.getAddressUtxos).mockResolvedValue([
        {
          txid: 'fee_txid',
          vout: 0,
          value: 50000,
          status: { confirmed: true, block_height: 100 },
        },
      ])

      const result = await utxoSelector.findSatUtxo(segwitAddress)

      expect(result).not.toBeNull()
      expect(result!.txid).toBe('fee_txid')
      expect(result!.value).toBe(50000)
    })

    it('should skip UTXOs with insufficient sats', async () => {
      const segwitAddress = 'tb1qtest123'

      vi.mocked(mockEsploraClient.getAddressUtxos).mockResolvedValue([
        {
          txid: 'small_txid',
          vout: 0,
          value: 1000, // Less than MIN_SAT_UTXO
          status: { confirmed: true, block_height: 100 },
        },
        {
          txid: 'big_txid',
          vout: 0,
          value: 50000,
          status: { confirmed: true, block_height: 100 },
        },
      ])

      const result = await utxoSelector.findSatUtxo(segwitAddress)

      expect(result).not.toBeNull()
      expect(result!.txid).toBe('big_txid')
      expect(result!.value).toBeGreaterThanOrEqual(RUNES_TX_CONSTANTS.MIN_SAT_UTXO)
    })

    it('should skip unconfirmed UTXOs', async () => {
      const segwitAddress = 'tb1qtest123'

      vi.mocked(mockEsploraClient.getAddressUtxos).mockResolvedValue([
        {
          txid: 'unconfirmed_txid',
          vout: 0,
          value: 50000,
          status: { confirmed: false },
        },
        {
          txid: 'confirmed_txid',
          vout: 0,
          value: 30000,
          status: { confirmed: true, block_height: 100 },
        },
      ])

      const result = await utxoSelector.findSatUtxo(segwitAddress)

      expect(result).not.toBeNull()
      expect(result!.txid).toBe('confirmed_txid')
    })

    it('should skip UTXOs in spentUtxos set', async () => {
      const segwitAddress = 'tb1qtest123'
      const spentUtxos = new Set(['spent_txid:0'])

      vi.mocked(mockEsploraClient.getAddressUtxos).mockResolvedValue([
        {
          txid: 'spent_txid',
          vout: 0,
          value: 50000,
          status: { confirmed: true, block_height: 100 },
        },
        {
          txid: 'unspent_txid',
          vout: 0,
          value: 30000,
          status: { confirmed: true, block_height: 100 },
        },
      ])

      const result = await utxoSelector.findSatUtxo(segwitAddress, spentUtxos)

      expect(result).not.toBeNull()
      expect(result!.txid).toBe('unspent_txid')
    })

    it('should return null when no suitable UTXOs', async () => {
      const segwitAddress = 'tb1qtest123'

      vi.mocked(mockEsploraClient.getAddressUtxos).mockResolvedValue([])

      const result = await utxoSelector.findSatUtxo(segwitAddress)

      expect(result).toBeNull()
    })

    it('should throw when API error occurs', async () => {
      const segwitAddress = 'tb1qtest123'

      vi.mocked(mockEsploraClient.getAddressUtxos).mockRejectedValue(new Error('Network error'))

      await expect(utxoSelector.findSatUtxo(segwitAddress))
        .rejects.toThrow('Network error')
    })
  })

  describe('findUtxosForRunesTransfer', () => {
    it('should find both rune and sat UTXOs', async () => {
      const taprootAddress = 'tb1ptest123'
      const segwitAddress = 'tb1qtest123'

      // Mock rune UTXO
      vi.mocked(mockOrdClient.getAddressOutputs).mockResolvedValue({
        outputs: ['rune_txid:0'],
        runes_balances: [[DUCAT_RUNE_NAME, '1000', '$']],
      })

      vi.mocked(mockOrdClient.getOutput).mockResolvedValue({
        transaction: 'rune_txid',
        value: 10000,
        runes: { [DUCAT_RUNE_NAME]: { amount: '1000', id: '1527352:1' } },
      })

      vi.mocked(mockEsploraClient.getOutspend).mockResolvedValue({ spent: false })

      // Mock sat UTXO
      vi.mocked(mockEsploraClient.getAddressUtxos).mockResolvedValue([
        {
          txid: 'sat_txid',
          vout: 0,
          value: 50000,
          status: { confirmed: true, block_height: 100 },
        },
      ])

      const result = await utxoSelector.findUtxosForRunesTransfer(
        taprootAddress,
        segwitAddress,
        500n,
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID
      )

      expect(result).not.toBeNull()
      expect(result!.runeUtxos).toHaveLength(1)
      expect(result!.runeUtxos[0].txid).toBe('rune_txid')
      expect(result!.satUtxo.txid).toBe('sat_txid')
    })

    it('should return null when rune UTXOs not found', async () => {
      const taprootAddress = 'tb1ptest123'
      const segwitAddress = 'tb1qtest123'

      vi.mocked(mockOrdClient.getAddressOutputs).mockResolvedValue({
        outputs: [],
        runes_balances: [],
      })

      const result = await utxoSelector.findUtxosForRunesTransfer(
        taprootAddress,
        segwitAddress,
        500n,
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID
      )

      expect(result).toBeNull()
    })

    it('should return null when sat UTXO not found', async () => {
      const taprootAddress = 'tb1ptest123'
      const segwitAddress = 'tb1qtest123'

      // Have rune UTXOs
      vi.mocked(mockOrdClient.getAddressOutputs).mockResolvedValue({
        outputs: ['rune_txid:0'],
        runes_balances: [[DUCAT_RUNE_NAME, '1000', '$']],
      })

      vi.mocked(mockOrdClient.getOutput).mockResolvedValue({
        transaction: 'rune_txid',
        value: 10000,
        runes: { [DUCAT_RUNE_NAME]: { amount: '1000', id: '1527352:1' } },
      })

      vi.mocked(mockEsploraClient.getOutspend).mockResolvedValue({ spent: false })

      // No sat UTXOs available
      vi.mocked(mockEsploraClient.getAddressUtxos).mockResolvedValue([])

      const result = await utxoSelector.findUtxosForRunesTransfer(
        taprootAddress,
        segwitAddress,
        500n,
        DUCAT_RUNE_NAME,
        DUCAT_RUNE_ID
      )

      expect(result).toBeNull()
    })
  })
})
