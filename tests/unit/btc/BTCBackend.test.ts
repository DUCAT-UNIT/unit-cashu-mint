import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BTCBackend } from '../../../src/btc/BTCBackend.js'
import { BTCConfig } from '../../../src/btc/types.js'

// Mock the EsploraClient
vi.mock('../../../src/runes/api-client.js', () => ({
  EsploraClient: vi.fn().mockImplementation(() => ({
    getAddressUtxos: vi.fn(),
    getBlockHeight: vi.fn(),
    getTransaction: vi.fn(),
    broadcastTransaction: vi.fn(),
  })),
}))

// Mock the logger
vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('BTCBackend', () => {
  let backend: BTCBackend
  let mockConfig: BTCConfig

  beforeEach(() => {
    vi.clearAllMocks()

    mockConfig = {
      mintAddress: 'tb1qtest123',
      mintPubkey: '02' + '00'.repeat(32),
      feeRate: 5,
      network: 'testnet',
      minConfirmations: 1,
    }

    backend = new BTCBackend(mockConfig)
  })

  describe('constructor', () => {
    it('should initialize with correct unit', () => {
      expect(backend.unit).toBe('btc')
    })

    it('should store mint address', () => {
      expect(backend.getMintAddress()).toBe(mockConfig.mintAddress)
    })
  })

  describe('createDepositAddress', () => {
    it('should return the mint address', async () => {
      const address = await backend.createDepositAddress('quote123', 1000n)
      expect(address).toBe(mockConfig.mintAddress)
    })
  })

  describe('estimateFee', () => {
    it('should estimate fee based on transaction size', async () => {
      const fee = await backend.estimateFee('tb1qdest456', 1000n)

      // 1 input, 2 outputs = ~68 + 62 + 10 = 140 vbytes
      // At 5 sats/vbyte = 700 sats (approximately)
      expect(fee).toBeGreaterThan(0)
      expect(fee).toBeLessThan(2000) // Sanity check
    })
  })

  describe('unit property', () => {
    it('should be btc', () => {
      expect(backend.unit).toBe('btc')
    })
  })
})

describe('BTCBackend with mocked Esplora', () => {
  let backend: BTCBackend
  let mockEsploraClient: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockEsploraClient = {
      getAddressUtxos: vi.fn(),
      getBlockHeight: vi.fn(),
      getTransaction: vi.fn(),
      broadcastTransaction: vi.fn(),
    }

    const mockConfig: BTCConfig = {
      mintAddress: 'tb1qtest123',
      mintPubkey: '02' + '00'.repeat(32),
      feeRate: 5,
      network: 'testnet',
      minConfirmations: 1,
    }

    backend = new BTCBackend(mockConfig, mockEsploraClient)
  })

  describe('checkDeposit', () => {
    it('should return confirmed=false when no UTXOs', async () => {
      mockEsploraClient.getAddressUtxos.mockResolvedValue([])

      const status = await backend.checkDeposit('quote123', 'tb1qtest123')

      expect(status.confirmed).toBe(false)
      expect(status.confirmations).toBe(0)
    })

    it('should detect confirmed deposit', async () => {
      mockEsploraClient.getAddressUtxos.mockResolvedValue([
        {
          txid: 'abc123',
          vout: 0,
          value: 10000,
          status: { confirmed: true, block_height: 100 },
        },
      ])
      mockEsploraClient.getBlockHeight.mockResolvedValue(105)

      const status = await backend.checkDeposit('quote123', 'tb1qtest123')

      expect(status.confirmed).toBe(true)
      expect(status.amount).toBe(10000n)
      expect(status.txid).toBe('abc123')
      expect(status.vout).toBe(0)
      expect(status.confirmations).toBe(6)
    })

    it('should return confirmed=false for unconfirmed UTXOs', async () => {
      mockEsploraClient.getAddressUtxos.mockResolvedValue([
        {
          txid: 'abc123',
          vout: 0,
          value: 10000,
          status: { confirmed: false },
        },
      ])
      mockEsploraClient.getBlockHeight.mockResolvedValue(100)

      const status = await backend.checkDeposit('quote123', 'tb1qtest123')

      expect(status.confirmed).toBe(false)
    })
  })

  describe('verifySpecificDeposit', () => {
    it('should verify a specific UTXO', async () => {
      mockEsploraClient.getTransaction.mockResolvedValue({
        txid: 'abc123',
        vout: [{ value: 10000 }, { value: 5000 }],
        status: { confirmed: true, block_height: 100 },
      })
      mockEsploraClient.getBlockHeight.mockResolvedValue(106)

      const status = await backend.verifySpecificDeposit('quote123', 'abc123', 0)

      expect(status.confirmed).toBe(true)
      expect(status.amount).toBe(10000n)
      expect(status.confirmations).toBe(7)
    })

    it('should return confirmed=false for invalid vout', async () => {
      mockEsploraClient.getTransaction.mockResolvedValue({
        txid: 'abc123',
        vout: [{ value: 10000 }],
        status: { confirmed: true, block_height: 100 },
      })
      mockEsploraClient.getBlockHeight.mockResolvedValue(100)

      const status = await backend.verifySpecificDeposit('quote123', 'abc123', 5)

      expect(status.confirmed).toBe(false)
    })
  })

  describe('getBalance', () => {
    it('should sum confirmed UTXO values', async () => {
      mockEsploraClient.getAddressUtxos.mockResolvedValue([
        { txid: 'tx1', vout: 0, value: 10000, status: { confirmed: true, block_height: 100 } },
        { txid: 'tx2', vout: 0, value: 20000, status: { confirmed: true, block_height: 101 } },
        { txid: 'tx3', vout: 0, value: 5000, status: { confirmed: false } }, // Unconfirmed
      ])
      mockEsploraClient.getBlockHeight.mockResolvedValue(105)

      const balance = await backend.getBalance()

      expect(balance).toBe(30000n) // Only confirmed UTXOs
    })

    it('should return 0 when no confirmed UTXOs', async () => {
      mockEsploraClient.getAddressUtxos.mockResolvedValue([
        { txid: 'tx1', vout: 0, value: 10000, status: { confirmed: false } },
      ])
      mockEsploraClient.getBlockHeight.mockResolvedValue(100)

      const balance = await backend.getBalance()

      expect(balance).toBe(0n)
    })
  })
})
