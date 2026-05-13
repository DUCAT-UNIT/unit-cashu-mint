import { Pool } from 'pg'
import { OrdClient, EsploraClient } from './api-client.js'
import { UtxoSelector } from './utxo-selection.js'
import { RunesPsbtBuilder } from './psbt-builder.js'
import { UtxoManager } from './UtxoManager.js'
import { WalletKeyManager } from './WalletKeyManager.js'
import {
  RunesWithdrawalResult,
  DUCAT_UNIT_RUNE_ID,
  DUCAT_UNIT_RUNE_NAME,
  RuneId,
  RuneUtxo,
} from './types.js'
import { logger } from '../utils/logger.js'
import { env } from '../config/env.js'
import { IPaymentBackend, DepositStatus, WithdrawalResult } from '../core/payment/types.js'

/**
 * Main Runes backend implementation
 * Handles deposits, withdrawals, and UTXO management for the mint
 */
export class RunesBackend implements IPaymentBackend {
  readonly method = 'onchain'
  readonly unit = 'unit'

  private ordClient: OrdClient
  private esploraClient: EsploraClient
  private utxoSelector: UtxoSelector
  private psbtBuilder: RunesPsbtBuilder
  private utxoManager: UtxoManager
  private walletKeyManager: WalletKeyManager

  // Rune configuration
  private runeId: string
  private runeName: string

  // Mint addresses
  private taprootAddress: string
  private segwitAddress: string
  private taprootPubkey: string

