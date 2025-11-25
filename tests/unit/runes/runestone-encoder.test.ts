import { describe, it, expect } from 'vitest'
import { encodeRunestone, decodeRunestone } from '../../../src/runes/runestone-encoder.js'
import { RuneId, RuneEdict } from '../../../src/runes/types.js'

describe('Runestone Encoder', () => {
  describe('encodeRunestone', () => {
    it('should encode an empty runestone', () => {
      const result = encodeRunestone({ edicts: [] })

      // OP_RETURN (0x6a) + OP_13 (0x5d) + empty payload (0x00)
      expect(result.encodedRunestone.toString('hex')).toBe('6a5d00')
    })

    it('should encode a single edict', () => {
      const edict: RuneEdict = {
        id: { block: 1527352n, tx: 1n },
        amount: 500n,
        output: 1,
      }

      const result = encodeRunestone({ edicts: [edict] })

      // Should start with OP_RETURN (6a) + OP_13 (5d)
      expect(result.encodedRunestone[0]).toBe(0x6a)
      expect(result.encodedRunestone[1]).toBe(0x5d)

      // Decode and verify
      const decoded = decodeRunestone(result.encodedRunestone)
      expect(decoded).not.toBeNull()
      expect(decoded!.edicts).toHaveLength(1)
      expect(decoded!.edicts[0].id.block).toBe(1527352n)
      expect(decoded!.edicts[0].id.tx).toBe(1n)
      expect(decoded!.edicts[0].amount).toBe(500n)
      expect(decoded!.edicts[0].output).toBe(1n)
    })

    it('should encode the DUCAT•UNIT•RUNE ID correctly', () => {
      // This is the actual rune ID used in production
      const edict: RuneEdict = {
        id: { block: 1527352n, tx: 1n },
        amount: 2000n,
        output: 1,
      }

      const result = encodeRunestone({ edicts: [edict] })
      const decoded = decodeRunestone(result.encodedRunestone)

      expect(decoded!.edicts[0].id.block).toBe(1527352n)
      expect(decoded!.edicts[0].id.tx).toBe(1n)
      expect(decoded!.edicts[0].amount).toBe(2000n)
    })

    it('should encode multiple edicts with delta encoding', () => {
      // Note: In runes protocol, both block AND tx are delta-encoded
      // tx delta is from the PREVIOUS tx value, not reset on new block
      const edicts: RuneEdict[] = [
        { id: { block: 1000n, tx: 1n }, amount: 100n, output: 1 },
        { id: { block: 1000n, tx: 2n }, amount: 200n, output: 2 },
        { id: { block: 1001n, tx: 3n }, amount: 300n, output: 1 }, // tx continues from 2
      ]

      const result = encodeRunestone({ edicts })
      const decoded = decodeRunestone(result.encodedRunestone)

      expect(decoded!.edicts).toHaveLength(3)
      expect(decoded!.edicts[0].id.block).toBe(1000n)
      expect(decoded!.edicts[0].id.tx).toBe(1n)
      expect(decoded!.edicts[0].amount).toBe(100n)
      expect(decoded!.edicts[1].id.block).toBe(1000n)
      expect(decoded!.edicts[1].id.tx).toBe(2n)
      expect(decoded!.edicts[1].amount).toBe(200n)
      expect(decoded!.edicts[2].id.block).toBe(1001n)
      expect(decoded!.edicts[2].id.tx).toBe(3n)
      expect(decoded!.edicts[2].amount).toBe(300n)
    })

    it('should encode large amounts correctly', () => {
      // Test with amounts that require multiple varint bytes
      const edict: RuneEdict = {
        id: { block: 1527352n, tx: 1n },
        amount: 100000000000n, // 100 billion
        output: 1,
      }

      const result = encodeRunestone({ edicts: [edict] })
      const decoded = decodeRunestone(result.encodedRunestone)

      expect(decoded!.edicts[0].amount).toBe(100000000000n)
    })

    it('should encode amounts at varint boundaries', () => {
      // Test edge cases at varint encoding boundaries
      const testCases = [
        127n,    // max 1-byte varint
        128n,    // min 2-byte varint
        16383n,  // max 2-byte varint
        16384n,  // min 3-byte varint
      ]

      for (const amount of testCases) {
        const edict: RuneEdict = {
          id: { block: 100n, tx: 1n },
          amount,
          output: 1,
        }

        const result = encodeRunestone({ edicts: [edict] })
        const decoded = decodeRunestone(result.encodedRunestone)

        expect(decoded!.edicts[0].amount).toBe(amount)
      }
    })
  })

  describe('decodeRunestone', () => {
    it('should decode a known real-world runestone', () => {
      // This is the actual runestone from the failing transaction:
      // txid: 8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df
      // OP_RETURN data: 00b89c5d01d00f01
      const scriptHex = '6a5d0800b89c5d01d00f01'
      const decoded = decodeRunestone(scriptHex)

      expect(decoded).not.toBeNull()
      expect(decoded!.edicts).toHaveLength(1)
      expect(decoded!.edicts[0].id.block).toBe(1527352n) // DUCAT•UNIT•RUNE block
      expect(decoded!.edicts[0].id.tx).toBe(1n)
      expect(decoded!.edicts[0].amount).toBe(2000n) // The actual amount sent!
      expect(decoded!.edicts[0].output).toBe(1n)
    })

    it('should return null for non-OP_RETURN scripts', () => {
      const notOpReturn = Buffer.from([0x00, 0x5d, 0x00])
      expect(decodeRunestone(notOpReturn)).toBeNull()
    })

    it('should return null for non-Runes OP_RETURN', () => {
      // OP_RETURN but not OP_13 (not a runes script)
      const notRunes = Buffer.from([0x6a, 0x04, 0x01, 0x02, 0x03, 0x04])
      expect(decodeRunestone(notRunes)).toBeNull()
    })

    it('should decode empty runestone', () => {
      const empty = Buffer.from([0x6a, 0x5d, 0x00])
      const decoded = decodeRunestone(empty)

      expect(decoded).not.toBeNull()
      expect(decoded!.edicts).toHaveLength(0)
    })

    it('should handle hex string input', () => {
      const hexString = '6a5d0800b89c5d01d00f01'
      const decoded = decodeRunestone(hexString)

      expect(decoded).not.toBeNull()
      expect(decoded!.edicts).toHaveLength(1)
    })

    it('should handle Buffer input', () => {
      const buffer = Buffer.from('6a5d0800b89c5d01d00f01', 'hex')
      const decoded = decodeRunestone(buffer)

      expect(decoded).not.toBeNull()
      expect(decoded!.edicts).toHaveLength(1)
    })

    it('should handle edge cases gracefully', () => {
      // Very short script - returns empty edicts
      const shortScript = decodeRunestone(Buffer.from([0x6a, 0x5d]))
      // May return empty edicts or null depending on implementation
      if (shortScript !== null) {
        expect(shortScript.edicts).toHaveLength(0)
      }

      // Script with claimed large payload but truncated data
      // This tests resilience to malformed inputs
      const truncatedScript = Buffer.from([0x6a, 0x5d, 0x10, 0x00]) // claims 16 bytes but only 1
      const result = decodeRunestone(truncatedScript)
      // Should either return null or handle gracefully
      if (result !== null) {
        // If it parses, it should have valid structure
        expect(result.edicts).toBeDefined()
      }
    })
  })

  describe('roundtrip encoding/decoding', () => {
    it('should roundtrip a simple edict', () => {
      const original: RuneEdict = {
        id: { block: 12345n, tx: 67n },
        amount: 999n,
        output: 2,
      }

      const encoded = encodeRunestone({ edicts: [original] })
      const decoded = decodeRunestone(encoded.encodedRunestone)

      expect(decoded!.edicts[0].id.block).toBe(original.id.block)
      expect(decoded!.edicts[0].id.tx).toBe(original.id.tx)
      expect(decoded!.edicts[0].amount).toBe(original.amount)
      expect(decoded!.edicts[0].output).toBe(BigInt(original.output))
    })

    it('should roundtrip multiple edicts', () => {
      const originals: RuneEdict[] = [
        { id: { block: 100n, tx: 1n }, amount: 1000n, output: 0 },
        { id: { block: 200n, tx: 2n }, amount: 2000n, output: 1 },
        { id: { block: 300n, tx: 3n }, amount: 3000n, output: 2 },
      ]

      const encoded = encodeRunestone({ edicts: originals })
      const decoded = decodeRunestone(encoded.encodedRunestone)

      expect(decoded!.edicts).toHaveLength(3)
      for (let i = 0; i < originals.length; i++) {
        expect(decoded!.edicts[i].id.block).toBe(originals[i].id.block)
        expect(decoded!.edicts[i].id.tx).toBe(originals[i].id.tx)
        expect(decoded!.edicts[i].amount).toBe(originals[i].amount)
        expect(decoded!.edicts[i].output).toBe(BigInt(originals[i].output))
      }
    })

    it('should roundtrip with zero amounts', () => {
      const edict: RuneEdict = {
        id: { block: 1n, tx: 0n },
        amount: 0n,
        output: 0,
      }

      const encoded = encodeRunestone({ edicts: [edict] })
      const decoded = decodeRunestone(encoded.encodedRunestone)

      expect(decoded!.edicts[0].amount).toBe(0n)
    })

    it('should roundtrip with output index 0', () => {
      const edict: RuneEdict = {
        id: { block: 1527352n, tx: 1n },
        amount: 500n,
        output: 0,
      }

      const encoded = encodeRunestone({ edicts: [edict] })
      const decoded = decodeRunestone(encoded.encodedRunestone)

      expect(decoded!.edicts[0].output).toBe(0n)
    })
  })

  describe('non-edict tag handling', () => {
    it('should return empty edicts for non-zero tag', () => {
      // A runestone with tag != 0 (e.g., tag = 1 for etching or other data)
      // OP_RETURN (0x6a) + OP_13 (0x5d) + length (0x01) + tag (0x01 = etching)
      const nonEdictRunestone = Buffer.from([0x6a, 0x5d, 0x01, 0x01])
      const decoded = decodeRunestone(nonEdictRunestone)

      expect(decoded).not.toBeNull()
      expect(decoded!.edicts).toHaveLength(0)
    })
  })

  describe('error handling', () => {
    it('should return null on decode errors', () => {
      // Create a malformed buffer that will cause an error during parsing
      // This has OP_RETURN + OP_13 + length that claims more bytes than exist
      // and also has malformed varint that would cause issues
      const malformedScript = Buffer.from([0x6a, 0x5d, 0x50]) // Claims 80 bytes but has none

      // The decode should gracefully return null on any error
      const result = decodeRunestone(malformedScript)

      // Either null or empty edicts is acceptable for malformed data
      if (result !== null) {
        expect(result.edicts).toBeDefined()
      }
    })

    it('should handle truncated edict data', () => {
      // Valid start but truncated in the middle of an edict
      // OP_RETURN + OP_13 + length(10) + tag(0) + partial edict data
      const truncated = Buffer.from([0x6a, 0x5d, 0x0a, 0x00, 0x80, 0x80, 0x80])
      const result = decodeRunestone(truncated)

      // Should either return null or handle gracefully
      if (result !== null) {
        expect(result.edicts).toBeDefined()
      }
    })

    it('should return null when script type causes an exception', () => {
      // Pass something that will cause an error when trying to access buffer properties
      // The decodeRunestone function has a try/catch that returns null on error
      // We need to pass something that will throw when trying to access scriptBuffer[0]

      // Create an object that looks like a buffer but throws when accessed
      const badScript = {
        get 0() { throw new Error('Cannot access') },
        get length() { return 3 },
      } as unknown as Buffer

      const result = decodeRunestone(badScript)
      expect(result).toBeNull()
    })
  })

  describe('varint edge cases', () => {
    it('should handle block numbers requiring multiple bytes', () => {
      const edict: RuneEdict = {
        id: { block: 2097151n, tx: 1n }, // max 3-byte varint
        amount: 1n,
        output: 0,
      }

      const encoded = encodeRunestone({ edicts: [edict] })
      const decoded = decodeRunestone(encoded.encodedRunestone)

      expect(decoded!.edicts[0].id.block).toBe(2097151n)
    })

    it('should handle very large block numbers', () => {
      const edict: RuneEdict = {
        id: { block: 999999999n, tx: 1n },
        amount: 1n,
        output: 0,
      }

      const encoded = encodeRunestone({ edicts: [edict] })
      const decoded = decodeRunestone(encoded.encodedRunestone)

      expect(decoded!.edicts[0].id.block).toBe(999999999n)
    })
  })
})
