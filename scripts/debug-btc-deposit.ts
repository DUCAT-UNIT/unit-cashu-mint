#!/usr/bin/env npx tsx
/**
 * Debug BTC Deposit Check
 */

import { EsploraClient } from '../src/runes/api-client.js'

const MINT_ADDRESS = 'tb1q0ymavqheqw5ktk9k6l43an3njhcym8khmjlw36'
const MIN_CONFIRMATIONS = 1

async function main() {
  console.log('=== Debug BTC Deposit Check ===\n')

  const esploraClient = new EsploraClient('https://mutinynet.com/api')

  // Get UTXOs
  const utxos = await esploraClient.getAddressUtxos(MINT_ADDRESS)
  console.log('UTXOs found:', utxos.length)

  // Get current block height
  const blockHeight = await esploraClient.getBlockHeight()
  console.log('Current block height:', blockHeight)
  console.log('')

  let totalConfirmed = 0n

  for (const utxo of utxos) {
    const confirmations = utxo.status.confirmed && utxo.status.block_height
      ? blockHeight - utxo.status.block_height + 1
      : 0

    console.log(`UTXO: ${utxo.txid.slice(0, 16)}...`)
    console.log(`  vout: ${utxo.vout}`)
    console.log(`  value: ${utxo.value} sats`)
    console.log(`  confirmed: ${utxo.status.confirmed}`)
    console.log(`  block_height: ${utxo.status.block_height}`)
    console.log(`  confirmations: ${confirmations}`)
    console.log(`  meets min (${MIN_CONFIRMATIONS}): ${confirmations >= MIN_CONFIRMATIONS ? 'YES' : 'NO'}`)

    if (confirmations >= MIN_CONFIRMATIONS) {
      totalConfirmed += BigInt(utxo.value)
    }
    console.log('')
  }

  console.log('=== Summary ===')
  console.log('Total confirmed:', totalConfirmed.toString(), 'sats')
  console.log('Expected:', 11895178, 'sats')
  console.log('Match:', totalConfirmed === 11895178n ? 'YES' : 'NO')
}

main().catch(console.error)
