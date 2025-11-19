import { describe, it, expect } from 'vitest'
import { keysetFromRow } from '../../../src/core/models/Keyset.js'
import { proofFromRow } from '../../../src/core/models/Proof.js'
import { mintQuoteFromRow, meltQuoteFromRow } from '../../../src/core/models/Quote.js'

describe('Model Conversions', () => {
  describe('Keyset', () => {
    it('should convert keyset row with string JSONB to Keyset', () => {
      const row = {
        id: 'test123',
        unit: 'sat',
        rune_id: '840000:3',
        active: true,
        private_keys: JSON.stringify({ '1': 'key1', '2': 'key2' }),
        public_keys: JSON.stringify({ '1': 'pub1', '2': 'pub2' }),
        input_fee_ppk: 100,
        final_expiry: BigInt(1234567890),
        created_at: BigInt(1234567890),
      }

      const keyset = keysetFromRow(row)

      expect(keyset.id).toBe('test123')
      expect(keyset.private_keys).toEqual({ '1': 'key1', '2': 'key2' })
      expect(keyset.public_keys).toEqual({ '1': 'pub1', '2': 'pub2' })
      expect(keyset.input_fee_ppk).toBe(100)
      expect(keyset.final_expiry).toBe(1234567890)
    })

    it('should convert keyset row with object JSONB to Keyset', () => {
      const row = {
        id: 'test456',
        unit: 'sat',
        rune_id: '840000:3',
        active: true,
        private_keys: { '1': 'key1' },
        public_keys: { '1': 'pub1' },
        input_fee_ppk: null,
        final_expiry: null,
        created_at: BigInt(1234567890),
      }

      const keyset = keysetFromRow(row)

      expect(keyset.private_keys).toEqual({ '1': 'key1' })
      expect(keyset.public_keys).toEqual({ '1': 'pub1' })
      expect(keyset.input_fee_ppk).toBeUndefined()
      expect(keyset.final_expiry).toBeUndefined()
    })
  })

  describe('Proof', () => {
    it('should convert proof row to Proof', () => {
      const row = {
        Y: '02abc123',
        amount: BigInt(100),
        keyset_id: 'keyset1',
        secret: 'secret1',
        C: '03def456',
        transaction_id: 'tx1',
        created_at: BigInt(1234567890),
      }

      const proof = proofFromRow(row)

      expect(proof.Y).toBe('02abc123')
      expect(proof.amount).toBe(100)
      expect(proof.keyset_id).toBe('keyset1')
      expect(proof.secret).toBe('secret1')
    })
  })

  describe('Quote', () => {
    it('should convert mint quote row to MintQuote', () => {
      const row = {
        id: 'quote1',
        amount: BigInt(1000),
        unit: 'sat',
        rune_id: '840000:3',
        request: 'request1',
        state: 'PAID' as const,
        expiry: BigInt(1234567890),
        txid: 'txid123',
        vout: 0,
        paid_at: BigInt(1234567800),
        created_at: BigInt(1234567700),
      }

      const quote = mintQuoteFromRow(row)

      expect(quote.id).toBe('quote1')
      expect(quote.amount).toBe(1000)
      expect(quote.state).toBe('PAID')
      expect(quote.txid).toBe('txid123')
      expect(quote.vout).toBe(0)
    })

    it('should handle null fields in mint quote', () => {
      const row = {
        id: 'quote2',
        amount: BigInt(2000),
        unit: 'sat',
        rune_id: '840000:3',
        request: 'request2',
        state: 'UNPAID' as const,
        expiry: BigInt(1234567890),
        txid: null,
        vout: null,
        paid_at: null,
        created_at: BigInt(1234567700),
      }

      const quote = mintQuoteFromRow(row)

      expect(quote.txid).toBeUndefined()
      expect(quote.vout).toBeUndefined()
      expect(quote.paid_at).toBeUndefined()
    })

    it('should convert melt quote row to MeltQuote', () => {
      const row = {
        id: 'melt1',
        amount: BigInt(3000),
        fee_reserve: BigInt(300),
        unit: 'sat',
        rune_id: '840000:3',
        request: 'destination1',
        state: 'PAID' as const,
        expiry: BigInt(1234567890),
        txid: 'txid123',
        fee_paid: BigInt(50),
        paid_at: BigInt(1234567800),
        created_at: BigInt(1234567700),
      }

      const quote = meltQuoteFromRow(row)

      expect(quote.id).toBe('melt1')
      expect(quote.amount).toBe(3000)
      expect(quote.fee_reserve).toBe(300)
      expect(quote.txid).toBe('txid123')
      expect(quote.fee_paid).toBe(50)
    })

    it('should handle null fields in melt quote', () => {
      const row = {
        id: 'melt2',
        amount: BigInt(4000),
        fee_reserve: BigInt(400),
        unit: 'sat',
        rune_id: '840000:3',
        request: 'destination2',
        state: 'UNPAID' as const,
        expiry: BigInt(1234567890),
        txid: null,
        fee_paid: null,
        paid_at: null,
        created_at: BigInt(1234567700),
      }

      const quote = meltQuoteFromRow(row)

      expect(quote.txid).toBeUndefined()
      expect(quote.fee_paid).toBeUndefined()
      expect(quote.paid_at).toBeUndefined()
    })
  })
})
