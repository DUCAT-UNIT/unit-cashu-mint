import type pg from 'pg'
import { query } from '../db.js'
import { BlindedMessage, BlindSignature } from '../../types/cashu.js'

export class SignatureRepository {
  async saveMany(
    outputs: BlindedMessage[],
    signatures: BlindSignature[],
    client?: pg.PoolClient
  ): Promise<void> {
    for (let i = 0; i < outputs.length; i++) {
      const output = outputs[i]
      const signature = signatures[i]
      if (!output || !signature) {
        continue
      }

      const runQuery: (text: string, params?: unknown[]) => Promise<pg.QueryResult> = client
        ? client.query.bind(client)
        : query
      await runQuery(
        `
        INSERT INTO issued_signatures (B_, keyset_id, amount, C_, dleq, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (B_) DO UPDATE SET
          keyset_id = EXCLUDED.keyset_id,
          amount = EXCLUDED.amount,
          C_ = EXCLUDED.C_,
          dleq = EXCLUDED.dleq
        `,
        [
          output.B_,
          signature.id,
          signature.amount,
          signature.C_,
          signature.dleq ? JSON.stringify(signature.dleq) : null,
          Date.now(),
        ]
      )
    }
  }

  async restore(
    outputs: BlindedMessage[]
  ): Promise<{ outputs: BlindedMessage[]; signatures: BlindSignature[] }> {
    if (outputs.length === 0) {
      return { outputs: [], signatures: [] }
    }

    const byBlindedMessage = new Map(outputs.map((output) => [output.B_, output]))
    const result = await query<{
      b_: string
      keyset_id: string
      amount: string
      c_: string
      dleq: unknown
    }>(
      `
      SELECT B_, keyset_id, amount, C_, dleq
      FROM issued_signatures
      WHERE B_ = ANY($1)
      `,
      [outputs.map((output) => output.B_)]
    )

    const restoredOutputs: BlindedMessage[] = []
    const signatures: BlindSignature[] = []

    for (const row of result.rows) {
      const requestedOutput = byBlindedMessage.get(row.b_)
      if (!requestedOutput) {
        continue
      }

      const amount = Number(row.amount)
      restoredOutputs.push({
        ...requestedOutput,
        amount,
      })
      signatures.push({
        id: row.keyset_id,
        amount,
        C_: row.c_,
        ...(row.dleq ? { dleq: row.dleq as BlindSignature['dleq'] } : {}),
      })
    }

    return { outputs: restoredOutputs, signatures }
  }
}
