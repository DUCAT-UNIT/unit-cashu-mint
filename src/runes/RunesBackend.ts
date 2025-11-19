import { Pool } from 'pg'
import { OrdClient, EsploraClient } from './api-client.js'
import { UtxoSelector } from './utxo-selection.js'
import { RunesPsbtBuilder } from './psbt-builder.js'
import { UtxoManager } from './UtxoManager.js'
import { WalletKeyManager } from './WalletKeyManager.js'
import {
  RunesDepositStatus,
  RunesWithdrawalResult,
  DUCAT_UNIT_RUNE,
  DUCAT_UNIT_RUNE_ID,
  DUCAT_UNIT_RUNE_NAME,
  RuneId,
} from './types.js'
import { logger } from '../utils/logger.js'
import { env } from '../config/env.js'

/**
 * Payment backend interface for Runes
 */
export interface IPaymentBackend {
  createDepositAddress(quoteId: string, amount: bigint, runeId: string): Promise<string>
  checkDeposit(quoteId: string, depositAddress: string): Promise<RunesDepositStatus>
  estimateFee(destination: string, amount: bigint, runeId: string): Promise<number>
  sendRunes(
    destination: string,
    amount: bigint,
    runeId: string
  ): Promise<RunesWithdrawalResult>
  getBalance(runeId: string): Promise<bigint>
}

/**
 * Main Runes backend implementation
 * Handles deposits, withdrawals, and UTXO management for the mint
 */
export class RunesBackend implements IPaymentBackend {
  private ordClient: OrdClient
  private esploraClient: EsploraClient
  private utxoSelector: UtxoSelector
  private psbtBuilder: RunesPsbtBuilder
  private utxoManager: UtxoManager
  private walletKeyManager: WalletKeyManager

  // Mint addresses
  private taprootAddress: string
  private segwitAddress: string
  private taprootPubkey: string

  constructor(db: Pool) {
    this.ordClient = new OrdClient()
    this.esploraClient = new EsploraClient()
    this.utxoSelector = new UtxoSelector(this.ordClient, this.esploraClient)
    this.psbtBuilder = new RunesPsbtBuilder(this.esploraClient)
    this.utxoManager = new UtxoManager(db)
    this.walletKeyManager = new WalletKeyManager()

    // Derive or load addresses
    if (env.MINT_TAPROOT_ADDRESS && env.MINT_SEGWIT_ADDRESS && env.MINT_TAPROOT_PUBKEY) {
      // Use addresses from environment (for testing/development)
      this.taprootAddress = env.MINT_TAPROOT_ADDRESS
      this.segwitAddress = env.MINT_SEGWIT_ADDRESS
      this.taprootPubkey = env.MINT_TAPROOT_PUBKEY
      logger.info('Using mint addresses from environment variables')
    } else if (env.MINT_SEED) {
      // Derive addresses from seed
      const addresses = this.walletKeyManager.deriveAddresses()
      this.taprootAddress = addresses.taprootAddress
      this.segwitAddress = addresses.segwitAddress
      this.taprootPubkey = addresses.taprootPubkey
      logger.info('Derived mint addresses from MINT_SEED')
    } else {
      throw new Error('Either MINT_SEED or all of MINT_TAPROOT_ADDRESS, MINT_SEGWIT_ADDRESS, and MINT_TAPROOT_PUBKEY must be configured')
    }

    logger.info(
      {
        taprootAddress: this.taprootAddress,
        segwitAddress: this.segwitAddress,
      },
      'RunesBackend initialized'
    )
  }

  /**
   * Create a deposit address for a mint quote
   * For now, we use the mint's taproot address directly
   * In production, could use unique addresses per quote
   */
  async createDepositAddress(
    quoteId: string,
    amount: bigint,
    runeId: string
  ): Promise<string> {
    logger.info({ quoteId, amount: amount.toString(), runeId }, 'Creating deposit address')

    // For simplicity, we use the mint's main taproot address
    // In production, you might want to derive unique addresses per quote
    return this.taprootAddress
  }

  /**
   * Check if a deposit has been received for a quote
   */
  async checkDeposit(
    quoteId: string,
    depositAddress: string
  ): Promise<RunesDepositStatus> {
    try {
      logger.info({ quoteId, depositAddress }, 'Checking deposit status')

      // Check if we've already recorded this deposit in the database
      const existingDeposit = await this.utxoManager.getUnspentUtxos(DUCAT_UNIT_RUNE_ID)

      // Look for a UTXO that matches this quote
      // We need to check if there's a NEW deposit for this specific quote
      // For now, we'll check the database first to see if we already processed this

      // Get address data from Ord to check for NEW outputs
      const ordData = await this.ordClient.getAddressOutputs(depositAddress)

      // Check if there are any runes balances
      if (!ordData.runes_balances || ordData.runes_balances.length === 0) {
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      // Find DUCAT•UNIT•RUNE balance
      const ducatBalance = ordData.runes_balances.find(
        ([name]) => name === DUCAT_UNIT_RUNE_NAME
      )

      if (!ducatBalance || ordData.outputs.length === 0) {
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      // Check each output to find one that's NOT already in our database
      for (const output of ordData.outputs) {
        const [txid, voutStr] = output.split(':')
        const vout = parseInt(voutStr, 10)

        // Check if this UTXO is already tracked
        const isAlreadyTracked = existingDeposit.some(
          utxo => utxo.txid === txid && utxo.vout === vout
        )

        if (isAlreadyTracked) {
          // This is an old deposit, skip it
          continue
        }

        // This is a new UTXO! Check confirmations
        const tx = await this.esploraClient.getTransaction(txid)
        const blockHeight = await this.esploraClient.getBlockHeight()

        const confirmations = tx.status.confirmed && tx.status.block_height
          ? blockHeight - tx.status.block_height + 1
          : 0

        // Check if this UTXO has UNIT runes
        const utxoDetails = await this.ordClient.getOutput(txid, vout)
        if (!utxoDetails || !utxoDetails.runes) {
          continue
        }

        // runes is a Record<string, {amount: string, id: string}>
        // Check if DUCAT•UNIT•RUNE is present by name
        const unitRune = utxoDetails.runes[DUCAT_UNIT_RUNE_NAME]

        if (!unitRune) {
          continue
        }

        const amount = BigInt(unitRune.amount)

        logger.info(
          { quoteId, txid, vout, amount: amount.toString(), confirmations },
          'New deposit detected'
        )

        return {
          confirmed: confirmations >= 1,
          amount,
          txid,
          vout,
          confirmations,
        }
      }

      // No new deposits found
      return {
        confirmed: false,
        confirmations: 0,
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name
          } : error,
          quoteId,
          depositAddress
        },
        'Error checking deposit'
      )
      throw error
    }
  }

