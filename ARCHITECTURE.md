# Runes Mint Architecture

This document outlines the architecture for our Runes-backed Cashu mint, based on patterns and standards from the official `cashu-ts` library.

## Table of Contents

1. [Overview](#overview)
2. [cashu-ts Integration Strategy](#cashu-ts-integration-strategy)
3. [Project Structure](#project-structure)
4. [Core Components](#core-components)
5. [Data Models](#data-models)
6. [API Endpoints](#api-endpoints)
7. [Cryptography Layer](#cryptography-layer)
8. [Payment Backend](#payment-backend)
9. [Database Schema](#database-schema)
10. [Code Standards](#code-standards)
11. [Testing Strategy](#testing-strategy)
12. [NUT Implementation Plan](#nut-implementation-plan)

---

## Overview

We're building a **Cashu ecash mint backed by Bitcoin Runes** that:
- ✅ Implements standard Cashu protocol (NUT specifications)
- ✅ Uses `@cashu/cashu-ts` for cryptography primitives
- ✅ Integrates with existing Ducat Runes infrastructure
- ✅ Works with any Cashu-compatible wallet (eNuts, Minibits, etc.)
- ✅ Supports custom Runes deposit/redemption methods

### Hybrid Approach

```
┌─────────────────────────────────────────┐
│     Our Runes Mint Server               │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │   Custom Layer                    │ │
│  │   - Fastify HTTP server           │ │
│  │   - Database (PostgreSQL)         │ │
│  │   - Runes integration             │ │
│  │   - UTXO management               │ │
│  └───────────────┬───────────────────┘ │
│                  │                      │
│  ┌───────────────▼───────────────────┐ │
│  │   cashu-ts (Library)              │ │
│  │   - Blind signatures              │ │
│  │   - Proof verification            │ │
│  │   - Keyset management             │ │
│  │   - Token encoding                │ │
│  └───────────────────────────────────┘ │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │   Ducat Protocol (Reuse)          │ │
│  │   - Runestone encoding            │ │
│  │   - UTXO selection                │ │
│  │   - Transaction construction      │ │
│  └───────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

## cashu-ts Integration Strategy

### What We Use from cashu-ts

**Cryptography** (`@cashu/cashu-ts`):
```typescript
import {
  // Blind signature operations
  createBlindSignature,
  unblindSignature,
  hashToCurve,

  // Proof verification
  verifyProof,

  // DLEQ proofs
  createDLEQProof,
  verifyDLEQProof,

  // Key management
  createNewMintKeys,
  deriveKeysetId,

  // Token encoding
  getEncodedTokenV4,
  getDecodedToken,

  // Types
  type Proof,
  type BlindedMessage,
  type BlindSignature,
  type MintKeys,
  type Token
} from '@cashu/cashu-ts'
```

### What We Build Custom

**Server Infrastructure**:
- HTTP API server (Fastify)
- Database layer (PostgreSQL + migrations)
- Authentication & rate limiting
- Monitoring & logging

**Runes Integration**:
- Runes deposit monitoring (Ord indexer)
- Runes withdrawal processing (transaction construction)
- UTXO management (reuse Ducat code)
- Fee estimation (Bitcoin miner fees)

**Business Logic**:
- Quote lifecycle management
- Proof state tracking (prevent double-spend)
- Reserve monitoring
- Multi-keyset support

---

## Project Structure

```
mint-server/
├── src/
│   ├── server.ts                    # Fastify app initialization
│   ├── config/
│   │   ├── env.ts                   # Environment variables
│   │   └── constants.ts             # Application constants
│   │
│   ├── api/
│   │   ├── routes/
│   │   │   ├── info.ts              # GET /v1/info (NUT-06)
│   │   │   ├── keys.ts              # GET /v1/keys (NUT-01)
│   │   │   ├── mint.ts              # POST /v1/mint/* (NUT-04)
│   │   │   ├── melt.ts              # POST /v1/melt/* (NUT-05)
│   │   │   ├── swap.ts              # POST /v1/swap (NUT-03)
│   │   │   └── state.ts             # POST /v1/checkstate (NUT-07)
│   │   │
│   │   ├── middleware/
│   │   │   ├── errorHandler.ts      # Global error handling
│   │   │   ├── rateLimit.ts         # Rate limiting
│   │   │   └── requestLogger.ts     # HTTP logging
│   │   │
│   │   └── validators/
│   │       ├── mint.ts              # Request validation schemas
│   │       └── common.ts            # Shared validators
│   │
│   ├── core/
│   │   ├── crypto/
│   │   │   ├── MintCrypto.ts        # Wrapper around cashu-ts crypto
│   │   │   ├── KeyManager.ts        # Keyset generation & storage
│   │   │   └── ProofValidator.ts    # Proof verification logic
│   │   │
│   │   ├── services/
│   │   │   ├── MintService.ts       # Core mint operations
│   │   │   ├── SwapService.ts       # Token swap logic
│   │   │   ├── QuoteService.ts      # Quote lifecycle
│   │   │   └── StateService.ts      # Proof state management
│   │   │
│   │   └── models/
│   │       ├── Quote.ts             # Quote domain models
│   │       ├── Keyset.ts            # Keyset domain models
│   │       └── Proof.ts             # Proof domain models
│   │
│   ├── runes/
│   │   ├── RunesBackend.ts          # Main Runes integration
│   │   ├── DepositMonitor.ts        # Monitor Runes deposits
│   │   ├── WithdrawalProcessor.ts   # Process Runes withdrawals
│   │   ├── UtxoManager.ts           # Mint's UTXO management
│   │   ├── FeeEstimator.ts          # Transaction fee estimation
│   │   └── types.ts                 # Runes-specific types
│   │
│   ├── database/
│   │   ├── db.ts                    # Database connection
│   │   ├── migrations/
│   │   │   ├── 001_initial.sql
│   │   │   ├── 002_add_runes.sql
│   │   │   └── ...
│   │   │
│   │   └── repositories/
│   │       ├── KeysetRepository.ts
│   │       ├── QuoteRepository.ts
│   │       ├── ProofRepository.ts
│   │       └── UtxoRepository.ts
│   │
│   ├── utils/
│   │   ├── logger.ts                # Structured logging
│   │   ├── errors.ts                # Custom error classes
│   │   └── helpers.ts               # Common utilities
│   │
│   └── types/
│       ├── api.ts                   # API request/response types
│       ├── cashu.ts                 # Re-export cashu-ts types
│       └── config.ts                # Configuration types
│
├── tests/
│   ├── unit/
│   │   ├── crypto/
│   │   ├── services/
│   │   └── runes/
│   │
│   ├── integration/
│   │   ├── mint.test.ts
│   │   ├── swap.test.ts
│   │   └── runes.test.ts
│   │
│   └── fixtures/
│       ├── proofs.ts
│       └── mocks.ts
│
├── scripts/
│   ├── generate-keys.ts             # Initialize mint keys
│   ├── check-reserves.ts            # Audit reserves
│   └── migrate.ts                   # Run DB migrations
│
├── .env.example
├── package.json
├── tsconfig.json
├── docker-compose.yml               # PostgreSQL + Redis
└── README.md
```

---

## Core Components

### 1. Mint Crypto (`src/core/crypto/MintCrypto.ts`)

**Responsibilities**:
- Wrap `cashu-ts` cryptographic functions
- Sign blinded messages
- Verify proofs
- Generate DLEQ proofs

**Interface**:
```typescript
export class MintCrypto {
  constructor(private keyManager: KeyManager) {}

  /**
   * Sign a blinded message
   */
  signBlindedMessage(
    message: BlindedMessage,
    includeDleq: boolean = true
  ): BlindSignature

  /**
   * Verify a proof is valid
   */
  verifyProof(proof: Proof): boolean

  /**
   * Batch verify multiple proofs
   */
  verifyProofs(proofs: Proof[]): boolean

  /**
   * Hash secret to curve point (for Y lookup)
   */
  hashSecret(secret: string): string
}
```

**Implementation Pattern**:
```typescript
import { createBlindSignature, verifyProof, hashToCurve } from '@cashu/cashu-ts'

export class MintCrypto {
  signBlindedMessage(
    message: BlindedMessage,
    includeDleq: boolean = true
  ): BlindSignature {
    // Get private key for this amount/keyset
    const privateKey = this.keyManager.getPrivateKey(
      message.id,
      message.amount
    )

    // Use cashu-ts to sign
    const signature = createBlindSignature(
      pointFromHex(message.B_),
      privateKey,
      message.amount,
      message.id
    )

    // Optionally add DLEQ proof
    if (includeDleq) {
      signature.dleq = createDLEQProof(
        pointFromHex(message.B_),
        privateKey
      )
    }

    return signature
  }

  verifyProof(proof: Proof): boolean {
    const privateKey = this.keyManager.getPrivateKey(
      proof.id,
      proof.amount
    )

    return verifyProof(proof, privateKey)
  }

  hashSecret(secret: string): string {
    const Y = hashToCurve(Buffer.from(secret, 'utf8'))
    return Y.toHex()
  }
}
```

### 2. Key Manager (`src/core/crypto/KeyManager.ts`)

**Responsibilities**:
- Generate mint keysets
- Store/retrieve private keys securely
- Manage active keysets
- Key rotation

**Interface**:
```typescript
export class KeyManager {
  /**
   * Generate new keyset for a Rune
   */
  async generateKeyset(
    runeId: string,
    unit: string,
    seed?: Uint8Array
  ): Promise<Keyset>

  /**
   * Get private key for amount/keyset
   */
  getPrivateKey(keysetId: string, amount: number): Uint8Array

  /**
   * Get public keys for keyset
   */
  getPublicKeys(keysetId: string): MintKeys

  /**
   * List all active keysets
   */
  getActiveKeysets(): Keyset[]

  /**
   * Rotate keyset (deprecate old, create new)
   */
  async rotateKeyset(oldKeysetId: string): Promise<Keyset>
}
```

**Implementation Pattern**:
```typescript
import { createNewMintKeys, deriveKeysetId } from '@cashu/cashu-ts'

export class KeyManager {
  async generateKeyset(
    runeId: string,
    unit: string,
    seed?: Uint8Array
  ): Promise<Keyset> {
    // Use cashu-ts to generate keys (up to 2^32)
    const { privateKeys, publicKeys } = createNewMintKeys(32, seed)

    // Derive keyset ID
    const id = deriveKeysetId(publicKeys, unit)

    // Store in database (encrypted)
    const keyset = await this.keysetRepo.create({
      id,
      unit,
      rune_id: runeId,
      active: true,
      private_keys: await this.encrypt(privateKeys),
      public_keys: publicKeys,
      created_at: Date.now()
    })

    return keyset
  }
}
```

### 3. Mint Service (`src/core/services/MintService.ts`)

**Responsibilities**:
- Handle mint quote creation
- Monitor quote payment status
- Issue tokens after payment

**Interface**:
```typescript
export class MintService {
  /**
   * Create mint quote for Runes deposit
   */
  async createMintQuote(
    amount: number,
    unit: string,
    runeId: string
  ): Promise<MintQuoteResponse>

  /**
   * Get mint quote status
   */
  async getMintQuoteStatus(quoteId: string): Promise<MintQuoteResponse>

  /**
   * Mint tokens (after quote paid)
   */
  async mintTokens(
    quoteId: string,
    outputs: BlindedMessage[]
  ): Promise<{ signatures: BlindSignature[] }>
}
```

### 4. Swap Service (`src/core/services/SwapService.ts`)

**Responsibilities**:
- Verify input proofs
- Check not already spent
- Sign output blinded messages
- Mark inputs as spent atomically

**Interface**:
```typescript
export class SwapService {
  /**
   * Swap proofs for new blinded messages
   */
  async swap(
    inputs: Proof[],
    outputs: BlindedMessage[]
  ): Promise<{ signatures: BlindSignature[] }>
}
```

**Critical Pattern** (atomic double-spend prevention):
```typescript
async swap(inputs: Proof[], outputs: BlindedMessage[]): Promise<{ signatures: BlindSignature[] }> {
  return await this.db.transaction(async (trx) => {
    // 1. Verify all proofs
    for (const proof of inputs) {
      if (!this.crypto.verifyProof(proof)) {
        throw new Error('Invalid proof signature')
      }
    }

    // 2. Check proofs not spent (atomic)
    const Y_values = inputs.map(p => this.crypto.hashSecret(p.secret))
    const spent = await this.proofRepo.checkSpent(Y_values, trx)
    if (spent.length > 0) {
      throw new Error('Proof already spent')
    }

    // 3. Mark proofs as spent
    await this.proofRepo.markSpent(inputs, trx)

    // 4. Sign outputs
    const signatures = outputs.map(output =>
      this.crypto.signBlindedMessage(output)
    )

    return { signatures }
  })
}
```

### 5. Runes Backend (`src/runes/RunesBackend.ts`)

**Responsibilities**:
- Generate deposit addresses
- Monitor blockchain for deposits
- Process withdrawals
- Manage mint's Runes UTXOs

**Interface**:
```typescript
export interface IRunesBackend {
  /**
   * Create Runes deposit address for quote
   */
  createDepositAddress(
    quoteId: string,
    amount: number,
    runeId: string
  ): Promise<string>

  /**
   * Check if deposit received
   */
  checkDeposit(quoteId: string): Promise<{
    confirmed: boolean
    amount?: number
    txid?: string
    confirmations: number
  }>

  /**
   * Estimate fee for Runes withdrawal
   */
  estimateFee(
    destination: string,
    amount: number,
    runeId: string
  ): Promise<number>

  /**
   * Send Runes to destination
   */
  sendRunes(
    destination: string,
    amount: number,
    runeId: string
  ): Promise<{
    txid: string
    fee_paid: number
  }>

  /**
   * Get mint's current Runes balance
   */
  getBalance(runeId: string): Promise<number>
}
```

**Implementation integrates with Ducat**:
```typescript
import { createUnitIntent } from '@ducat-unit/client-sdk'
import { encodeRunestone } from '../../../app/app/runestone-encoder'

export class RunesBackend implements IRunesBackend {
  async sendRunes(
    destination: string,
    amount: number,
    runeId: string
  ): Promise<{ txid: string; fee_paid: number }> {
    // Reuse Ducat's Runes transaction construction
    const { psbt, fee } = await createUnitIntent(
      destination,
      amount,
      this.mintTaprootAddress,
      this.mintSegwitAddress,
      this.currentAccount,
      this.unconfirmedTaprootUtxos,
      this.unconfirmedSegwitUtxos,
      this.spentUtxos
    )

    // Sign and broadcast
    const signedPsbt = await this.signer.sign(psbt)
    const txid = await this.broadcast(signedPsbt)

    return { txid, fee_paid: fee }
  }
}
```

---

## Data Models

### cashu-ts Types (Re-exported)

```typescript
// src/types/cashu.ts
export type {
  Proof,
  BlindedMessage,
  BlindSignature,
  Token,
  MintKeys,
  MintKeyset,
  MintQuoteResponse,
  MeltQuoteResponse,
  SerializedDLEQ
} from '@cashu/cashu-ts'
```

### Custom Domain Models

**Keyset** (`src/core/models/Keyset.ts`):
```typescript
export interface Keyset {
  id: string                           // Keyset ID (14 chars hex)
  unit: string                         // "sat" or "RUNE"
  rune_id: string                      // "840000:3" (DUCAT•UNIT•RUNE)
  active: boolean
  private_keys: Record<number, string> // amount -> hex privkey (encrypted)
  public_keys: Record<number, string>  // amount -> hex pubkey
  input_fee_ppk?: number               // Input fee (parts per thousand)
  final_expiry?: number                // Unix timestamp
  created_at: number
}
```

**Mint Quote** (`src/core/models/Quote.ts`):
```typescript
export interface MintQuote {
  id: string                    // Quote ID
  amount: number                // Amount to mint
  unit: string                  // Unit type
  rune_id: string               // Rune identifier
  request: string               // Deposit address
  state: MintQuoteState         // UNPAID | PAID | ISSUED
  expiry: number                // Unix timestamp
  created_at: number
  paid_at?: number
  txid?: string                 // Runes deposit txid
  vout?: number                 // Runes deposit vout
}

export type MintQuoteState = 'UNPAID' | 'PAID' | 'ISSUED'
```

**Melt Quote** (`src/core/models/Quote.ts`):
```typescript
export interface MeltQuote {
  id: string
  amount: number
  fee_reserve: number           // Reserved for miner fees
  unit: string
  rune_id: string
  request: string               // Destination address
  state: MeltQuoteState         // UNPAID | PENDING | PAID
  expiry: number
  created_at: number
  paid_at?: number
  txid?: string                 // Runes withdrawal txid
  fee_paid?: number             // Actual fee paid
}

export type MeltQuoteState = 'UNPAID' | 'PENDING' | 'PAID'
```

**Proof Record** (`src/core/models/Proof.ts`):
```typescript
export interface ProofRecord {
  Y: string                     // hash_to_curve(secret) - primary key
  keyset_id: string
  amount: number
  secret: string                // Original secret
  C: string                     // Signature point
  witness?: string              // P2PK witness, HTLC witness
  state: ProofState             // UNSPENT | PENDING | SPENT
  spent_at?: number
  transaction_id?: string       // Quote ID or swap ID
}

export type ProofState = 'UNSPENT' | 'PENDING' | 'SPENT'
```

---

## API Endpoints

### Standard Cashu Endpoints

All endpoints follow cashu-ts patterns exactly.

#### GET /v1/info (NUT-06)

**Response**:
```typescript
{
  name: "Ducat Runes Mint",
  pubkey: "02abc123...",
  version: "1.0.0",
  description: "Cashu ecash backed by Bitcoin Runes",
  description_long: "Exchange DUCAT•UNIT•RUNE for private, instant ecash",
  contact: [
    { method: "email", info: "support@ducatprotocol.com" },
    { method: "nostr", info: "npub..." }
  ],
  motd: "Welcome to Ducat Runes Mint!",
  nuts: {
    "4": {
      methods: [
        {
          method: "runes",  // Custom method
          unit: "sat",
          min_amount: 100,
          max_amount: 100000000
        }
      ],
      disabled: false
    },
    "5": {
      methods: [
        {
          method: "runes",
          unit: "sat",
          min_amount: 100,
          max_amount: 100000000
        }
      ],
      disabled: false
    },
    "7": { supported: true },
    "8": { supported: true },
    "9": { supported: true },
    "12": { supported: true }
  }
}
```

#### GET /v1/keys (NUT-01)

**Response**:
```typescript
{
  keysets: {
    "00abc123def456": {  // Keyset ID
      "1": "02a1b2c3...",
      "2": "02d4e5f6...",
      "4": "02g7h8i9...",
      // ... powers of 2
    }
  }
}
```

#### POST /v1/swap (NUT-03)

**Request**:
```typescript
{
  inputs: Proof[],
  outputs: BlindedMessage[]
}
```

**Response**:
```typescript
{
  signatures: BlindSignature[]
}
```

### Runes-Specific Endpoints

#### POST /v1/mint/quote/runes (NUT-04 extension)

**Request**:
```typescript
{
  unit: "sat",
  amount: 1000,
  rune_id: "840000:3"  // Custom field
}
```

**Response**:
```typescript
{
  quote: "quote_abc123",
  request: "bc1p...",  // Runes deposit address (not invoice!)
  state: "UNPAID",
  expiry: 1234567890,
  amount: 1000,
  unit: "sat"
}
```

#### GET /v1/mint/quote/runes/:quote_id

**Response**:
```typescript
{
  quote: "quote_abc123",
  request: "bc1p...",
  state: "PAID",  // Updated when Runes received
  expiry: 1234567890,
  amount: 1000,
  unit: "sat"
}
```

#### POST /v1/mint/runes (NUT-04 extension)

**Request**:
```typescript
{
  quote: "quote_abc123",
  outputs: BlindedMessage[]
}
```

**Response**:
```typescript
{
  signatures: BlindSignature[]
}
```

#### POST /v1/melt/quote/runes (NUT-05 extension)

**Request**:
```typescript
{
  unit: "sat",
  amount: 1000,
  request: "bc1p...",  // Destination Runes address
  rune_id: "840000:3"
}
```

**Response**:
```typescript
{
  quote: "melt_def456",
  amount: 1000,
  fee_reserve: 500,  // Estimated miner fee
  state: "UNPAID",
  expiry: 1234567890,
  request: "bc1p...",
  unit: "sat"
}
```

#### POST /v1/melt/runes (NUT-05 extension)

**Request**:
```typescript
{
  quote: "melt_def456",
  inputs: Proof[],
  outputs: BlindedMessage[]  // For change from fee_reserve
}
```

**Response**:
```typescript
{
  quote: "melt_def456",
  state: "PAID",
  txid: "abc123...",  // Runes transaction ID (not preimage!)
  change: BlindSignature[]  // Unused fee_reserve returned
}
```

---

## Cryptography Layer

### BDHKE (Blind Diffie-Hellman Key Exchange)

We use cashu-ts implementation directly:

```typescript
import {
  hashToCurve,
  createBlindSignature,
  unblindSignature,
  verifyProof
} from '@cashu/cashu-ts'
```

### Key Derivation

**Deterministic Keysets** (from seed):
```typescript
import { createNewMintKeys, deriveKeysetId } from '@cashu/cashu-ts'

const seed = process.env.MINT_SEED  // 32 bytes hex
const { privateKeys, publicKeys } = createNewMintKeys(32, hexToBytes(seed))
const keysetId = deriveKeysetId(publicKeys, 'sat')
```

**Keyset ID Derivation**:
- Concatenate public keys (sorted by amount)
- Hash with SHA256
- Take first 14 characters (hex)

### DLEQ Proofs (NUT-12)

Optional but recommended for trustless verification:

```typescript
import { createDLEQProof, verifyDLEQProof } from '@cashu/cashu-ts'

const signature = createBlindSignature(B_, privateKey, amount, keysetId)
signature.dleq = createDLEQProof(B_, privateKey)
```

**Warning**: cashu-ts DLEQ creation is **not constant-time** (timing attack risk). For production, consider:
- Isolating mint in secure environment
- Rate limiting
- Adding random delays

### P2PK Support (NUT-11)

For locked ecash (future feature):

```typescript
import { createP2PKsecret, signP2PKSecret, verifyP2PKSecretSignature } from '@cashu/cashu-ts'

// Create P2PK secret
const secret = createP2PKsecret(recipientPubkey)

// Spend requires Schnorr signature
const witness = { signatures: [signP2PKSecret(secret, privateKey)] }
const proof = { ...baseProof, secret, witness }
```

---

## Payment Backend

### Interface Definition

```typescript
// src/runes/IPaymentBackend.ts
export interface IPaymentBackend {
  // Quote lifecycle
  createMintQuote(amount: number, unit: string, runeId: string): Promise<MintQuoteData>
  checkMintQuote(quoteId: string): Promise<MintQuoteStatus>
  createMeltQuote(amount: number, unit: string, request: string, runeId: string): Promise<MeltQuoteData>

  // Payments
  processMelt(quoteId: string): Promise<MeltResult>

  // Balance
  getBalance(runeId: string): Promise<number>
}

export interface MintQuoteData {
  quote_id: string
  deposit_address: string
  rune_id: string
  expiry: number
}

export interface MintQuoteStatus {
  paid: boolean
  amount?: number
  txid?: string
  confirmations: number
}

export interface MeltQuoteData {
  quote_id: string
  fee_estimate: number
}

export interface MeltResult {
  txid: string
  fee_paid: number
}
```

### Runes Implementation

```typescript
// src/runes/RunesBackend.ts
export class RunesBackend implements IPaymentBackend {
  constructor(
    private ordIndexer: OrdIndexerClient,
    private esplora: EsploraClient,
    private wallet: RunesWallet,
    private utxoManager: UtxoManager
  ) {}

  async createMintQuote(
    amount: number,
    unit: string,
    runeId: string
  ): Promise<MintQuoteData> {
    // Generate unique deposit address
    const depositAddress = await this.wallet.generateAddress()

    // Create quote ID
    const quote_id = randomBytes(16).toString('hex')

    // Store mapping (quote -> address)
    await this.depositMonitor.trackDeposit(quote_id, depositAddress, amount, runeId)

    return {
      quote_id,
      deposit_address: depositAddress,
      rune_id: runeId,
      expiry: Date.now() + 24 * 60 * 60 * 1000  // 24 hours
    }
  }

  async checkMintQuote(quoteId: string): Promise<MintQuoteStatus> {
    const quote = await this.depositMonitor.getQuote(quoteId)

    // Query Ord indexer for Runes transfers to address
    const transfers = await this.ordIndexer.getRunesTransfers(
      quote.address,
      quote.rune_id
    )

    if (transfers.length === 0) {
      return { paid: false, confirmations: 0 }
    }

    const transfer = transfers[0]  // Most recent

    // Check confirmations
    const tx = await this.esplora.getTransaction(transfer.txid)
    const confirmations = tx.status.confirmed
      ? tx.status.block_height - tx.status.block_height + 1
      : 0

    return {
      paid: confirmations >= 1,  // Require 1 confirmation
      amount: transfer.amount,
      txid: transfer.txid,
      confirmations
    }
  }

  async processMelt(quoteId: string): Promise<MeltResult> {
    const quote = await this.meltQuotes.get(quoteId)

    // Build Runes transaction
    const { psbt, fee } = await this.buildRunesTransaction(
      quote.request,  // destination
      quote.amount,
      quote.rune_id
    )

    // Sign and broadcast
    const signed = await this.wallet.signPsbt(psbt)
    const txid = await this.esplora.broadcast(signed.extractTransaction())

    // Track UTXO spent
    await this.utxoManager.markSpent(psbt.data.inputs)

    return { txid, fee_paid: fee }
  }

  private async buildRunesTransaction(
    destination: string,
    amount: number,
    runeId: string
  ): Promise<{ psbt: bitcoin.Psbt; fee: number }> {
    // Reuse Ducat's runestone-encoder and UTXO selection
    // (Implementation details in separate section)
  }
}
```

---

## Database Schema

### PostgreSQL Schema

```sql
-- migrations/001_initial.sql

-- Keysets
CREATE TABLE keysets (
  id VARCHAR(14) PRIMARY KEY,
  unit VARCHAR(20) NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  private_keys JSONB NOT NULL,  -- Encrypted: {1: "hex", 2: "hex", ...}
  public_keys JSONB NOT NULL,   -- {1: "hex", 2: "hex", ...}
  input_fee_ppk INTEGER DEFAULT 0,
  final_expiry BIGINT,
  created_at BIGINT NOT NULL
);

CREATE INDEX idx_keysets_active ON keysets(active, unit);
CREATE INDEX idx_keysets_rune ON keysets(rune_id);

-- Mint quotes
CREATE TABLE mint_quotes (
  id VARCHAR(64) PRIMARY KEY,
  amount BIGINT NOT NULL,
  unit VARCHAR(20) NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  request TEXT NOT NULL,  -- Deposit address
  state VARCHAR(20) NOT NULL CHECK (state IN ('UNPAID', 'PAID', 'ISSUED')),
  expiry BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  paid_at BIGINT,
  txid VARCHAR(64),
  vout INTEGER
);

CREATE INDEX idx_mint_quotes_state ON mint_quotes(state, expiry);
CREATE INDEX idx_mint_quotes_request ON mint_quotes(request);

-- Melt quotes
CREATE TABLE melt_quotes (
  id VARCHAR(64) PRIMARY KEY,
  amount BIGINT NOT NULL,
  fee_reserve BIGINT NOT NULL,
  unit VARCHAR(20) NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  request TEXT NOT NULL,  -- Destination address
  state VARCHAR(20) NOT NULL CHECK (state IN ('UNPAID', 'PENDING', 'PAID')),
  expiry BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  paid_at BIGINT,
  txid VARCHAR(64),
  fee_paid BIGINT
);

CREATE INDEX idx_melt_quotes_state ON melt_quotes(state, expiry);

-- Proofs (spent tracking)
CREATE TABLE proofs (
  Y VARCHAR(66) PRIMARY KEY,  -- hash_to_curve(secret) in hex
  keyset_id VARCHAR(14) NOT NULL REFERENCES keysets(id),
  amount BIGINT NOT NULL,
  secret TEXT NOT NULL,
  C VARCHAR(66) NOT NULL,  -- Signature point in hex
  witness TEXT,
  state VARCHAR(20) NOT NULL CHECK (state IN ('UNSPENT', 'PENDING', 'SPENT')),
  spent_at BIGINT,
  transaction_id VARCHAR(64)  -- Quote ID or swap ID
);

CREATE INDEX idx_proofs_state ON proofs(state);
CREATE INDEX idx_proofs_keyset ON proofs(keyset_id);
CREATE UNIQUE INDEX idx_proofs_secret ON proofs(secret);  -- Backup double-spend check

-- Mint UTXOs (reserve tracking)
CREATE TABLE mint_utxos (
  txid VARCHAR(64) NOT NULL,
  vout INTEGER NOT NULL,
  rune_id VARCHAR(50) NOT NULL,
  amount BIGINT NOT NULL,
  address VARCHAR(100) NOT NULL,
  spent BOOLEAN NOT NULL DEFAULT false,
  spent_in_txid VARCHAR(64),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (txid, vout)
);

CREATE INDEX idx_mint_utxos_rune ON mint_utxos(rune_id, spent);
CREATE INDEX idx_mint_utxos_address ON mint_utxos(address);
```

### Repository Pattern

```typescript
// src/database/repositories/ProofRepository.ts
export class ProofRepository {
  constructor(private db: Database) {}

  /**
   * Check if proofs are spent (atomic)
   */
  async checkSpent(
    Y_values: string[],
    trx?: Transaction
  ): Promise<string[]> {
    const query = `
      SELECT Y FROM proofs
      WHERE Y = ANY($1) AND state != 'UNSPENT'
    `
    const result = await (trx || this.db).query(query, [Y_values])
    return result.rows.map(r => r.Y)
  }

  /**
   * Mark proofs as spent (atomic)
   */
  async markSpent(
    proofs: Proof[],
    transactionId: string,
    trx?: Transaction
  ): Promise<void> {
    const values = proofs.map(p => [
      this.hashSecret(p.secret),  // Y
      p.id,                        // keyset_id
      p.amount,
      p.secret,
      p.C,
      p.witness,
      'SPENT',
      Date.now(),
      transactionId
    ])

    await (trx || this.db).query(`
      INSERT INTO proofs (Y, keyset_id, amount, secret, C, witness, state, spent_at, transaction_id)
      VALUES ${values.map((_, i) => `($${i * 9 + 1}, $${i * 9 + 2}, ...)`).join(',')}
    `, values.flat())
  }

  private hashSecret(secret: string): string {
    // Use cashu-ts hashToCurve
    const Y = hashToCurve(Buffer.from(secret, 'utf8'))
    return Y.toHex()
  }
}
```

---

## Code Standards

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### Naming Conventions

**Follow cashu-ts patterns**:
- `PascalCase`: Classes, interfaces, types, enums
- `camelCase`: Functions, methods, variables, parameters
- `SCREAMING_SNAKE_CASE`: Constants
- Private members: `private` keyword (not `_prefix`)

**File naming**:
- `PascalCase.ts`: Classes (`MintService.ts`)
- `camelCase.ts`: Utilities (`helpers.ts`)
- `kebab-case.ts`: Multi-word utilities (`error-handler.ts`)

### Error Handling

**Custom error classes**:
```typescript
// src/utils/errors.ts
export class MintError extends Error {
  constructor(
    message: string,
    public code: number,
    public detail?: string
  ) {
    super(message)
    this.name = 'MintError'
  }
}

export class ProofAlreadySpentError extends MintError {
  constructor(Y: string) {
    super('Proof already spent', 11001, `Y=${Y}`)
  }
}

export class QuoteNotPaidError extends MintError {
  constructor(quoteId: string) {
    super('Quote not paid', 10001, `quote=${quoteId}`)
  }
}
```

**Error response format** (NUT-00):
```typescript
{
  error: "Proof already spent",
  code: 11001,
  detail: "Y=02abc123..."
}
```

### Logging

**Structured logging**:
```typescript
// src/utils/logger.ts
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
})

// Usage
logger.info({ quoteId, amount }, 'Mint quote created')
logger.error({ err, proofY }, 'Proof verification failed')
```

---

## Testing Strategy

### Unit Tests

**Crypto operations**:
```typescript
// tests/unit/crypto/MintCrypto.test.ts
import { describe, test, expect } from 'vitest'
import { MintCrypto } from '../../../src/core/crypto/MintCrypto'

describe('MintCrypto', () => {
  test('signs blinded message correctly', () => {
    const crypto = new MintCrypto(mockKeyManager)

    const blindedMsg = {
      amount: 8,
      B_: '02abc123...',
      id: 'keyset_id'
    }

    const signature = crypto.signBlindedMessage(blindedMsg)

    expect(signature.amount).toBe(8)
    expect(signature.C_).toMatch(/^02[0-9a-f]{64}$/)
    expect(signature.id).toBe('keyset_id')
  })

  test('verifies valid proof', () => {
    const crypto = new MintCrypto(mockKeyManager)

    const proof = {
      id: 'keyset_id',
      amount: 8,
      secret: 'test_secret',
      C: '02def456...',
      witness: undefined
    }

    expect(crypto.verifyProof(proof)).toBe(true)
  })
})
```

### Integration Tests

**Full mint flow**:
```typescript
// tests/integration/mint.test.ts
import { describe, test, expect, beforeAll } from 'vitest'
import { Wallet } from '@cashu/cashu-ts'

describe('Mint Flow', () => {
  let mintUrl: string
  let wallet: Wallet

  beforeAll(async () => {
    // Start test server
    mintUrl = await startTestMint()
    wallet = new Wallet(mintUrl, { unit: 'sat' })
    await wallet.loadMint()
  })

  test('complete mint cycle', async () => {
    // 1. Create quote
    const quote = await wallet.createMintQuote({
      amount: 1000,
      unit: 'sat'
    })

    expect(quote.request).toMatch(/^bc1p/)  // Runes address
    expect(quote.state).toBe('UNPAID')

    // 2. Simulate Runes payment
    await simulateRunesDeposit(quote.request, 1000)

    // 3. Check quote status
    const updated = await wallet.getMintQuote(quote.quote)
    expect(updated.state).toBe('PAID')

    // 4. Mint tokens
    const { proofs } = await wallet.mintProofs(1000, quote.quote)

    expect(proofs.length).toBeGreaterThan(0)
    expect(sumProofs(proofs)).toBe(1000)
  })
})
```

### Mocking Strategy

**Mock Runes backend**:
```typescript
// tests/fixtures/mocks.ts
export class MockRunesBackend implements IPaymentBackend {
  private deposits = new Map<string, { amount: number; paid: boolean }>()

  async createMintQuote(amount: number, unit: string, runeId: string) {
    const quote_id = randomBytes(16).toString('hex')
    const deposit_address = 'bc1p' + randomBytes(32).toString('hex')

    this.deposits.set(deposit_address, { amount, paid: false })

    return { quote_id, deposit_address, rune_id: runeId, expiry: Date.now() + 3600000 }
  }

  async simulatePayment(address: string) {
    const deposit = this.deposits.get(address)
    if (deposit) deposit.paid = true
  }

  async checkMintQuote(quoteId: string) {
    // Return mock status
  }
}
```

---

## NUT Implementation Plan

### Phase 1: Core Protocol (Essential)

**NUT-00: Cryptography basics**
- Status: ✅ Provided by cashu-ts
- Implementation: Reuse library functions

**NUT-01: Mint public keys**
- Endpoint: `GET /v1/keys`, `GET /v1/keys/:id`
- Implementation: Query keysets from database

**NUT-02: Keyset IDs**
- Status: ✅ Provided by cashu-ts
- Implementation: Use `deriveKeysetId()`

**NUT-03: Swap proofs**
- Endpoint: `POST /v1/swap`
- Implementation: SwapService (atomic double-spend check)

**NUT-04: Mint tokens**
- Endpoints:
  - `POST /v1/mint/quote/runes`
  - `GET /v1/mint/quote/runes/:id`
  - `POST /v1/mint/runes`
- Implementation: MintService + RunesBackend

**NUT-05: Melt tokens**
- Endpoints:
  - `POST /v1/melt/quote/runes`
  - `GET /v1/melt/quote/runes/:id`
  - `POST /v1/melt/runes`
- Implementation: MeltService + RunesBackend

**NUT-06: Mint info**
- Endpoint: `GET /v1/info`
- Implementation: Static config + dynamic keyset list

### Phase 2: User Experience (Recommended)

**NUT-07: Check proof state**
- Endpoint: `POST /v1/checkstate`
- Implementation: Query proofs table

**NUT-08: Lightning fee return**
- Adapt for Runes miner fees
- Return unused `fee_reserve` as change

**NUT-09: Restore proofs**
- Endpoint: `POST /v1/restore`
- Implementation: Query proofs by output descriptors

### Phase 3: Advanced Features (Optional)

**NUT-11: Pay-to-Public-Key (P2PK)**
- Locked ecash requiring signature to spend
- Implementation: Verify Schnorr signatures in witness

**NUT-12: DLEQ proofs**
- Trustless proof verification
- Implementation: Use cashu-ts `createDLEQProof()`

**NUT-17: WebSocket subscriptions**
- Real-time quote status updates
- Implementation: Socket.io or native WebSockets

---

## Next Steps

1. **Initialize project** (Week 1)
   - Set up Node.js/TypeScript
   - Install dependencies (`@cashu/cashu-ts`, `fastify`, `pg`)
   - Configure database (PostgreSQL)

2. **Implement crypto layer** (Week 1)
   - MintCrypto wrapper
   - KeyManager with database persistence
   - Unit tests

3. **Build core services** (Week 2)
   - MintService
   - SwapService
   - QuoteService
   - Integration tests

4. **Runes integration** (Week 3-4)
   - RunesBackend implementation
   - Deposit monitoring (Ord indexer)
   - Withdrawal processing (PSBT construction)
   - UTXO management

5. **API layer** (Week 5)
   - Fastify routes
   - Request validation
   - Error handling
   - Rate limiting

6. **Testing & deployment** (Week 6)
   - End-to-end tests with cashu-ts wallet
   - Docker setup
   - Production deployment

---

## References

- [Cashu Protocol Specs (NUTs)](https://github.com/cashubtc/nuts)
- [cashu-ts Repository](https://github.com/cashubtc/cashu-ts)
- [Bitcoin Runes Documentation](https://docs.ordinals.com/runes.html)
- [Ducat Protocol](https://ducatprotocol.com)

---

**Last Updated**: 2025-11-18
