import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { UtxoManager } from '../../../src/runes/UtxoManager.js'
import { RuneUtxo } from '../../../src/runes/types.js'

// Mock dependencies
vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

describe('UtxoManager', () => {
  let utxoManager: UtxoManager
  let mockPool: Pool

  const sampleUtxo: RuneUtxo = {
    txid: '0'.repeat(64),
    vout: 0,
    value: 10000,
    address: 'tb1ptest123',
    runeAmount: 1000n,
    runeName: 'DUCAT•UNIT•RUNE',
    runeId: { block: 1527352n, tx: 1n },
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockPool = {
      query: vi.fn(),
    } as unknown as Pool

    utxoManager = new UtxoManager(mockPool)
  })

  describe('addUtxo', () => {
    it('should insert a new UTXO into the database', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({ rows: [], rowCount: 1 } as any)

      await utxoManager.addUtxo(sampleUtxo)

      expect(mockPool.query).toHaveBeenCalledTimes(1)
      const [query, params] = vi.mocked(mockPool.query).mock.calls[0]

      expect(query).toContain('INSERT INTO mint_utxos')
      expect(params).toContain(sampleUtxo.txid)
      expect(params).toContain(sampleUtxo.vout)
      expect(params).toContain('1527352:1') // runeId
      expect(params).toContain('1000') // runeAmount as string
      expect(params).toContain(sampleUtxo.address)
      expect(params).toContain(sampleUtxo.value)
      expect(params).toContain(false) // spent
    })

    it('should handle conflict (existing UTXO) gracefully', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({ rows: [], rowCount: 0 } as any)

      // Should not throw
      await expect(utxoManager.addUtxo(sampleUtxo)).resolves.not.toThrow()
    })
  })

  describe('markSpent', () => {
    it('should update UTXO as spent with spending txid', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({ rows: [], rowCount: 1 } as any)

      const spentInTxid = '1'.repeat(64)
      await utxoManager.markSpent(sampleUtxo.txid, sampleUtxo.vout, spentInTxid)

      expect(mockPool.query).toHaveBeenCalledTimes(1)
      const [query, params] = vi.mocked(mockPool.query).mock.calls[0]

      expect(query).toContain('UPDATE mint_utxos')
      expect(query).toContain('SET spent = true')
      expect(params).toContain(spentInTxid)
      expect(params).toContain(sampleUtxo.txid)
      expect(params).toContain(sampleUtxo.vout)
    })
  })

  describe('getUnspentUtxos', () => {
    it('should return unspent UTXOs for a specific rune', async () => {
      const mockUtxos = [
        {
          txid: '0'.repeat(64),
          vout: 0,
          rune_id: '1527352:1',
          amount: '1000',
          address: 'tb1ptest123',
          value: 10000,
          spent: false,
          created_at: Date.now(),
        },
        {
          txid: '1'.repeat(64),
          vout: 1,
          rune_id: '1527352:1',
          amount: '2000',
          address: 'tb1ptest123',
          value: 10000,
          spent: false,
          created_at: Date.now(),
        },
      ]

      vi.mocked(mockPool.query).mockResolvedValue({ rows: mockUtxos, rowCount: 2 } as any)

      const result = await utxoManager.getUnspentUtxos('1527352:1')

      expect(mockPool.query).toHaveBeenCalledTimes(1)
      const [query, params] = vi.mocked(mockPool.query).mock.calls[0]

      expect(query).toContain('SELECT *')
      expect(query).toContain('FROM mint_utxos')
      expect(query).toContain('spent = false')
      expect(params).toContain('1527352:1')

      expect(result).toHaveLength(2)
      expect(result[0].amount).toBe('1000')
      expect(result[1].amount).toBe('2000')
    })

    it('should return empty array when no unspent UTXOs', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({ rows: [], rowCount: 0 } as any)

      const result = await utxoManager.getUnspentUtxos('1527352:1')

      expect(result).toEqual([])
    })
  })

  describe('getBalance', () => {
    it('should return total balance for a rune', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({
        rows: [{ total: '5000' }],
        rowCount: 1,
      } as any)

      const balance = await utxoManager.getBalance('1527352:1')

      expect(balance).toBe(5000n)
      expect(mockPool.query).toHaveBeenCalledTimes(1)

      const [query, params] = vi.mocked(mockPool.query).mock.calls[0]
      expect(query).toContain('SUM(amount::BIGINT)')
      expect(params).toContain('1527352:1')
    })

    it('should return 0 when no UTXOs exist', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({
        rows: [{ total: '0' }],
        rowCount: 1,
      } as any)

      const balance = await utxoManager.getBalance('1527352:1')

      expect(balance).toBe(0n)
    })

    it('should handle null total', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({
        rows: [{}],
        rowCount: 1,
      } as any)

      const balance = await utxoManager.getBalance('1527352:1')

      expect(balance).toBe(0n)
    })
  })

  describe('getSpentUtxoKeys', () => {
    it('should return set of spent UTXO keys', async () => {
      const mockSpent = [
        { txid: '0'.repeat(64), vout: 0 },
        { txid: '1'.repeat(64), vout: 1 },
        { txid: '2'.repeat(64), vout: 2 },
      ]

      vi.mocked(mockPool.query).mockResolvedValue({ rows: mockSpent, rowCount: 3 } as any)

      const result = await utxoManager.getSpentUtxoKeys()

      expect(result).toBeInstanceOf(Set)
      expect(result.size).toBe(3)
      expect(result.has(`${'0'.repeat(64)}:0`)).toBe(true)
      expect(result.has(`${'1'.repeat(64)}:1`)).toBe(true)
      expect(result.has(`${'2'.repeat(64)}:2`)).toBe(true)
    })

    it('should return empty set when no spent UTXOs', async () => {
      vi.mocked(mockPool.query).mockResolvedValue({ rows: [], rowCount: 0 } as any)

      const result = await utxoManager.getSpentUtxoKeys()

      expect(result).toBeInstanceOf(Set)
      expect(result.size).toBe(0)
    })
  })

  describe('syncFromBlockchain', () => {
    it('should add new UTXOs from blockchain', async () => {
      const utxos: RuneUtxo[] = [
        {
          txid: '0'.repeat(64),
          vout: 0,
          value: 10000,
          address: 'tb1ptest123',
          runeAmount: 1000n,
          runeName: 'DUCAT•UNIT•RUNE',
          runeId: { block: 1527352n, tx: 1n },
        },
        {
          txid: '1'.repeat(64),
          vout: 1,
          value: 10000,
          address: 'tb1ptest123',
          runeAmount: 2000n,
          runeName: 'DUCAT•UNIT•RUNE',
          runeId: { block: 1527352n, tx: 1n },
        },
      ]

      // First UTXO is new, second already exists
      vi.mocked(mockPool.query)
        .mockResolvedValueOnce({ rows: [{ txid: utxos[0].txid }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // Already exists

      const result = await utxoManager.syncFromBlockchain('tb1ptest123', utxos)

      expect(result.added).toBe(1)
      expect(result.updated).toBe(0)
      expect(mockPool.query).toHaveBeenCalledTimes(2)
    })

    it('should handle empty UTXO list', async () => {
      const result = await utxoManager.syncFromBlockchain('tb1ptest123', [])

      expect(result.added).toBe(0)
      expect(result.updated).toBe(0)
      expect(mockPool.query).not.toHaveBeenCalled()
    })

    it('should handle database errors gracefully', async () => {
      const utxos: RuneUtxo[] = [sampleUtxo]

      vi.mocked(mockPool.query).mockRejectedValue(new Error('Database error'))

      // Should not throw, just log error
      const result = await utxoManager.syncFromBlockchain('tb1ptest123', utxos)

      expect(result.added).toBe(0)
      expect(result.updated).toBe(0)
    })

    it('should track multiple additions', async () => {
      const utxos: RuneUtxo[] = [
        { ...sampleUtxo, txid: '0'.repeat(64) },
        { ...sampleUtxo, txid: '1'.repeat(64) },
        { ...sampleUtxo, txid: '2'.repeat(64) },
      ]

      vi.mocked(mockPool.query)
        .mockResolvedValueOnce({ rows: [{ txid: utxos[0].txid }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [{ txid: utxos[1].txid }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [{ txid: utxos[2].txid }], rowCount: 1 } as any)

      const result = await utxoManager.syncFromBlockchain('tb1ptest123', utxos)

      expect(result.added).toBe(3)
    })
  })
})
