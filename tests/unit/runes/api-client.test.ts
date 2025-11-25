import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OrdClient, EsploraClient } from '../../../src/runes/api-client.js'

// Mock the logger
vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

describe('API Clients', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('OrdClient', () => {
    let ordClient: OrdClient

    beforeEach(() => {
      ordClient = new OrdClient('https://ord-test.example.com')
    })

    describe('getAddressOutputs', () => {
      it('should parse address outputs response correctly', async () => {
        const mockResponse = {
          outputs: [
            'abc123:0',
            'def456:1',
            'ghi789:2',
          ],
          runes_balances: [
            ['DUCAT•UNIT•RUNE', '50000', '$'],
            ['OTHER•RUNE', '1000', '¤'],
          ],
        }

        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        })

        const result = await ordClient.getAddressOutputs('tb1ptest123')

        expect(result.outputs).toHaveLength(3)
        expect(result.outputs[0]).toBe('abc123:0')
        expect(result.runes_balances).toHaveLength(2)
        expect(result.runes_balances![0][0]).toBe('DUCAT•UNIT•RUNE')
        expect(result.runes_balances![0][1]).toBe('50000')
      })

      it('should handle address with no outputs', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({
            outputs: [],
            runes_balances: [],
          }),
        })

        const result = await ordClient.getAddressOutputs('tb1pempty')

        expect(result.outputs).toHaveLength(0)
        expect(result.runes_balances).toHaveLength(0)
      })

      it('should handle missing runes_balances field', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({
            outputs: ['abc:0'],
          }),
        })

        const result = await ordClient.getAddressOutputs('tb1ptest')

        expect(result.outputs).toHaveLength(1)
        expect(result.runes_balances).toBeUndefined()
      })
    })

    describe('getOutput', () => {
      it('should parse output with runes correctly', async () => {
        // Real response format from ord API
        const mockResponse = {
          transaction: '8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df',
          value: 10000,
          runes: {
            'DUCAT•UNIT•RUNE': {
              amount: '2000',
              divisibility: 2,
              symbol: '$',
              id: '1527352:1',
            },
          },
        }

        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        })

        const result = await ordClient.getOutput(
          '8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df',
          1
        )

        expect(result.value).toBe(10000)
        expect(result.runes).toBeDefined()
        expect(result.runes!['DUCAT•UNIT•RUNE'].amount).toBe('2000')
        expect(result.runes!['DUCAT•UNIT•RUNE'].id).toBe('1527352:1')
      })

      it('should parse output without runes', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({
            transaction: 'abc123',
            value: 50000,
          }),
        })

        const result = await ordClient.getOutput('abc123', 0)

        expect(result.value).toBe(50000)
        expect(result.runes).toBeUndefined()
      })

      it('should parse output with multiple runes', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({
            transaction: 'abc123',
            value: 10000,
            runes: {
              'RUNE•ONE': { amount: '100', id: '100:1' },
              'RUNE•TWO': { amount: '200', id: '200:2' },
              'RUNE•THREE': { amount: '300', id: '300:3' },
            },
          }),
        })

        const result = await ordClient.getOutput('abc123', 0)

        expect(Object.keys(result.runes!)).toHaveLength(3)
        expect(result.runes!['RUNE•ONE'].amount).toBe('100')
        expect(result.runes!['RUNE•TWO'].amount).toBe('200')
        expect(result.runes!['RUNE•THREE'].amount).toBe('300')
      })

      it('should handle large rune amounts as strings', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({
            transaction: 'abc123',
            value: 10000,
            runes: {
              'BIG•RUNE': {
                amount: '99999999999999999999', // Very large number
                id: '100:1',
              },
            },
          }),
        })

        const result = await ordClient.getOutput('abc123', 0)

        // Amount should be preserved as string to avoid precision loss
        expect(result.runes!['BIG•RUNE'].amount).toBe('99999999999999999999')
      })
    })

    describe('error handling', () => {
      it('should retry on failure', async () => {
        mockFetch
          .mockRejectedValueOnce(new Error('Network error'))
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ outputs: [], runes_balances: [] }),
          })

        const result = await ordClient.getAddressOutputs('tb1ptest')

        expect(mockFetch).toHaveBeenCalledTimes(3)
        expect(result.outputs).toHaveLength(0)
      })

      it('should throw after max retries', async () => {
        mockFetch.mockRejectedValue(new Error('Network error'))

        await expect(ordClient.getAddressOutputs('tb1ptest'))
          .rejects.toThrow('Network error')

        expect(mockFetch).toHaveBeenCalledTimes(4) // Initial + 3 retries
      })

      it('should throw on HTTP error', async () => {
        mockFetch.mockResolvedValue({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        })

        await expect(ordClient.getAddressOutputs('tb1ptest'))
          .rejects.toThrow('HTTP 500')
      })
    })
  })

  describe('EsploraClient', () => {
    let esploraClient: EsploraClient

    beforeEach(() => {
      esploraClient = new EsploraClient('https://esplora-test.example.com')
    })

    describe('getAddressUtxos', () => {
      it('should parse UTXO list correctly', async () => {
        const mockResponse = [
          {
            txid: 'abc123',
            vout: 0,
            value: 50000,
            status: {
              confirmed: true,
              block_height: 100,
              block_time: 1234567890,
            },
          },
          {
            txid: 'def456',
            vout: 1,
            value: 25000,
            status: {
              confirmed: false,
            },
          },
        ]

        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        })

        const result = await esploraClient.getAddressUtxos('tb1qtest')

        expect(result).toHaveLength(2)
        expect(result[0].txid).toBe('abc123')
        expect(result[0].value).toBe(50000)
        expect(result[0].status.confirmed).toBe(true)
        expect(result[1].status.confirmed).toBe(false)
      })

      it('should handle empty UTXO list', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve([]),
        })

        const result = await esploraClient.getAddressUtxos('tb1qempty')

        expect(result).toHaveLength(0)
      })
    })

    describe('getTransaction', () => {
      it('should parse transaction correctly', async () => {
        const mockResponse = {
          txid: '8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df',
          version: 2,
          locktime: 0,
          vin: [
            {
              txid: 'prev_txid',
              vout: 0,
              is_coinbase: false,
              sequence: 4294967295,
            },
          ],
          vout: [
            {
              scriptpubkey: '512001ae3159d4a02da7528c8cc3af0f0f98fd03e7e782d8d33d89442d296523ad8f',
              scriptpubkey_type: 'v1_p2tr',
              scriptpubkey_address: 'tb1pqxhrzkw55qk6w55v3np67rc0nr7s8el8stvdx0vfgskjjefr4k8slz485f',
              value: 10000,
            },
          ],
          size: 405,
          weight: 1092,
          fee: 1000,
          status: {
            confirmed: true,
            block_height: 2647704,
            block_hash: '000001fd106188c5226033ad3fd73dd6368c35e448f877202ad8cd3d67204cc2',
            block_time: 1764091931,
          },
        }

        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        })

        const result = await esploraClient.getTransaction(
          '8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df'
        )

        expect(result.txid).toBe('8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df')
        expect(result.status.confirmed).toBe(true)
        expect(result.status.block_height).toBe(2647704)
        expect(result.vout).toHaveLength(1)
        expect(result.vout[0].value).toBe(10000)
      })

      it('should handle unconfirmed transaction', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({
            txid: 'unconfirmed_tx',
            version: 2,
            locktime: 0,
            vin: [],
            vout: [],
            size: 200,
            weight: 800,
            status: {
              confirmed: false,
            },
          }),
        })

        const result = await esploraClient.getTransaction('unconfirmed_tx')

        expect(result.status.confirmed).toBe(false)
        expect(result.status.block_height).toBeUndefined()
      })
    })

    describe('getOutspend', () => {
      it('should detect spent output', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({
            spent: true,
            txid: 'spending_txid',
            vin: 0,
            status: {
              confirmed: true,
              block_height: 12345,
            },
          }),
        })

        const result = await esploraClient.getOutspend('abc123', 0)

        expect(result.spent).toBe(true)
        expect(result.txid).toBe('spending_txid')
      })

      it('should detect unspent output', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({
            spent: false,
          }),
        })

        const result = await esploraClient.getOutspend('abc123', 0)

        expect(result.spent).toBe(false)
        expect(result.txid).toBeUndefined()
      })
    })

    describe('getBlockHeight', () => {
      it('should return current block height', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          text: () => Promise.resolve('2647800'),
        })

        const result = await esploraClient.getBlockHeight()

        expect(result).toBe(2647800)
      })
    })

    describe('broadcastTransaction', () => {
      it('should return txid on successful broadcast', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          text: () => Promise.resolve('broadcasted_txid_123'),
        })

        const result = await esploraClient.broadcastTransaction('raw_tx_hex')

        expect(result).toBe('broadcasted_txid_123')
      })

      it('should throw on broadcast failure', async () => {
        mockFetch.mockResolvedValue({
          ok: false,
          status: 400,
          text: () => Promise.resolve('bad-txns-inputs-missingorspent'),
        })

        await expect(esploraClient.broadcastTransaction('invalid_tx'))
          .rejects.toThrow('bad-txns-inputs-missingorspent')
      })
    })
  })
})

