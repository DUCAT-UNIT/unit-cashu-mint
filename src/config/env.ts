import { config } from 'dotenv'
import { z } from 'zod'

config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().optional(),

  NETWORK: z.enum(['mainnet', 'testnet', 'signet', 'regtest', 'mutinynet']).default('testnet'),
  ESPLORA_URL: z.string(),
  ORD_URL: z.string(),
  MEMPOOL_URL: z.string(),

  MINT_SEED: z.string().length(64), // 32 bytes hex
  MINT_PUBKEY: z.string(),
  MINT_TAPROOT_ADDRESS: z.string().optional(), // Mint's taproot address for receiving UNIT
  MINT_TAPROOT_PUBKEY: z.string().optional(), // Mint's taproot internal pubkey (32-byte x-only key)
  MINT_SEGWIT_ADDRESS: z.string().optional(), // Mint's segwit address for fees
  SUPPORTED_RUNES: z.string(), // UNIT rune ID (840000:3)

  ENCRYPTION_KEY: z.string().length(64),
  JWT_SECRET: z.string(),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  RATE_LIMIT_MAX: z.string().default('100'),
  RATE_LIMIT_WINDOW: z.string().default('60000'),

  MINT_NAME: z.string().default('Ducat UNIT Mint'),
  MINT_DESCRIPTION: z.string().default('Cashu ecash backed by UNIT'),
  MINT_CONTACT_EMAIL: z.string().email().optional(),
  MINT_CONTACT_NOSTR: z.string().optional(),

  MIN_MINT_AMOUNT: z.string().default('100'),
  MAX_MINT_AMOUNT: z.string().default('100000000'),
  MIN_MELT_AMOUNT: z.string().default('100'),
  MAX_MELT_AMOUNT: z.string().default('100000000'),

  MINT_CONFIRMATIONS: z.string().default('1'),
  MELT_CONFIRMATIONS: z.string().default('1'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  throw new Error('Invalid environment variables')
}

export const env = {
  ...parsed.data,
  PORT: parseInt(parsed.data.PORT),
  RATE_LIMIT_MAX: parseInt(parsed.data.RATE_LIMIT_MAX),
  RATE_LIMIT_WINDOW: parseInt(parsed.data.RATE_LIMIT_WINDOW),
  MIN_MINT_AMOUNT: parseInt(parsed.data.MIN_MINT_AMOUNT),
  MAX_MINT_AMOUNT: parseInt(parsed.data.MAX_MINT_AMOUNT),
  MIN_MELT_AMOUNT: parseInt(parsed.data.MIN_MELT_AMOUNT),
  MAX_MELT_AMOUNT: parseInt(parsed.data.MAX_MELT_AMOUNT),
  MINT_CONFIRMATIONS: parseInt(parsed.data.MINT_CONFIRMATIONS),
  MELT_CONFIRMATIONS: parseInt(parsed.data.MELT_CONFIRMATIONS),
  SUPPORTED_RUNES_ARRAY: parsed.data.SUPPORTED_RUNES.split(',').map((r) => r.trim()),
}

export type Env = typeof env
