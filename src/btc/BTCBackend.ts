import { EsploraClient } from '../runes/api-client.js'
import { BTCTxBuilder } from './tx-builder.js'
import { BTCConfig, BTCUtxo } from './types.js'
import { IPaymentBackend, DepositStatus, WithdrawalResult } from '../core/payment/types.js'
import { logger } from '../utils/logger.js'

/**
 * Bitcoin (BTC) payment backend
 * Handles BTC deposits and withdrawals for the mint
 */
export class BTCBackend implements IPaymentBackend {
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

    // For simplicity, use the mint's main address
    // In production, could derive per-quote addresses using HD wallet
    return this.config.mintAddress
  }

  /**
   * Check if a BTC deposit has been received
   */
  async checkDeposit(
    quoteId: string,
    address: string,
    _includeTracked: boolean = false
  ): Promise<DepositStatus> {
    try {
      logger.info({ quoteId, address }, 'Checking BTC deposit status')

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

      // Find confirmed UTXOs and sum their values
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
          'BTC deposit detected'
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
        }))

      if (confirmedUtxos.length === 0) {
        throw new Error('No confirmed UTXOs available for withdrawal')
      }

      // Build transaction
      const { psbt, fee } = this.txBuilder.buildTransaction(
        confirmedUtxos,
        destination,
        amount,
        this.config.mintAddress, // change goes back to mint
        this.config.feeRate
      )

      // Sign and extract
      const { signedTxHex, txid } = this.txBuilder.signAndExtract(psbt)

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
}