describe('getTransactionHex', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let esploraClient: EsploraClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    esploraClient = new EsploraClient('https://esplora-test.example.com')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should return transaction hex on success', async () => {
    const txHex = '0200000001...'
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(txHex),
    })

    const result = await esploraClient.getTransactionHex('abc123')
    expect(result).toBe(txHex)
  })

  it('should throw on HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    })

    await expect(esploraClient.getTransactionHex('nonexistent'))
      .rejects.toThrow('Failed to fetch tx hex: 404 Not Found')
  })
})

describe('getBlockHeight error handling', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let esploraClient: EsploraClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    esploraClient = new EsploraClient('https://esplora-test.example.com')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should throw on HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    })

    await expect(esploraClient.getBlockHeight())
      .rejects.toThrow('Failed to fetch block height: 503')
  })
})

describe('getFeeEstimates', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let esploraClient: EsploraClient

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    esploraClient = new EsploraClient('https://esplora-test.example.com')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should return fee estimates', async () => {
    const feeEstimates = {
      '1': 25.5,
      '3': 15.2,
      '6': 10.0,
    }

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(feeEstimates),
    })

    const result = await esploraClient.getFeeEstimates()
    expect(result['1']).toBe(25.5)
    expect(result['3']).toBe(15.2)
    expect(result['6']).toBe(10.0)
  })
})

