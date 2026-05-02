import { getP2PKSigFlag, isP2PKSpendAuthorised, type Proof as CashuProof } from '@cashu/cashu-ts'
import { BlindedMessage, Proof } from '../../types/cashu.js'
import { logger } from '../../utils/logger.js'

const cashuLogger = {
  debug(message: string, context?: Record<string, unknown>) {
    logger.debug(context ?? {}, message)
  },
  info(message: string, context?: Record<string, unknown>) {
    logger.info(context ?? {}, message)
  },
  warn(message: string, context?: Record<string, unknown>) {
    logger.warn(context ?? {}, message)
  },
  error(message: string, context?: Record<string, unknown>) {
    logger.error(context ?? {}, message)
  },
  trace(message: string, context?: Record<string, unknown>) {
    logger.trace(context ?? {}, message)
  },
  log(level: string, message: string, context?: Record<string, unknown>) {
    logger[level as 'debug']?.(context ?? {}, message)
  },
}

export class P2PKService {
  isP2PKProof(proof: Proof): boolean {
    const secret = this.parseSecret(proof)
    return Array.isArray(secret) && secret[0] === 'P2PK'
  }

  verifyP2PKProof(proof: Proof): boolean {
    if (!this.isP2PKProof(proof)) {
      return true
    }

    return this.verifyWithMessage(proof)
  }

  verifyP2PKProofs(
    proofs: Proof[],
    outputs: BlindedMessage[] = [],
    quoteId?: string
  ): boolean {
    const p2pkProofs = proofs.filter((proof) => this.isP2PKProof(proof))
    if (p2pkProofs.length === 0) {
      return true
    }

    const sigInputs = p2pkProofs.filter((proof) => this.sigFlag(proof) !== 'SIG_ALL')
    if (!sigInputs.every((proof) => this.verifyWithMessage(proof))) {
      return false
    }

    const sigAll = p2pkProofs.filter((proof) => this.sigFlag(proof) === 'SIG_ALL')
    if (sigAll.length === 0) {
      return true
    }

    if (outputs.length === 0 || !this.hasConsistentSigAllSecrets(sigAll)) {
      return false
    }

    const messages = this.sigAllMessages(proofs, outputs, quoteId)
    return messages.some((message) => this.verifyWithMessage(sigAll[0], message))
  }

  verifyP2PKProofsWithSigAll(
    proofs: Proof[],
    outputs: BlindedMessage[] = [],
    quoteId?: string
  ): boolean {
    return this.verifyP2PKProofs(proofs, outputs, quoteId)
  }

  private verifyWithMessage(proof: Proof, message?: string): boolean {
    try {
      return isP2PKSpendAuthorised(proof as unknown as CashuProof, cashuLogger, message)
    } catch (error) {
      logger.warn(
        {
          err: error,
          proofId: proof.id,
          sigflag: this.sigFlag(proof),
        },
        'P2PK verification failed'
      )
      return false
    }
  }

  private sigFlag(proof: Proof): 'SIG_INPUTS' | 'SIG_ALL' {
    try {
      return getP2PKSigFlag(proof.secret) as 'SIG_INPUTS' | 'SIG_ALL'
    } catch {
      return 'SIG_INPUTS'
    }
  }

  private sigAllMessages(
    proofs: Proof[],
    outputs: BlindedMessage[],
    quoteId?: string
  ): string[] {
    const legacy: string[] = []
    for (const proof of proofs) {
      legacy.push(proof.secret)
    }
    for (const output of outputs) {
      legacy.push(output.B_)
    }
    if (quoteId) {
      legacy.push(quoteId)
    }

    const current: string[] = []
    for (const proof of proofs) {
      current.push(proof.secret, proof.C)
    }
    for (const output of outputs) {
      current.push(String(output.amount), output.B_)
    }
    if (quoteId) {
      current.push(quoteId)
    }

    return [legacy.join(''), current.join('')]
  }

  private hasConsistentSigAllSecrets(proofs: Proof[]): boolean {
    if (proofs.length <= 1) {
      return true
    }

    const first = this.sigAllSecretFingerprint(proofs[0])
    return proofs.every((proof) => this.sigAllSecretFingerprint(proof) === first)
  }

  private sigAllSecretFingerprint(proof: Proof): string {
    const secret = this.parseSecret(proof)
    if (!Array.isArray(secret) || secret[0] !== 'P2PK') {
      return ''
    }

    const payload = secret[1] as { data?: unknown; tags?: unknown }
    return JSON.stringify({
      kind: secret[0],
      data: payload.data,
      tags: payload.tags ?? [],
    })
  }

  private parseSecret(proof: Proof): unknown {
    try {
      return JSON.parse(proof.secret)
    } catch {
      return null
    }
  }
}
