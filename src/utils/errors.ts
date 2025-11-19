/**
 * Base mint error following NUT-00 error format
 */
export class MintError extends Error {
  constructor(
    message: string,
    public code: number,
    public detail?: string
  ) {
    super(message)
    this.name = 'MintError'
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      detail: this.detail,
    }
  }
}

/**
 * Proof-related errors
 */
export class ProofAlreadySpentError extends MintError {
  constructor(Y: string) {
    super('Proof already spent', 11001, `Y=${Y}`)
  }
}

export class InvalidProofError extends MintError {
  constructor(detail: string) {
    super('Invalid proof', 11002, detail)
  }
}

/**
 * Quote-related errors
 */
export class QuoteNotFoundError extends MintError {
  constructor(quoteId: string) {
    super('Quote not found', 10000, `quote=${quoteId}`)
  }
}

export class QuoteNotPaidError extends MintError {
  constructor(quoteId: string) {
    super('Quote not paid', 10001, `quote=${quoteId}`)
  }
}

export class QuoteExpiredError extends MintError {
  constructor(quoteId: string) {
    super('Quote expired', 10002, `quote=${quoteId}`)
  }
}

export class QuoteAlreadyIssuedError extends MintError {
  constructor(quoteId: string) {
    super('Quote already issued', 10003, `quote=${quoteId}`)
  }
}

/**
 * Amount-related errors
 */
export class InsufficientAmountError extends MintError {
  constructor(required: number, provided: number) {
    super('Insufficient amount', 12000, `required=${required}, provided=${provided}`)
  }
}

export class AmountMismatchError extends MintError {
  constructor(expected: number, actual: number) {
    super('Amount mismatch', 12001, `expected=${expected}, actual=${actual}`)
  }
}

/**
 * Keyset-related errors
 */
export class KeysetNotFoundError extends MintError {
  constructor(keysetId: string) {
    super('Keyset not found', 13000, `id=${keysetId}`)
  }
}

export class KeysetInactiveError extends MintError {
  constructor(keysetId: string) {
    super('Keyset inactive', 13001, `id=${keysetId}`)
  }
}

/**
 * Runes-related errors
 */
export class RunesDepositNotFoundError extends MintError {
  constructor(txid: string) {
    super('Runes deposit not found', 14000, `txid=${txid}`)
  }
}

export class RunesWithdrawalFailedError extends MintError {
  constructor(detail: string) {
    super('Runes withdrawal failed', 14001, detail)
  }
}

export class InsufficientReservesError extends MintError {
  constructor(runeId: string, required: number, available: number) {
    super(
      'Insufficient reserves',
      14002,
      `rune=${runeId}, required=${required}, available=${available}`
    )
  }
}
