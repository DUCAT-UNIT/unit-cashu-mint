import { MintCrypto } from '../crypto/MintCrypto.js'
import { ProofRepository } from '../../database/repositories/ProofRepository.js'
import { logger } from '../../utils/logger.js'

export interface ProofState {
  Y: string
  state: 'UNSPENT' | 'PENDING' | 'SPENT'
  witness: string | null
}

export class CheckStateService {
  constructor(
    private mintCrypto: MintCrypto,
    private proofRepo: ProofRepository
  ) {}

  /**
   * Check state of proofs by their secrets (NUT-07)
   * This endpoint allows wallets to check if proofs have been spent
   *
   * @param secrets - Array of proof secrets (raw strings)
   * @returns Array of proof states with Y values
   */
  async checkStateBySecrets(secrets: string[]): Promise<{ states: ProofState[] }> {
    logger.info({ secretCount: secrets.length }, 'Checking proof states by secrets')

    // Hash all secrets to Y values (curve points)
    const Y_values = this.mintCrypto.hashSecrets(secrets)

    // Check state in database
    const states = await this.proofRepo.checkState(Y_values)

    logger.info(
      {
        total: states.length,
        unspent: states.filter(s => s.state === 'UNSPENT').length,
        pending: states.filter(s => s.state === 'PENDING').length,
        spent: states.filter(s => s.state === 'SPENT').length
      },
      'Proof states checked'
    )

    return {
      states: states.map(s => ({
        Y: s.Y,
        state: s.state as 'UNSPENT' | 'PENDING' | 'SPENT',
        witness: s.witness
      }))
    }
  }

  /**
   * Check state of proofs by their Y values (NUT-07)
   * This is the standard NUT-07 endpoint that expects hashed curve points
   *
   * @param Ys - Array of Y values (hash_to_curve(secret) as hex)
   * @returns Array of proof states
   */
  async checkStateByYs(Ys: string[]): Promise<{ states: ProofState[] }> {
    logger.info({ YCount: Ys.length }, 'Checking proof states by Y values')

    // Check state in database (Ys are already curve points)
    const states = await this.proofRepo.checkState(Ys)

    logger.info(
      {
        total: states.length,
        unspent: states.filter(s => s.state === 'UNSPENT').length,
        pending: states.filter(s => s.state === 'PENDING').length,
        spent: states.filter(s => s.state === 'SPENT').length
      },
      'Proof states checked'
    )

    return {
      states: states.map(s => ({
        Y: s.Y,
        state: s.state as 'UNSPENT' | 'PENDING' | 'SPENT',
        witness: s.witness
      }))
    }
  }
}