  /**
   * Estimate fee for a Runes withdrawal
   */
  async estimateFee(
    _destination: string,
    _amount: bigint,
    _runeId: string
  ): Promise<number> {
    // For now, return a fixed fee
    // In production, could use dynamic fee estimation
    return 1000 // sats
  }

  /**
   * Send Runes to a destination address
   * This is the withdrawal/melt operation
   */
  async sendRunes(
    destination: string,
    amount: bigint,
    runeId: string
  ): Promise<RunesWithdrawalResult> {
    try {
      logger.info(
        { destination, amount: amount.toString(), runeId },
        'Sending Runes'
      )

      // Parse rune ID
      const [blockStr, txStr] = runeId.split(':')
      const parsedRuneId: RuneId = {
        block: BigInt(blockStr),
        tx: BigInt(txStr),
      }

      // Get spent UTXOs to exclude
      const spentUtxos = await this.utxoManager.getSpentUtxoKeys()

      // Find UTXOs
      const utxos = await this.utxoSelector.findUtxosForRunesTransfer(
        this.taprootAddress,
        this.segwitAddress,
        amount,
        DUCAT_UNIT_RUNE_NAME,
        parsedRuneId,
        spentUtxos
      )

      if (!utxos) {
        throw new Error('Insufficient funds - no suitable UTXOs found')
      }

      // Build PSBT
      const { psbt, fee } = await this.psbtBuilder.buildRunesPsbt(
        utxos.runeUtxo,
        utxos.satUtxo,
        this.taprootAddress,
        this.taprootPubkey,
        this.segwitAddress,
        destination,
        amount
      )

      // Sign the PSBT
      const { signedTxHex, txid } = this.walletKeyManager.signAndExtract(psbt)

      // Broadcast transaction
      const broadcastedTxid = await this.esploraClient.broadcastTransaction(signedTxHex)

      // Verify txid matches (security check against MITM)
      if (broadcastedTxid.trim() !== txid) {
        logger.error(
          { expected: txid, received: broadcastedTxid },
          'TXID mismatch after broadcast - possible MITM attack'
        )
        throw new Error('Transaction broadcast verification failed - txid mismatch')
      }

      // Mark UTXOs as spent
      await this.utxoManager.markSpent(utxos.runeUtxo.txid, utxos.runeUtxo.vout, txid)
      await this.utxoManager.markSpent(utxos.satUtxo.txid, utxos.satUtxo.vout, txid)

      logger.info(
        {
          txid,
          amount: amount.toString(),
          destination,
          fee,
        },
        'Runes withdrawal completed successfully'
      )

      return { txid, fee_paid: fee }
    } catch (error) {
      logger.error({ error, destination, amount: amount.toString() }, 'Error sending Runes')
      throw error
    }
  }

  /**
   * Get the mint's current balance for a specific rune
   */
  async getBalance(runeId: string): Promise<bigint> {
    return this.utxoManager.getBalance(runeId)
  }

  /**
   * Sync UTXOs from the blockchain
   * Should be called periodically to detect new deposits
   */
  async syncUtxos(): Promise<void> {
    try {
      logger.info('Syncing UTXOs from blockchain')

      // Get all outputs for the mint's taproot address
      const ordData = await this.ordClient.getAddressOutputs(this.taprootAddress)

      // Process each output
      const runeUtxos = []
      for (const output of ordData.outputs) {
        const parts = output.split(':')
        const txid = parts[0]
        const vout = parseInt(parts[1], 10)

        // Get detailed info
        const outputData = await this.ordClient.getOutput(txid, vout)

        // Check if it has DUCAT•UNIT•RUNE
        if (outputData.runes && outputData.runes[DUCAT_UNIT_RUNE_NAME]) {
          const runeData = outputData.runes[DUCAT_UNIT_RUNE_NAME]

          // Parse rune ID from the data
          const [blockStr, txStr] = runeData.id.split(':')
          const runeId: RuneId = {
            block: BigInt(blockStr),
            tx: BigInt(txStr),
          }

          runeUtxos.push({
            txid,
            vout,
            value: outputData.value,
            address: this.taprootAddress,
            runeAmount: BigInt(runeData.amount),
            runeName: DUCAT_UNIT_RUNE_NAME,
            runeId,
          })
        }
      }

      // Sync to database
      const syncResult = await this.utxoManager.syncFromBlockchain(this.taprootAddress, runeUtxos)

      logger.info({ count: runeUtxos.length, ...syncResult }, 'UTXO sync complete')
    } catch (error) {
      logger.error({ error }, 'Error syncing UTXOs')
      throw error
    }
  }
}
