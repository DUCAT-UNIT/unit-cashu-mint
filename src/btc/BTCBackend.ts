import { createHash } from 'crypto'
import * as bitcoin from 'bitcoinjs-lib'
import { BIP32Factory } from 'bip32'
import * as ecc from '@bitcoinerlab/secp256k1'
import { EsploraClient } from '../runes/api-client.js'
import { BTCTxBuilder } from './tx-builder.js'
import { BTCConfig, BTCUtxo } from './types.js'
import { IPaymentBackend, DepositStatus, WithdrawalResult } from '../core/payment/types.js'
import { logger } from '../utils/logger.js'
import { env } from '../config/env.js'
import { query } from '../database/db.js'

const bip32 = BIP32Factory(ecc)
bitcoin.initEccLib(ecc)

/**
 * Bitcoin (BTC) payment backend
 * Handles BTC deposits and withdrawals for the mint
 */
export class BTCBackend implements IPaymentBackend {
  readonly method = 'onchain'
  readonly unit = 'btc'

  private esploraClient: EsploraClient
  private txBuilder: BTCTxBuilder
  private config: BTCConfig

  constructor(config: BTCConfig, esploraClient?: EsploraClient) {
    this.config = config
    this.esploraClient = esploraClient || new EsploraClient()
    this.txBuilder = new BTCTxBuilder()

    logger.info(
      {
        mintAddress: this.config.mintAddress,
        network: this.config.network,
        feeRate: this.config.feeRate,
      },
      'BTCBackend initialized'
    )
  }

  /**
   * Create a deposit address for a mint quote
   * For now, we use the mint's main address
   * Could derive unique addresses per quote for better tracking
   */
  async createDepositAddress(
    quoteId: string,
    amount: bigint
  ): Promise<string> {
    logger.info({ quoteId, amount: amount.toString() }, 'Creating BTC deposit address')

    return this.deriveDepositAddress(quoteId).address
  }

  /**
   * Check if a BTC deposit has been received
   * For BTC, we look for UTXOs that match the expected amount
   * This handles the case where multiple quotes share the same deposit address
   */
  async checkDeposit(
    quoteId: string,
    address: string,
    _includeTracked: boolean = false,
    expectedAmount?: bigint
  ): Promise<DepositStatus> {
    try {
      logger.info({ quoteId, address, expectedAmount: expectedAmount?.toString() }, 'Checking BTC deposit status')

      // Get UTXOs at the deposit address
      const utxos = await this.esploraClient.getAddressUtxos(address)

      if (utxos.length === 0) {
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      // Get current block height for confirmation calculation
      const blockHeight = await this.esploraClient.getBlockHeight()

      // If expectedAmount is provided, look for a UTXO matching that exact amount
      // This handles the shared-address case where multiple quotes use the same address
      if (expectedAmount !== undefined) {
        for (const utxo of utxos) {
          const confirmations = utxo.status.confirmed && utxo.status.block_height
            ? blockHeight - utxo.status.block_height + 1
            : 0

          if (BigInt(utxo.value) === expectedAmount && confirmations >= this.config.minConfirmations) {
            logger.info(
              {
                quoteId,
                amount: utxo.value.toString(),
                txid: utxo.txid,
                vout: utxo.vout,
                confirmations,
              },
              'BTC deposit detected (exact amount match)'
            )

            return {
              confirmed: true,
              amount: BigInt(utxo.value),
              txid: utxo.txid,
              vout: utxo.vout,
              confirmations,
            }
          }
        }

        // No exact match found - check for pending
        for (const utxo of utxos) {
          if (BigInt(utxo.value) === expectedAmount && !utxo.status.confirmed) {
            logger.info(
              { quoteId, amount: utxo.value.toString(), txid: utxo.txid },
              'BTC deposit pending confirmation (exact amount match)'
            )
            return {
              confirmed: false,
              confirmations: 0,
            }
          }
        }

        // No UTXO matches the expected amount
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      // Fallback: sum all confirmed UTXOs (original behavior for backwards compatibility)
      let totalConfirmed = 0n
      let bestUtxo: { txid: string; vout: number; confirmations: number } | null = null

      for (const utxo of utxos) {
        const confirmations = utxo.status.confirmed && utxo.status.block_height
          ? blockHeight - utxo.status.block_height + 1
          : 0

        if (confirmations >= this.config.minConfirmations) {
          totalConfirmed += BigInt(utxo.value)

          // Track the first confirmed UTXO for reference
          if (!bestUtxo || confirmations > bestUtxo.confirmations) {
            bestUtxo = {
              txid: utxo.txid,
              vout: utxo.vout,
              confirmations,
            }
          }
        }
      }

      if (totalConfirmed > 0n && bestUtxo) {
        logger.info(
          {
            quoteId,
            amount: totalConfirmed.toString(),
            txid: bestUtxo.txid,
            vout: bestUtxo.vout,
            confirmations: bestUtxo.confirmations,
          },
          'BTC deposit detected (sum of all UTXOs)'
        )

        return {
          confirmed: true,
          amount: totalConfirmed,
          txid: bestUtxo.txid,
          vout: bestUtxo.vout,
          confirmations: bestUtxo.confirmations,
        }
      }

      // Check if there are unconfirmed deposits
      const pendingTotal = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n)
      if (pendingTotal > 0n) {
        logger.info(
          { quoteId, pendingAmount: pendingTotal.toString() },
          'BTC deposit pending confirmation'
        )
      }

      return {
        confirmed: false,
        confirmations: 0,
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          quoteId,
          address,
        },
        'Error checking BTC deposit'
      )
      throw error
    }
  }

