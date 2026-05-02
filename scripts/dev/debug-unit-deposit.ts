#!/usr/bin/env npx tsx
/**
 * Debug UNIT Deposit
 */

import { OrdClient, EsploraClient } from '../../src/runes/api-client.js'
import { env } from '../../src/config/env.js'

const TXID = '36231ef0dd5558db8888362b5668026657f50559292e6f4667d96c32d0840606'
const VOUT = 1
const RUNE_NAME = 'DUCAT•UNIT•RUNE'

async function main() {
  console.log('=== Debug UNIT Deposit ===\n')

  const ordClient = new OrdClient(env.ORD_URL)
  const esploraClient = new EsploraClient(env.ESPLORA_URL)

  // Get transaction
  console.log('Getting transaction from Esplora...')
  const tx = await esploraClient.getTransaction(TXID)
  console.log('TX confirmed:', tx.status.confirmed)
  console.log('TX block height:', tx.status.block_height)

  // Get block height
  const blockHeight = await esploraClient.getBlockHeight()
  console.log('Current block height:', blockHeight)

  const confirmations = tx.status.confirmed && tx.status.block_height
    ? blockHeight - tx.status.block_height + 1
    : 0
  console.log('Confirmations:', confirmations)
  console.log('Min required:', env.MINT_CONFIRMATIONS)
  console.log('Meets requirement:', confirmations >= env.MINT_CONFIRMATIONS ? 'YES' : 'NO')
  console.log('')

  // Get UTXO from Ord
  console.log('Getting UTXO from Ord...')
  console.log('Ord URL:', env.ORD_URL)
  const utxoDetails = await ordClient.getOutput(TXID, VOUT)
  console.log('UTXO details:', JSON.stringify(utxoDetails, null, 2))

  if (utxoDetails && utxoDetails.runes) {
    console.log('\nRunes in UTXO:', Object.keys(utxoDetails.runes))
    const unitRune = utxoDetails.runes[RUNE_NAME]
    if (unitRune) {
      console.log('UNIT amount:', unitRune.amount)
    } else {
      console.log('No', RUNE_NAME, 'found')
    }
  }
}

main().catch(console.error)