  constructor(db: Pool, runeId?: string, runeName?: string) {
    this.ordClient = new OrdClient()
    this.esploraClient = new EsploraClient()
    this.utxoSelector = new UtxoSelector(this.ordClient, this.esploraClient)
    this.psbtBuilder = new RunesPsbtBuilder(this.esploraClient)
    this.utxoManager = new UtxoManager(db)
    this.walletKeyManager = new WalletKeyManager()

    // Use provided rune config or defaults
    this.runeId = runeId || DUCAT_UNIT_RUNE_ID
    this.runeName = runeName || DUCAT_UNIT_RUNE_NAME

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
   * UNIT deposits use quote-derived Taproot addresses so amountless quotes can
   * safely derive their amount from the deposited rune output.
   */
  async createDepositAddress(
    quoteId: string,
    amount: bigint
  ): Promise<string> {
    const quoteAddress = this.walletKeyManager.deriveQuoteTaprootAddress(quoteId)
    logger.info(
      {
        quoteId,
        amount: amount.toString(),
        runeId: this.runeId,
        depositAddress: quoteAddress.address,
        accountIndex: quoteAddress.accountIndex,
      },
      'Creating deposit address'
    )

    return quoteAddress.address
  }

  isCanonicalDepositAddress(address: string): boolean {
    return address === this.taprootAddress
  }

  /**
   * Check if a deposit has been received for a quote
   * @param quoteId - The quote ID
   * @param depositAddress - The deposit address to check
   * @param includeTracked - If true, also check already-tracked UTXOs (for re-verification during minting)
   * @param expectedAmount - Expected amount for exact UTXO matching (like BTC backend)
   */
  async checkDeposit(
    quoteId: string,
    depositAddress: string,
    includeTracked: boolean = false,
    expectedAmount?: bigint
  ): Promise<DepositStatus> {
    try {
      logger.info({ quoteId, depositAddress, expectedAmount: expectedAmount?.toString() }, 'Checking deposit status')

      if (expectedAmount === undefined && this.isCanonicalDepositAddress(depositAddress)) {
        logger.warn(
          { quoteId, depositAddress },
          'Skipping amountless shared-address UNIT deposit check'
        )
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      // Check if we've already recorded this deposit in the database
      const existingDeposit = await this.utxoManager.getUnspentUtxos(this.runeId)
      const claimedDeposits = await this.utxoManager.getClaimedDepositMap()

      // Get address data from Ord to check for outputs
      const ordData = await this.ordClient.getAddressOutputs(depositAddress)

      // Check if there are any runes balances
      if (!ordData.runes_balances || ordData.runes_balances.length === 0) {
        logger.info({ quoteId, outputCount: ordData.outputs?.length ?? 0 }, 'No runes balances found at address')
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      // Find DUCAT•UNIT•RUNE balance
      const ducatBalance = ordData.runes_balances.find(
        ([name]) => name === this.runeName
      )

      if (!ducatBalance || ordData.outputs.length === 0) {
        logger.info(
          { quoteId, outputCount: ordData.outputs.length, runeNames: ordData.runes_balances.map(([name]) => name) },
          'No DUCAT•UNIT•RUNE balance found or no outputs'
        )
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      logger.info(
        { quoteId, outputCount: ordData.outputs.length, includeTracked, trackedCount: existingDeposit.length, expectedAmount: expectedAmount?.toString() },
        'Checking outputs for deposit'
      )

      // If expectedAmount is provided, look for an unspent UTXO matching that exact amount
      // This allows multiple quotes to share the same deposit address
      if (expectedAmount !== undefined) {
        for (const output of ordData.outputs) {
          const [txid, voutStr] = output.split(':')
          const vout = parseInt(voutStr, 10)
          const claimedByQuote = claimedDeposits.get(`${txid}:${vout}`)
          if (claimedByQuote && claimedByQuote !== quoteId) {
            logger.debug({ txid, vout, claimedByQuote, quoteId }, 'Skipping claimed deposit')
            continue
          }

          // Get UTXO details from Ord
          const utxoDetails = await this.ordClient.getOutput(txid, vout)
          if (!utxoDetails || !utxoDetails.runes || utxoDetails.spent) {
            continue
          }

          const unitRune = utxoDetails.runes[this.runeName]
          if (!unitRune) {
            continue
          }

          const amount = BigInt(unitRune.amount)

          // Check if amount matches expected
          if (amount === expectedAmount) {
            // Check confirmations
            const tx = await this.esploraClient.getTransaction(txid)
            const blockHeight = await this.esploraClient.getBlockHeight()
            const confirmations = tx.status.confirmed && tx.status.block_height
              ? blockHeight - tx.status.block_height + 1
              : 0

            if (confirmations >= env.MINT_CONFIRMATIONS) {
              await this.trackDepositUtxo(quoteId, depositAddress, txid, vout, utxoDetails, amount)
              logger.info(
                { quoteId, txid, vout, amount: amount.toString(), confirmations },
                'Deposit detected (exact amount match)'
              )

              return {
                confirmed: true,
                amount,
                txid,
                vout,
                confirmations,
              }
            }
          }
        }

        // No exact match found
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      // Fallback: Original behavior - find any untracked UTXO (for backwards compatibility)
      for (const output of ordData.outputs) {
        const [txid, voutStr] = output.split(':')
        const vout = parseInt(voutStr, 10)
        const claimedByQuote = claimedDeposits.get(`${txid}:${vout}`)
        if (claimedByQuote && claimedByQuote !== quoteId) {
          logger.debug({ txid, vout, claimedByQuote, quoteId }, 'Skipping claimed deposit')
          continue
        }

        // Check if this UTXO is already tracked
        const isAlreadyTracked = existingDeposit.some(
          utxo => utxo.txid === txid && utxo.vout === vout
        )

        // Skip already-tracked UTXOs unless we're re-verifying for minting
        if (isAlreadyTracked && !includeTracked) {
          logger.debug({ txid, vout, isAlreadyTracked, includeTracked }, 'Skipping tracked UTXO')
          continue
        }

        // Check confirmations
        const tx = await this.esploraClient.getTransaction(txid)
        const blockHeight = await this.esploraClient.getBlockHeight()

        const confirmations = tx.status.confirmed && tx.status.block_height
          ? blockHeight - tx.status.block_height + 1
          : 0

        // Check if this UTXO has UNIT runes
        const utxoDetails = await this.ordClient.getOutput(txid, vout)
        if (!utxoDetails || !utxoDetails.runes) {
          logger.debug({ txid, vout }, 'UTXO has no runes, skipping')
          continue
        }

        // Check if DUCAT•UNIT•RUNE is present by name
        const unitRune = utxoDetails.runes[this.runeName]

        if (!unitRune) {
          logger.debug({ txid, vout, availableRunes: Object.keys(utxoDetails.runes) }, 'UTXO does not have DUCAT•UNIT•RUNE, skipping')
          continue
        }

        logger.debug({ txid, vout, confirmations, isAlreadyTracked }, 'Found UTXO with DUCAT•UNIT•RUNE')

        const amount = BigInt(unitRune.amount)

        if (confirmations >= env.MINT_CONFIRMATIONS) {
          await this.trackDepositUtxo(quoteId, depositAddress, txid, vout, utxoDetails, amount)
        }

        logger.info(
          {
            quoteId,
            txid,
            vout,
            amount: amount.toString(),
            confirmations,
            required: env.MINT_CONFIRMATIONS
          },
          'New deposit detected'
        )

        return {
          confirmed: confirmations >= env.MINT_CONFIRMATIONS,
          amount,
          txid,
          vout,
          confirmations,
        }
      }

      // No deposits found
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
          } : String(error),
          quoteId,
          depositAddress
        },
        'Error checking deposit'
      )
      throw error
    }
  }

  /**
   * Verify a specific deposit by txid/vout
   * Used for re-verification when we already know which UTXO to check
   */
  async verifySpecificDeposit(
    quoteId: string,
    txid: string,
    vout: number
  ): Promise<DepositStatus> {
    try {
      logger.info({ quoteId, txid, vout }, 'Verifying specific deposit')

      // Get transaction info from esplora
      const tx = await this.esploraClient.getTransaction(txid)
      const blockHeight = await this.esploraClient.getBlockHeight()

      const confirmations = tx.status.confirmed && tx.status.block_height
        ? blockHeight - tx.status.block_height + 1
        : 0

      // Get UTXO details from Ord
      const utxoDetails = await this.ordClient.getOutput(txid, vout)
      if (!utxoDetails || !utxoDetails.runes) {
        logger.warn({ quoteId, txid, vout }, 'UTXO not found or has no runes')
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      // Check for DUCAT•UNIT•RUNE
      const unitRune = utxoDetails.runes[this.runeName]
      if (!unitRune) {
        logger.warn({ quoteId, txid, vout, availableRunes: Object.keys(utxoDetails.runes) }, 'UTXO does not have DUCAT•UNIT•RUNE')
        return {
          confirmed: false,
          confirmations: 0,
        }
      }

      const amount = BigInt(unitRune.amount)

      if (confirmations >= env.MINT_CONFIRMATIONS) {
        const outputAddress = tx.vout?.[vout]?.scriptpubkey_address
        await this.trackDepositUtxo(
          quoteId,
          outputAddress ?? this.taprootAddress,
          txid,
          vout,
          utxoDetails,
          amount
        )
      }

      logger.info(
        { quoteId, txid, vout, amount: amount.toString(), confirmations, required: env.MINT_CONFIRMATIONS },
        'Specific deposit verified'
      )

      return {
        confirmed: confirmations >= env.MINT_CONFIRMATIONS,
        amount,
        txid,
        vout,
        confirmations,
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name
          } : String(error),
          quoteId,
          txid,
          vout
        },
        'Error verifying specific deposit'
      )
      throw error
    }
  }

  private accountIndexForDeposit(quoteId: string, depositAddress: string): number {
    const quoteAddress = this.walletKeyManager.deriveQuoteTaprootAddress(quoteId)
    if (depositAddress === quoteAddress.address) {
      return quoteAddress.accountIndex
    }

    return 0
  }

  private taprootInternalPubkeyForAccount(accountIndex: number): string {
    if (accountIndex === 0) {
      return this.taprootPubkey
    }

    return this.walletKeyManager.deriveTaprootAddress(accountIndex).internalPubkey
  }

  private async trackDepositUtxo(
    quoteId: string,
    depositAddress: string,
    txid: string,
    vout: number,
    outputData: { value: number },
    amount: bigint
  ): Promise<void> {
    const [blockStr, txStr] = this.runeId.split(':')
    await this.utxoManager.addUtxo({
      txid,
      vout,
      value: outputData.value,
      address: depositAddress,
      runeAmount: amount,
      runeName: this.runeName,
      runeId: {
        block: BigInt(blockStr),
        tx: BigInt(txStr),
      },
      accountIndex: this.accountIndexForDeposit(quoteId, depositAddress),
      taprootInternalPubkey: this.taprootInternalPubkeyForAccount(
        this.accountIndexForDeposit(quoteId, depositAddress)
      ),
    })
  }

  /**
   * Estimate fee for a Runes withdrawal
   */
  async estimateFee(
    _destination: string,
    _amount: bigint
  ): Promise<number> {
    // For now, return a fixed fee
    // In production, could use dynamic fee estimation
    return 1000 // sats
  }

  /**
   * Withdraw (send) Runes to a destination address
   * Implements IPaymentBackend.withdraw()
   */
  async withdraw(
    destination: string,
    amount: bigint
  ): Promise<WithdrawalResult> {
    return this.sendRunes(destination, amount, this.runeId)
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
      const trackedRuneUtxos = await this.utxoManager.getUnspentUtxos(this.runeId)

      // Find UTXOs
      const utxos = await this.utxoSelector.findUtxosForRunesTransfer(
        this.taprootAddress,
        this.segwitAddress,
        amount,
        this.runeName,
        parsedRuneId,
        spentUtxos,
        trackedRuneUtxos,
        (accountIndex) => this.taprootInternalPubkeyForAccount(accountIndex)
      )

      if (!utxos) {
        throw new Error('Insufficient funds - no suitable UTXOs found')
      }

      // Build PSBT
      const { psbt, fee } = await this.psbtBuilder.buildRunesPsbt(
        utxos.runeUtxos,
        utxos.satUtxo,
        this.taprootAddress,
        this.taprootPubkey,
        this.segwitAddress,
        destination,
        amount
      )

      // Sign the PSBT
      const runeInputAccountIndexes = utxos.runeUtxos.map((utxo) => utxo.accountIndex ?? 0)
      const { signedTxHex, txid } = this.walletKeyManager.signAndExtract(
        psbt,
        runeInputAccountIndexes
      )

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

      // Mark all rune UTXOs as spent
      for (const runeUtxo of utxos.runeUtxos) {
        await this.utxoManager.markSpent(runeUtxo.txid, runeUtxo.vout, txid)
      }

      // Mark sat UTXO as spent
      await this.utxoManager.markSpent(utxos.satUtxo.txid, utxos.satUtxo.vout, txid)

      // Track the return UTXO (output 0) if there's excess runes
      const totalRunesFromInputs = utxos.runeUtxos.reduce((sum, u) => sum + u.runeAmount, 0n)
      const excessRunes = totalRunesFromInputs - amount

      if (excessRunes > 0n) {
        // Output 0 is the taproot return address with excess runes
        const returnUtxo: RuneUtxo = {
          txid,
          vout: 0, // Return output is always at index 0
          value: 10000, // RUNE_RETURN_SATS from PSBT builder
          address: this.taprootAddress,
          runeAmount: excessRunes,
          runeName: this.runeName,
          runeId: parsedRuneId,
          accountIndex: 0,
          taprootInternalPubkey: this.taprootPubkey,
        }

        await this.utxoManager.addUtxo(returnUtxo)

        logger.info(
          {
            txid,
            vout: 0,
            excessRunes: excessRunes.toString(),
          },
          'Tracked return UTXO with excess runes'
        )
      }

      logger.info(
        {
          txid,
          amount: amount.toString(),
          destination,
          fee,
          excessReturned: excessRunes.toString(),
        },
        'Runes withdrawal completed successfully'
      )

      return { txid, fee_paid: fee }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name
          } : String(error),
          destination,
          amount: amount.toString()
        },
        'Error sending Runes'
      )
      throw error
    }
  }

  /**
   * Get the mint's current balance for the configured rune
   */
  async getBalance(): Promise<bigint> {
    return this.utxoManager.getBalance(this.runeId)
  }

  /**
   * Get the rune ID this backend is configured for
   */
  getRuneId(): string {
    return this.runeId
  }

  /**
   * Get the rune name this backend is configured for
   */
  getRuneName(): string {
    return this.runeName
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
        if (outputData.runes && outputData.runes[this.runeName]) {
          const runeData = outputData.runes[this.runeName]

          // Parse rune ID from the data, or use the known DUCAT•UNIT•RUNE ID
          let runeId: RuneId
          if (runeData.id) {
            const [blockStr, txStr] = runeData.id.split(':')
            runeId = {
              block: BigInt(blockStr),
              tx: BigInt(txStr),
            }
          } else {
            // Use the known DUCAT•UNIT•RUNE ID
            const [blockStr, txStr] = this.runeId.split(':')
            runeId = {
              block: BigInt(blockStr),
              tx: BigInt(txStr),
            }
            logger.debug({ txid, vout }, 'Using default DUCAT•UNIT•RUNE ID')
          }

          runeUtxos.push({
            txid,
            vout,
            value: outputData.value,
            address: this.taprootAddress,
            runeAmount: BigInt(runeData.amount),
            runeName: this.runeName,
            runeId,
            accountIndex: 0,
            taprootInternalPubkey: this.taprootPubkey,
          })
        }
      }

      // Sync to database
      const syncResult = await this.utxoManager.syncFromBlockchain(this.taprootAddress, runeUtxos)

      logger.info({ count: runeUtxos.length, ...syncResult }, 'UTXO sync complete')
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name
          } : String(error)
        },
        'Error syncing UTXOs'
      )
      throw error
    }
  }
}
