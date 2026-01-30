import { decodeRunestone } from '../src/runes/runestone-encoder.js'

const payload = Buffer.from('00b89c5d019d2801', 'hex')
console.log('Decoding runestone:', payload.toString('hex'))

try {
  const decoded = decodeRunestone(payload)
  console.log('Decoded:', JSON.stringify(decoded, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2))
} catch (e) {
  console.error('Error:', e)
}
