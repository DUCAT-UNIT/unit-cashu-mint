import { Proof } from '../../types/cashu.js'
import { verifyMultipleSignatures } from '../crypto/SchnorrSignature.js'
import { logger } from '../../utils/logger.js'

/**
 * P2PK (Pay-to-Pubkey) Service - NUT-11 Implementation
 * Verifies spending conditions for proofs locked to public keys
 */

interface P2PKSecret {
  nonce: string
  data: string // Public key in hex
  tags?: Array<[string, ...string[]]>
}

interface P2PKWitness {
  signatures: string[]
}

export class P2PKService {
  /**
   * Check if a proof has P2PK spending conditions
   */
  isP2PKProof(proof: Proof): boolean {
    try {
      const secret = JSON.parse(proof.secret)
      return Array.isArray(secret) && secret[0] === 'P2PK'
    } catch {
      return false
    }
  }

  /**
   * Extract P2PK secret data from proof
   */
  private parseP2PKSecret(proof: Proof): P2PKSecret | null {
    try {
      const secret = JSON.parse(proof.secret)
      if (!Array.isArray(secret) || secret[0] !== 'P2PK') {
        return null
      }

      const data = secret[1]
      if (!data || typeof data !== 'object') {
        return null
      }

      return {
        nonce: data.nonce,
        data: data.data, // Public key
        tags: data.tags || []
      }
    } catch (err) {
      // Not a P2PK proof - this is expected for regular proofs
      return null
    }
  }

  /**
   * Parse P2PK witness from proof
   */
  private parseP2PKWitness(proof: Proof): P2PKWitness | null {
    if (!proof.witness) {
      return null
    }

    try {
      const witnessStr = typeof proof.witness === 'string' ? proof.witness : JSON.stringify(proof.witness)
      const witness = JSON.parse(witnessStr)
      if (!witness.signatures || !Array.isArray(witness.signatures)) {
        return null
      }

      return {
        signatures: witness.signatures
      }
    } catch (err) {
      logger.error({ err, witness: proof.witness }, 'Failed to parse P2PK witness')
      return null
    }
  }

  /**
   * Get tag value from P2PK secret tags
   */
  private getTag(secret: P2PKSecret, tagName: string): string[] | null {
    if (!secret.tags) {
      return null
    }

    const tag = secret.tags.find(t => t[0] === tagName)
    if (!tag) {
      return null
    }

    return tag.slice(1) // Remove tag name, return values
  }

  /**
   * Verify P2PK spending condition for a single proof (SIG_INPUTS mode)
   * @param proof - Proof with P2PK secret and witness
   * @returns true if witness is valid
   */
  verifyP2PKProof(proof: Proof): boolean {
    const secret = this.parseP2PKSecret(proof)
    if (!secret) {
      logger.warn({ proofSecret: proof.secret }, 'Invalid P2PK secret format')
      return false
    }

    const witness = this.parseP2PKWitness(proof)
    if (!witness || witness.signatures.length === 0) {
      logger.warn({ proofId: proof.id, hasWitness: !!proof.witness }, 'Missing P2PK witness')
      return false
    }

    logger.info({
      proofId: proof.id,
      expectedPubkey: secret.data.substring(0, 16) + '...',
      signaturesProvided: witness.signatures.length,
      signaturePreview: witness.signatures[0]?.substring(0, 16) + '...'
    }, 'Verifying P2PK proof')

    // Check locktime
    const locktime = this.getTag(secret, 'locktime')
    const now = Math.floor(Date.now() / 1000)

    if (locktime && locktime.length > 0) {
      const locktimeValue = parseInt(locktime[0])

      if (now < locktimeValue) {
        // Before locktime - use normal pubkeys and n_sigs
        return this.verifyBeforeLocktime(proof, secret, witness)
      } else {
        // After locktime - use refund pubkeys
        return this.verifyAfterLocktime(proof, secret, witness)
      }
    }

    // No locktime - verify normally
    return this.verifyBeforeLocktime(proof, secret, witness)
  }

