import { RunestoneConfig, RuneId } from './types.js'

/**
 * Encode a number as a LEB128 varint
 */
function encodeVarint(value: bigint): Buffer {
  const bytes: number[] = []
  let n = BigInt(value)

  while (n >= 128n) {
    bytes.push(Number(n & 127n) | 128)
    n >>= 7n
  }
  bytes.push(Number(n))

  return Buffer.from(bytes)
}

/**
 * Decode a LEB128 varint from a buffer
 */
function decodeVarint(buffer: Buffer, offset: number): { value: bigint; newOffset: number } {
  let value = 0n
  let shift = 0n
  let currentOffset = offset

  while (currentOffset < buffer.length) {
    const byte = buffer[currentOffset]
    value |= BigInt(byte & 127) << shift
    currentOffset++

    if ((byte & 128) === 0) {
      break
    }
    shift += 7n
  }

  return { value, newOffset: currentOffset }
}

export interface EncodedRunestone {
  encodedRunestone: Buffer
  etchingCommitment?: Buffer
}

export interface DecodedRunestone {
  edicts: Array<{
    id: RuneId
    amount: bigint
    output: bigint
  }>
}

/**
 * Encode a runestone with edicts
 * Creates an OP_RETURN script: OP_RETURN + OP_13 + payload
 */
export function encodeRunestone(config: RunestoneConfig): EncodedRunestone {
  const { edicts = [] } = config

  if (!edicts || edicts.length === 0) {
    // Empty runestone: OP_RETURN + OP_13
    return {
      encodedRunestone: Buffer.from([0x6a, 0x5d, 0x00]),
      etchingCommitment: undefined,
    }
  }

  // Build the runestone payload
  const payload: number[] = []

  // Tag for edicts (0 = edicts)
  payload.push(...encodeVarint(0n))

  // Encode edicts with delta encoding
  let previousBlock = 0n
  let previousTx = 0n

  for (const edict of edicts) {
    const { id, amount, output } = edict

    // Delta encode block
    const blockDelta = BigInt(id.block) - previousBlock
    payload.push(...encodeVarint(blockDelta))
    previousBlock = BigInt(id.block)

    // Delta encode tx
    const txDelta = BigInt(id.tx) - previousTx
    payload.push(...encodeVarint(txDelta))
    previousTx = BigInt(id.tx)

    // Encode amount
    payload.push(...encodeVarint(BigInt(amount)))

    // Encode output
    payload.push(...encodeVarint(BigInt(output)))
  }

  const payloadBuffer = Buffer.from(payload)

  // Build the complete script:
  // OP_RETURN (0x6a) + OP_13 (0x5d) + OP_PUSHBYTES_N (length) + payload
  const script = Buffer.concat([
    Buffer.from([0x6a]), // OP_RETURN
    Buffer.from([0x5d]), // OP_13 (Runes protocol identifier)
    Buffer.from([payloadBuffer.length]), // OP_PUSHBYTES_N (where N is the length)
    payloadBuffer,
  ])

  return {
    encodedRunestone: script,
    etchingCommitment: undefined,
  }
}

/**
 * Decode a runestone from an OP_RETURN script
 */
export function decodeRunestone(script: Buffer | string): DecodedRunestone | null {
  try {
    // Convert hex string to Buffer if needed
    const scriptBuffer = typeof script === 'string' ? Buffer.from(script, 'hex') : script

    // Check if it's an OP_RETURN (0x6a)
    if (scriptBuffer[0] !== 0x6a) {
      return null
    }

    // Check if it has the Runes protocol tag (OP_13 = 0x5d)
    if (scriptBuffer[1] !== 0x5d) {
      return null
    }

    // Empty runestone check
    if (scriptBuffer.length === 3 && scriptBuffer[2] === 0x00) {
      return { edicts: [] }
    }

    // Get payload length (OP_PUSHBYTES_N)
    const payloadLength = scriptBuffer[2]

    // Extract payload
    const payload = scriptBuffer.slice(3, 3 + payloadLength)

    let offset = 0
    const edicts: Array<{ id: RuneId; amount: bigint; output: bigint }> = []

    // Decode tag (should be 0 for edicts)
    const tagResult = decodeVarint(payload, offset)
    if (tagResult.value !== 0n) {
      // Not an edicts tag, might be other runestone data
      return { edicts: [] }
    }
    offset = tagResult.newOffset

    // Decode edicts with delta encoding
    let previousBlock = 0n
    let previousTx = 0n

    while (offset < payload.length) {
      // Decode block delta
      const blockDeltaResult = decodeVarint(payload, offset)
      const block = previousBlock + blockDeltaResult.value
      offset = blockDeltaResult.newOffset

      // Decode tx delta
      const txDeltaResult = decodeVarint(payload, offset)
      const tx = previousTx + txDeltaResult.value
      offset = txDeltaResult.newOffset

      // Decode amount
      const amountResult = decodeVarint(payload, offset)
      const amount = amountResult.value
      offset = amountResult.newOffset

      // Decode output
      const outputResult = decodeVarint(payload, offset)
      const output = outputResult.value
      offset = outputResult.newOffset

      edicts.push({
        id: { block, tx },
        amount,
        output,
      })

      // Update previous values for delta encoding
      previousBlock = block
      previousTx = tx
    }

    return { edicts }
  } catch (error) {
    return null
  }
}
