import { describe, it, expect, afterAll } from 'vitest'
import { query, transaction, testConnection, closePool, pool } from '../../../src/database/db.js'

describe('Database', () => {
  afterAll(async () => {
    // Don't actually close the pool in tests as it's shared
  })

  describe('query', () => {
    it('should execute a query successfully', async () => {
      const result = await query<{ num: number }>('SELECT 1 as num')

      expect(result.rows).toBeDefined()
      expect(result.rows[0].num).toBe(1)
    })

    it('should handle query with parameters', async () => {
      const result = await query<{ result: number }>('SELECT $1::int as result', [42])

      expect(result.rows[0].result).toBe(42)
    })

    it('should throw on invalid query', async () => {
      await expect(
        query('SELECT * FROM nonexistent_table_xyz')
      ).rejects.toThrow()
    })
  })

  describe('transaction', () => {
    it('should commit successful transaction', async () => {
      const result = await transaction(async (client) => {
        const res = await client.query<{ num: number }>('SELECT 1 as num')
        return res.rows[0].num
      })

      expect(result).toBe(1)
    })

    it('should rollback on error', async () => {
      await expect(
        transaction(async (client) => {
          await client.query('SELECT 1')
          throw new Error('Transaction failed')
        })
      ).rejects.toThrow('Transaction failed')
    })

    it('should rollback on query error', async () => {
      await expect(
        transaction(async (client) => {
          await client.query('SELECT * FROM nonexistent_table_xyz')
        })
      ).rejects.toThrow()
    })
  })

  describe('testConnection', () => {
    it('should return true on successful connection', async () => {
      const result = await testConnection()

      expect(result).toBe(true)
    })
  })

  describe('pool events', () => {
    it('should have error handler registered', () => {
      // Pool should have an error listener
      const errorListeners = pool.listeners('error')
      expect(errorListeners.length).toBeGreaterThan(0)
    })

    it('should have connect handler registered', () => {
      // Pool should have a connect listener
      const connectListeners = pool.listeners('connect')
      expect(connectListeners.length).toBeGreaterThan(0)
    })
  })
})