  /**
   * Verify a specific BTC deposit by txid/vout
   */
  async verifySpecificDeposit(
    quoteId: string,
    txid: string,
    vout: number
  ): Promise<DepositStatus> {
    try {
      logger.info({ quoteId, txid, vout }, 'Verifying specific BTC deposit')

      // Get transaction info
      const tx = await this.esploraClient.getTransaction(txid)
      const blockHeight = await this.esploraClient.getBlockHeight()

      const confirmations = tx.status.confirmed && tx.status.block_height
        ? blockHeight - tx.status.block_height + 1
        : 0

      // Get the output value
      if (vout >= tx.vout.length) {
        logger.warn({ quoteId, txid, vout }, 'Invalid vout index')
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      const output = tx.vout[vout]
      const amount = BigInt(output.value)

      logger.info(
        { quoteId, txid, vout, amount: amount.toString(), confirmations },
        'Specific BTC deposit verified'
      )

      return {
        confirmed: confirmations >= this.config.minConfirmations,
        amount,
        txid,
        vout,
        confirmations,
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          quoteId,
          txid,
          vout,
        },
        'Error verifying specific BTC deposit'
      )
      throw error
    }
  }

  /**
   * Estimate fee for a BTC withdrawal
   */
  async estimateFee(
    _destination: string,
    _amount: bigint
  ): Promise<number> {
    // Estimate for 1 input, 2 outputs (recipient + change)
    const estimatedSize = this.txBuilder.estimateTxSize(1, 2)
    return estimatedSize * this.config.feeRate
  }