describe('Singleton clients', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the module to clear singleton instances
    vi.resetModules()
  })

  it('should return singleton OrdClient instance', async () => {
    const { getOrdClient } = await import('../../../src/runes/api-client.js')

    const client1 = getOrdClient()
    const client2 = getOrdClient()

    expect(client1).toBe(client2) // Same instance
    expect(client1).toBeInstanceOf(Object)
  })

  it('should return singleton EsploraClient instance', async () => {
    const { getEsploraClient } = await import('../../../src/runes/api-client.js')

    const client1 = getEsploraClient()
    const client2 = getEsploraClient()

    expect(client1).toBe(client2) // Same instance
    expect(client1).toBeInstanceOf(Object)
  })
})

describe('Real-world response parsing', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should correctly parse the actual Ord output from the failing transaction', async () => {
    // This is the EXACT response from the failing transaction investigation
    const realOrdResponse = {
      address: 'tb1p7p74tg67aaw94vz2kewzeyuq80x0a65wpgegnat98f5hkcnpfjsqntv2em',
      indexed: true,
      inscriptions: [],
      runes: {
        'DUCAT•UNIT•RUNE': {
          amount: 2000, // The ACTUAL amount - 2000, not 500!
          divisibility: 2,
          symbol: '$',
        },
      },
      sat_ranges: [[2093911600862924, 2093911600872924]],
      script_pubkey: '5120f07d55a35eef5c5ab04ab65c2c93803bccfeea8e0a3289f5653a697b62614ca0',
      spent: false,
      transaction: '8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df',
      value: 10000,
    }

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(realOrdResponse),
    })

    const ordClient = new OrdClient('https://ord-test.example.com')
    const result = await ordClient.getOutput(
      '8f627a40614b7a7d38bad3c12dd7d0581aead57f917387ae210dd925ec1104df',
      1
    )

    // The mint should see amount=2000, NOT 500
    expect(result.runes!['DUCAT•UNIT•RUNE'].amount).toBe(2000)
    expect(result.value).toBe(10000)

    // This is exactly what the RunesBackend should be checking
    const receivedAmount = BigInt(result.runes!['DUCAT•UNIT•RUNE'].amount)
    const expectedAmount = 500n // What the quote was for

    // This should be the mismatch detected!
    expect(receivedAmount).not.toBe(expectedAmount)
    expect(receivedAmount).toBe(2000n)
  })
})
