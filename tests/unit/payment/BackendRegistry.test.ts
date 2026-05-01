import { describe, it, expect, beforeEach } from 'vitest'
import { BackendRegistry } from '../../../src/core/payment/BackendRegistry.js'
import { IPaymentBackend, DepositStatus, WithdrawalResult } from '../../../src/core/payment/types.js'

// Mock backend for testing
class MockBackend implements IPaymentBackend {
  constructor(
    public readonly unit: string,
    public readonly method?: string
  ) {}

  async createDepositAddress(_quoteId: string, _amount: bigint): Promise<string> {
    return `mock_address_${this.unit}`
  }

  async checkDeposit(_quoteId: string, _address: string): Promise<DepositStatus> {
    return { confirmed: true, confirmations: 6, amount: 1000n, txid: 'mock_txid', vout: 0 }
  }

  async verifySpecificDeposit(_quoteId: string, _txid: string, _vout: number): Promise<DepositStatus> {
    return { confirmed: true, confirmations: 6, amount: 1000n, txid: 'mock_txid', vout: 0 }
  }

  async estimateFee(_destination: string, _amount: bigint): Promise<number> {
    return 100
  }

  async withdraw(_destination: string, _amount: bigint): Promise<WithdrawalResult> {
    return { txid: 'mock_txid', fee_paid: 100 }
  }

  async getBalance(): Promise<bigint> {
    return 10000n
  }
}

describe('BackendRegistry', () => {
  let registry: BackendRegistry

  beforeEach(() => {
    registry = new BackendRegistry()
  })

  describe('register', () => {
    it('should register a backend', () => {
      const backend = new MockBackend('btc')
      registry.register(backend)

      expect(registry.has('btc')).toBe(true)
    })

    it('should register multiple backends', () => {
      const btcBackend = new MockBackend('btc')
      const satBackend = new MockBackend('sat')

      registry.register(btcBackend)
      registry.register(satBackend)

      expect(registry.has('btc')).toBe(true)
      expect(registry.has('sat')).toBe(true)
    })

    it('should overwrite existing backend with same unit', () => {
      const backend1 = new MockBackend('btc')
      const backend2 = new MockBackend('btc')

      registry.register(backend1)
      registry.register(backend2)

      expect(registry.get('btc')).toBe(backend2)
    })

    it('should register method/unit pairs independently', () => {
      const onchainBackend = new MockBackend('sat', 'onchain')
      const bolt11Backend = new MockBackend('sat', 'bolt11')

      registry.register(onchainBackend)
      registry.register(bolt11Backend)

      expect(registry.getByMethod('onchain', 'sat')).toBe(onchainBackend)
      expect(registry.getByMethod('bolt11', 'sat')).toBe(bolt11Backend)
      expect(registry.get('sat')).toBe(bolt11Backend)
    })

    it('should register unit aliases and method aliases', () => {
      const runesBackend = new MockBackend('unit', 'onchain')

      registry.register(runesBackend, [], ['unit', 'runes'])

      expect(registry.getByMethod('onchain', 'unit')).toBe(runesBackend)
      expect(registry.getByMethod('unit', 'unit')).toBe(runesBackend)
      expect(registry.getByMethod('runes', 'unit')).toBe(runesBackend)
    })

    it('should register BTC as onchain for both btc and sat units', () => {
      const btcBackend = new MockBackend('btc', 'onchain')

      registry.register(btcBackend, ['sat'])

      expect(registry.getByMethod('onchain', 'btc')).toBe(btcBackend)
      expect(registry.getByMethod('onchain', 'sat')).toBe(btcBackend)
    })
  })

  describe('get', () => {
    it('should return registered backend', () => {
      const backend = new MockBackend('btc')
      registry.register(backend)

      expect(registry.get('btc')).toBe(backend)
    })

    it('should throw for unregistered unit', () => {
      expect(() => registry.get('unknown')).toThrow('Unsupported unit: unknown')
    })

    it('should throw for unregistered method/unit pairs', () => {
      registry.register(new MockBackend('unit', 'onchain'))

      expect(() => registry.getByMethod('bolt11', 'unit')).toThrow(
        'Unsupported method/unit: bolt11/unit'
      )
    })
  })

  describe('has', () => {
    it('should return true for registered unit', () => {
      registry.register(new MockBackend('btc'))
      expect(registry.has('btc')).toBe(true)
    })

    it('should return false for unregistered unit', () => {
      expect(registry.has('unknown')).toBe(false)
    })

    it('should check method/unit support', () => {
      registry.register(new MockBackend('unit', 'onchain'), [], ['unit'])

      expect(registry.hasMethod('onchain', 'unit')).toBe(true)
      expect(registry.hasMethod('unit', 'unit')).toBe(true)
      expect(registry.hasMethod('bolt11', 'unit')).toBe(false)
    })
  })

  describe('getAll', () => {
    it('should return empty array when no backends registered', () => {
      expect(registry.getAll()).toEqual([])
    })

    it('should return all registered backends', () => {
      const btcBackend = new MockBackend('btc')
      const satBackend = new MockBackend('sat')

      registry.register(btcBackend)
      registry.register(satBackend)

      const backends = registry.getAll()
      expect(backends).toHaveLength(2)
      expect(backends).toContain(btcBackend)
      expect(backends).toContain(satBackend)
    })
  })

  describe('getSupportedUnits', () => {
    it('should return empty array when no backends registered', () => {
      expect(registry.getSupportedUnits()).toEqual([])
    })

    it('should return all registered units', () => {
      registry.register(new MockBackend('btc'))
      registry.register(new MockBackend('sat'))

      const units = registry.getSupportedUnits()
      expect(units).toHaveLength(2)
      expect(units).toContain('btc')
      expect(units).toContain('sat')
    })
  })
})
