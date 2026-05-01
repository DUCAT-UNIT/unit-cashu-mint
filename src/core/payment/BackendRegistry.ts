import { IPaymentBackend } from './types.js'
import { MintError } from '../../utils/errors.js'

/**
 * Registry for payment backends
 * Routes requests to the appropriate backend based on unit
 */
export class BackendRegistry {
  private backends = new Map<string, IPaymentBackend>()
  private methodBackends = new Map<string, IPaymentBackend>()

  /**
   * Register a payment backend
   * @param backend - The backend to register
   * @param aliases - Additional unit aliases that should route to this backend
   * @param methodAliases - Additional payment method aliases for legacy routes
   */
  register(
    backend: IPaymentBackend,
    aliases: string[] = [],
    methodAliases: string[] = []
  ): void {
    this.backends.set(backend.unit, backend)
    const methods = [backend.method ?? backend.unit, ...methodAliases]
    for (const method of methods) {
      this.methodBackends.set(this.methodKey(method, backend.unit), backend)
    }

    for (const alias of aliases) {
      this.backends.set(alias, backend)
      for (const method of methods) {
        this.methodBackends.set(this.methodKey(method, alias), backend)
      }
    }
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

  getByMethod(method: string, unit: string): IPaymentBackend {
    const backend = this.methodBackends.get(this.methodKey(method, unit))
    if (!backend) {
      throw new MintError(
        `Unsupported method/unit: ${method}/${unit}`,
        20000,
        `method=${method}, unit=${unit}`
      )
    }

    return backend
  }

  /**
   * Get all registered backends
   * @returns Array of all backends
   */
  getAll(): IPaymentBackend[] {
    return Array.from(new Set(this.backends.values()))
  }

  /**
   * Check if a unit is supported
   * @param unit - The unit to check
   * @returns true if supported
   */
  has(unit: string): boolean {
    return this.backends.has(unit)
  }

  hasMethod(method: string, unit: string): boolean {
    return this.methodBackends.has(this.methodKey(method, unit))
  }

  /**
   * Get all supported units
   * @returns Array of supported unit strings
   */
  getSupportedUnits(): string[] {
    return Array.from(this.backends.keys())
  }

  private methodKey(method: string | undefined, unit: string): string {
    return `${method ?? unit}:${unit}`
  }
}