  /**
   * Withdraw BTC to a destination address
   */
  async withdraw(
    destination: string,
    amount: bigint
  ): Promise<WithdrawalResult> {
    try {
      logger.info(
        { destination, amount: amount.toString() },
        'Initiating BTC withdrawal'
      )

      // Get UTXOs from mint address
      const esploraUtxos = await this.esploraClient.getAddressUtxos(this.config.mintAddress)
      const blockHeight = await this.esploraClient.getBlockHeight()

      // Filter for confirmed UTXOs only
      const confirmedUtxos: BTCUtxo[] = esploraUtxos
        .filter(u => u.status.confirmed)
        .map(u => ({
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          address: this.config.mintAddress,
          confirmations: u.status.block_height
            ? blockHeight - u.status.block_height + 1
            : 0,
          accountIndex: 0,
        }))
      confirmedUtxos.push(...await this.getConfirmedQuoteUtxos(blockHeight))

      if (confirmedUtxos.length === 0) {
        throw new Error('No confirmed UTXOs available for withdrawal')
      }

      // Build transaction
      const { psbt, fee, selectedUtxos } = this.txBuilder.buildTransaction(
        confirmedUtxos,
        destination,
        amount,
        this.config.mintAddress, // change goes back to mint
        this.config.feeRate
      )

      // Sign and extract
      const { signedTxHex, txid } = this.txBuilder.signAndExtract(psbt, selectedUtxos)

      // Broadcast transaction
      const broadcastedTxid = await this.esploraClient.broadcastTransaction(signedTxHex)

      // Verify txid matches
      if (broadcastedTxid.trim() !== txid) {
        logger.error(
          { expected: txid, received: broadcastedTxid },
          'TXID mismatch after broadcast'
        )
        throw new Error('Transaction broadcast verification failed')
      }

      logger.info(
        {
          txid,
          amount: amount.toString(),
          destination,
          fee,
        },
        'BTC withdrawal completed successfully'
      )

      return { txid, fee_paid: fee }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          destination,
          amount: amount.toString(),
        },
        'Error during BTC withdrawal'
      )
      throw error
    }
  }

  /**
   * Get the mint's current BTC balance
   */
  async getBalance(): Promise<bigint> {
    try {
      const utxos = await this.esploraClient.getAddressUtxos(this.config.mintAddress)

      // Sum confirmed UTXO values
      const blockHeight = await this.esploraClient.getBlockHeight()
      let balance = 0n

      for (const utxo of utxos) {
        const confirmations = utxo.status.confirmed && utxo.status.block_height
          ? blockHeight - utxo.status.block_height + 1
          : 0

        if (confirmations >= this.config.minConfirmations) {
          balance += BigInt(utxo.value)
        }
      }

      for (const utxo of await this.getConfirmedQuoteUtxos(blockHeight)) {
        balance += BigInt(utxo.value)
      }

      return balance
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Error getting BTC balance'
      )
      throw error
    }
  }

  /**
   * Get the configured mint address
   */
  getMintAddress(): string {
    return this.config.mintAddress
  }

  private deriveDepositAddress(quoteId: string): { address: string; accountIndex: number } {
    const accountIndex = this.quoteAccountIndex(quoteId)
    const seed = Buffer.from(env.MINT_SEED, 'hex')
    const root = bip32.fromSeed(seed, this.txBuilder.getNetwork())
    const child = root.derivePath(`m/84'/1'/0'/0/${accountIndex}`)
    const payment = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(child.publicKey),
      network: this.txBuilder.getNetwork(),
    })

    if (!payment.address) {
      throw new Error('Failed to derive BTC deposit address')
    }

    return { address: payment.address, accountIndex }
  }

  private quoteAccountIndex(quoteId: string): number {
    if (!quoteId) {
      return 0
    }

    const digest = createHash('sha256').update(quoteId).digest()
    return digest.readUInt32BE(0) & 0x7fffffff
  }

  private async getConfirmedQuoteUtxos(blockHeight: number): Promise<BTCUtxo[]> {
    const utxos: BTCUtxo[] = []
    try {
      const result = await query<{ id: string; request: string }>(
        `
        SELECT DISTINCT ON (request) id, request
        FROM mint_quotes
        WHERE unit IN ('sat', 'btc')
          AND request <> $1
        ORDER BY request, created_at DESC
      `,
        [this.config.mintAddress]
      )

      for (const row of result.rows) {
        const accountIndex = this.quoteAccountIndex(row.id)
        const addressUtxos = await this.esploraClient.getAddressUtxos(row.request)
        for (const utxo of addressUtxos) {
          if (!utxo.status.confirmed) {
            continue
          }

          const confirmations = utxo.status.block_height
            ? blockHeight - utxo.status.block_height + 1
            : 0

          if (confirmations >= this.config.minConfirmations) {
            utxos.push({
              txid: utxo.txid,
              vout: utxo.vout,
              value: utxo.value,
              address: row.request,
              confirmations,
              accountIndex,
            })
          }
        }
      }
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Unable to scan quote deposit addresses'
      )
    }

    return utxos
  }
}