  /**
   * Normalize public key format - convert comma-separated to hex if needed
   */
  private normalizePubkey(pubkey: string): string {
    // If it contains commas, it's in array format like "117,7,194,195..."
    if (pubkey.includes(',')) {
      const bytes = pubkey.split(',').map(n => parseInt(n.trim()))
      return Buffer.from(bytes).toString('hex')
    }
    return pubkey
  }

  /**
   * Verify proof before locktime (or no locktime)
   */
  private verifyBeforeLocktime(
    proof: Proof,
    secret: P2PKSecret,
    witness: P2PKWitness
  ): boolean {
    // Get authorized public keys and normalize format
    const pubkeys = [this.normalizePubkey(secret.data)] // Primary pubkey from data field
    const additionalPubkeys = this.getTag(secret, 'pubkeys')
    if (additionalPubkeys) {
      pubkeys.push(...additionalPubkeys.map(pk => this.normalizePubkey(pk)))
    }

    // Get required signature count
    const nSigsTag = this.getTag(secret, 'n_sigs')
    const requiredSigs = nSigsTag && nSigsTag.length > 0 ? parseInt(nSigsTag[0]) : 1

    // Message to sign is the serialized secret
    const message = proof.secret

    // Verify signatures
    const isValid = verifyMultipleSignatures(
      message,
      witness.signatures,
      pubkeys,
      requiredSigs
    )

    if (!isValid) {
      logger.warn({
        proofId: proof.id,
        requiredSigs,
        providedSigs: witness.signatures.length,
        pubkeys: pubkeys.map(p => p.substring(0, 16) + '...'),
        signatures: witness.signatures.map(s => s.substring(0, 16) + '...'),
        messagePreview: message.substring(0, 100) + '...'
      }, 'P2PK signature verification failed')
    } else {
      logger.info({ proofId: proof.id }, 'P2PK signature verified successfully')
    }

    return isValid
  }

  /**
   * Verify proof after locktime
   */
  private verifyAfterLocktime(
    proof: Proof,
    secret: P2PKSecret,
    witness: P2PKWitness
  ): boolean {
    // Get refund public keys and normalize format
    const refundPubkeysRaw = this.getTag(secret, 'refund')
    if (!refundPubkeysRaw || refundPubkeysRaw.length === 0) {
      // No refund keys specified, anyone can spend after locktime
      logger.info({ proofId: proof.id }, 'No refund keys, allowing spend after locktime')
      return true
    }
    const refundPubkeys = refundPubkeysRaw.map(pk => this.normalizePubkey(pk))

    // Get required refund signature count
    const nSigsRefundTag = this.getTag(secret, 'n_sigs_refund')
    const requiredSigs = nSigsRefundTag && nSigsRefundTag.length > 0
      ? parseInt(nSigsRefundTag[0])
      : refundPubkeys.length // Require all refund signatures by default

    // Message to sign is the serialized secret
    const message = proof.secret

    // Verify refund signatures
    const isValid = verifyMultipleSignatures(
      message,
      witness.signatures,
      refundPubkeys,
      requiredSigs
    )

    if (!isValid) {
      logger.warn({
        proofId: proof.id,
        requiredSigs,
        providedSigs: witness.signatures.length
      }, 'P2PK refund signature verification failed')
    }

    return isValid
  }

  /**
   * Verify multiple P2PK proofs with SIG_ALL
   * (All proofs signed together as one message)
   * TODO: Implement SIG_ALL verification
   */
  verifyP2PKProofsWithSigAll(proofs: Proof[]): boolean {
    // For now, reject SIG_ALL (not implemented yet)
    const hasSigAll = proofs.some(p => {
      const secret = this.parseP2PKSecret(p)
      if (!secret) return false
      const sigflag = this.getTag(secret, 'sigflag')
      return sigflag && sigflag[0] === 'SIG_ALL'
    })

    if (hasSigAll) {
      logger.warn('SIG_ALL not yet implemented')
      return false
    }

    return true
  }
}
