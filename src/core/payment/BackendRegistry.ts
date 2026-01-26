import { IPaymentBackend } from './types.js'
import { MintError } from '../../utils/errors.js'

/**
 * Registry for payment backends
 * Routes requests to the appropriate backend based on unit
 */
export class BackendRegistry {
  private backends = new Map<string, IPaymentBackend>()

  /**
   * Register a payment backend
   * @param backend - The backend to register
   */
  register(backend: IPaymentBackend): void {
    this.backends.set(backend.unit, backend)
  }

  /**
   * Get a payment backend by unit
   * @param unit - The unit to get backend for
   * @returns The payment backend
   * @throws MintError if unit is not supported
   */
  get(unit: string): IPaymentBackend {
    const backend = this.backends.get(unit)
    if (!backend) {
      throw new MintError(`Unsupported unit: ${unit}`, 20000, `unit=${unit}`)
    }
    return backend
  }

  /**
   * Get all registered backends
   * @returns Array of all backends
   */
  getAll(): IPaymentBackend[] {
    return Array.from(this.backends.values())
  }

  /**
   * Check if a unit is supported
   * @param unit - The unit to check
   * @returns true if supported
   */
  has(unit: string): boolean {
    return this.backends.has(unit)
  }

  /**
   * Get all supported units
   * @returns Array of supported unit strings
   */
  getSupportedUnits(): string[] {
    return Array.from(this.backends.keys())
  }
}
