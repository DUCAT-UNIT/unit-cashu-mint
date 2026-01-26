# Multi-Unit Support: BTC + Runes Implementation Plan

## Overview

This plan adds support for both BTC (satoshis) and Runes as ecash units in the mint server. Currently the codebase is hardcoded for Runes only. After implementation, users can mint/melt ecash backed by either Bitcoin or Runes.

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                      Service Layer                          │
│  (MintService, MeltService, SwapService, CheckStateService) │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    BackendRegistry                          │
│              get(unit) → IPaymentBackend                    │
└─────────────┬───────────────────────────────┬───────────────┘
              │                               │
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────────┐
│      BTCBackend         │     │       RunesBackend          │
│  (unit: 'btc'/'sat')    │     │      (unit: 'rune')         │
├─────────────────────────┤     ├─────────────────────────────┤
│ - EsploraClient         │     │ - OrdClient                 │
│ - Simple TX builder     │     │ - EsploraClient             │
│ - No UTXO tracking      │     │ - RunesPsbtBuilder          │
│                         │     │ - UtxoManager               │
└─────────────────────────┘     └─────────────────────────────┘
```

---

## Phase 1: Payment Backend Abstraction

### Task 1.1: Create Abstract Interface
**File:** `src/core/payment/types.ts` (NEW)

```typescript
export interface DepositStatus {
  confirmed: boolean
  amount?: bigint
  txid?: string
  vout?: number
  confirmations: number
}

export interface WithdrawalResult {
  txid: string
  fee_paid: number
}

export interface IPaymentBackend {
  readonly unit: string
  createDepositAddress(quoteId: string, amount: bigint): Promise<string>
  checkDeposit(quoteId: string, address: string, includeTracked?: boolean): Promise<DepositStatus>
  verifySpecificDeposit(quoteId: string, txid: string, vout: number): Promise<DepositStatus>
  estimateFee(destination: string, amount: bigint): Promise<number>
  withdraw(destination: string, amount: bigint): Promise<WithdrawalResult>
  getBalance(): Promise<bigint>
  syncUtxos?(): Promise<void>  // Optional - only Runes needs this
}
```

### Task 1.2: Create Backend Registry
**File:** `src/core/payment/BackendRegistry.ts` (NEW)

```typescript
export class BackendRegistry {
  private backends = new Map<string, IPaymentBackend>()

  register(backend: IPaymentBackend): void {
    this.backends.set(backend.unit, backend)
  }

  get(unit: string): IPaymentBackend {
    const backend = this.backends.get(unit)
    if (!backend) {
      throw new MintError(`Unsupported unit: ${unit}`, 'UNSUPPORTED_UNIT')
    }
    return backend
  }

  getAll(): IPaymentBackend[] {
    return Array.from(this.backends.values())
  }

  has(unit: string): boolean {
    return this.backends.has(unit)
  }
}
```

### Task 1.3: Create Index Export
**File:** `src/core/payment/index.ts` (NEW)

Export all payment types and classes.

---

## Phase 2: Refactor RunesBackend

### Task 2.1: Update RunesBackend to Implement IPaymentBackend
**File:** `src/runes/RunesBackend.ts` (MODIFY)

Changes:
1. Remove old `IPaymentBackend` interface from this file
2. Import new `IPaymentBackend` from `src/core/payment/types.ts`
3. Add `readonly unit = 'sat'` property
4. Rename `sendRunes()` → `withdraw()` (keep old as alias for compatibility)
5. Update return types to use new `DepositStatus` and `WithdrawalResult`

### Task 2.2: Update Runes Types
**File:** `src/runes/types.ts` (MODIFY)

- Keep `RunesDepositStatus` for internal use
- Add conversion function to `DepositStatus`

---

## Phase 3: Create BTCBackend

### Task 3.1: Create BTC Types
**File:** `src/btc/types.ts` (NEW)

```typescript
export interface BTCConfig {
  mintAddress: string        // P2WPKH address for deposits
  mintPubkey: string         // Public key for signing
  feeRate: number            // sats/vbyte
  network: string
}
```

### Task 3.2: Create BTC Transaction Builder
**File:** `src/btc/tx-builder.ts` (NEW)

Simple Bitcoin transaction builder:
- Input: P2WPKH UTXOs
- Output: Recipient + change
- Fee calculation based on tx size
- Sign with WalletKeyManager

### Task 3.3: Create BTCBackend
**File:** `src/btc/BTCBackend.ts` (NEW)

```typescript
export class BTCBackend implements IPaymentBackend {
  readonly unit = 'btc'

  constructor(
    private esploraClient: EsploraClient,
    private walletKeyManager: WalletKeyManager,
    private config: BTCConfig
  ) {}

  async createDepositAddress(quoteId: string, amount: bigint): Promise<string> {
    // Return mint's BTC address
    // Could derive per-quote address for better tracking
    return this.config.mintAddress
  }

  async checkDeposit(quoteId: string, address: string): Promise<DepositStatus> {
    // Query Esplora for UTXOs at address
    // Sum confirmed satoshis
    // Return deposit status
  }

  async verifySpecificDeposit(quoteId: string, txid: string, vout: number): Promise<DepositStatus> {
    // Verify specific UTXO exists and has enough confirmations
  }

  async estimateFee(destination: string, amount: bigint): Promise<number> {
    // Estimate fee based on tx size and fee rate
    // Simple P2WPKH → P2WPKH is ~110 vbytes
  }

  async withdraw(destination: string, amount: bigint): Promise<WithdrawalResult> {
    // 1. Get UTXOs from mint address
    // 2. Build transaction with BTCTxBuilder
    // 3. Sign with wallet key
    // 4. Broadcast via Esplora
    // 5. Return txid and fee paid
  }

  async getBalance(): Promise<bigint> {
    // Sum all UTXOs at mint address
  }
}
```

### Task 3.4: Create BTC Index Export
**File:** `src/btc/index.ts` (NEW)

---

## Phase 4: Update Configuration

### Task 4.1: Update Environment Config
**File:** `src/config/env.ts` (MODIFY)

Add new environment variables:
```typescript
// Units configuration
SUPPORTED_UNITS: z.string().default('sat'),  // 'btc', 'sat', or 'btc,sat'

// BTC-specific (required if 'btc' in SUPPORTED_UNITS)
MINT_BTC_ADDRESS: z.string().optional(),
MINT_BTC_PRIVKEY: z.string().optional(),  // Or derive from MINT_SEED
BTC_FEE_RATE: z.coerce.number().default(5),

// Rename/clarify existing
// MINT_TAPROOT_ADDRESS → used for Runes
// MINT_SEGWIT_ADDRESS → used for fees (both units)
```

Add validation:
```typescript
// Validate BTC config if unit enabled
if (supportedUnits.includes('btc')) {
  if (!MINT_BTC_ADDRESS) {
    throw new Error('MINT_BTC_ADDRESS required when btc unit is enabled')
  }
}

// Validate Runes config if unit enabled
if (supportedUnits.includes('sat')) {
  if (!SUPPORTED_RUNES) {
    throw new Error('SUPPORTED_RUNES required when sat unit is enabled')
  }
}
```

---

## Phase 5: Update DI Container

### Task 5.1: Update Container Registration
**File:** `src/di/container.ts` (MODIFY)

```typescript
// Create backend registry
const backendRegistry = new BackendRegistry()

// Register BTC backend if enabled
if (env.SUPPORTED_UNITS.includes('btc')) {
  const btcBackend = new BTCBackend(esploraClient, walletKeyManager, {
    mintAddress: env.MINT_BTC_ADDRESS,
    mintPubkey: env.MINT_BTC_PUBKEY,
    feeRate: env.BTC_FEE_RATE,
    network: env.NETWORK
  })
  backendRegistry.register(btcBackend)
}

// Register Runes backend if enabled
if (env.SUPPORTED_UNITS.includes('sat')) {
  const runesBackend = new RunesBackend(...)
  backendRegistry.register(runesBackend)
}

container.register('backendRegistry', backendRegistry)
```

---

## Phase 6: Update Core Services

### Task 6.1: Update MintService
**File:** `src/core/services/MintService.ts` (MODIFY)

Changes:
1. Inject `BackendRegistry` instead of `RunesBackend`
2. In `createMintQuote()`: Get backend by unit
3. In `getMintQuote()`: Get backend by quote's unit
4. In `mintTokens()`: Get backend by quote's unit

```typescript
// Before
constructor(
  private runesBackend: RunesBackend,
  ...
)

// After
constructor(
  private backendRegistry: BackendRegistry,
  ...
)

// In createMintQuote:
const backend = this.backendRegistry.get(unit)
const depositAddress = await backend.createDepositAddress(quoteId, BigInt(amount))

// In mintTokens:
const backend = this.backendRegistry.get(quote.unit)
const depositStatus = await backend.verifySpecificDeposit(...)
```

### Task 6.2: Update MeltService
**File:** `src/core/services/MeltService.ts` (MODIFY)

Changes:
1. Inject `BackendRegistry` instead of `RunesBackend`
2. In `createMeltQuote()`: Get backend by unit for fee estimation
3. In `meltTokens()`: Get backend by quote's unit for withdrawal

```typescript
// In meltTokens:
const backend = this.backendRegistry.get(quote.unit)
const result = await backend.withdraw(quote.request, BigInt(quote.amount))
```

### Task 6.3: SwapService - No Changes Needed
Already unit-agnostic (works via keyset_id).

### Task 6.4: CheckStateService - No Changes Needed
Already unit-agnostic (works via Y values).

---

## Phase 7: Update Background Services

### Task 7.1: Update DepositMonitor
**File:** `src/services/DepositMonitor.ts` (MODIFY)

Changes:
1. Inject `BackendRegistry` instead of `RunesBackend`
2. In `checkQuote()`: Get backend by quote's unit

```typescript
async checkQuote(quote: MintQuote): Promise<void> {
  const backend = this.backendRegistry.get(quote.unit)
  const status = await backend.checkDeposit(quote.id, quote.request)
  // ... rest unchanged
}
```

### Task 7.2: Update UtxoSyncService
**File:** `src/services/UtxoSyncService.ts` (MODIFY)

Changes:
1. Inject `BackendRegistry`
2. Only sync backends that have `syncUtxos()` method

```typescript
async sync(): Promise<void> {
  for (const backend of this.backendRegistry.getAll()) {
    if (backend.syncUtxos) {
      await backend.syncUtxos()
    }
  }
}
```

### Task 7.3: Update BackgroundTaskManager
**File:** `src/services/BackgroundTaskManager.ts` (MODIFY)

Update to use `BackendRegistry` for initializing services.

---

## Phase 8: Update API

### Task 8.1: Update /v1/info Endpoint
**File:** `src/app.ts` (MODIFY)

Update NUT-4 and NUT-5 to list all supported units:

```typescript
const supportedUnits = env.SUPPORTED_UNITS.split(',')

nuts: {
  '4': {
    methods: supportedUnits.map(unit => ({
      method: unit,
      unit: unit,
      min_amount: env.MIN_MINT_AMOUNT,
      max_amount: env.MAX_MINT_AMOUNT,
    })),
    disabled: false,
  },
  '5': {
    methods: supportedUnits.map(unit => ({
      method: unit,
      unit: unit,
      min_amount: env.MIN_MELT_AMOUNT,
      max_amount: env.MAX_MELT_AMOUNT,
    })),
    disabled: false,
  },
}
```

### Task 8.2: Update Route Validation
**Files:** `src/api/routes/mint.ts`, `src/api/routes/melt.ts` (MODIFY)

Add validation that requested unit is supported:

```typescript
if (!backendRegistry.has(unit)) {
  throw new MintError(`Unsupported unit: ${unit}`, 'UNSUPPORTED_UNIT')
}
```

---

## Phase 9: Database Updates

### Task 9.1: Add Migration for Unit Column
**File:** `src/database/migrations/002_add_unit_to_utxos.sql` (NEW)

```sql
-- Add unit column to mint_utxos (for future multi-rune support)
ALTER TABLE mint_utxos ADD COLUMN IF NOT EXISTS unit VARCHAR(20) NOT NULL DEFAULT 'sat';

-- Update index
DROP INDEX IF EXISTS idx_mint_utxos_rune;
CREATE INDEX idx_mint_utxos_unit_spent ON mint_utxos(unit, spent);
```

### Task 9.2: Update UtxoRepository
**File:** `src/database/repositories/UtxoRepository.ts` (MODIFY if exists, or in UtxoManager)

Add unit filtering to queries.

---

## Phase 10: Testing

### Task 10.1: Unit Tests for BTCBackend
**File:** `src/btc/__tests__/BTCBackend.test.ts` (NEW)

Test:
- `createDepositAddress()` returns valid address
- `checkDeposit()` correctly sums UTXOs
- `withdraw()` builds valid transaction
- `getBalance()` returns correct sum

### Task 10.2: Unit Tests for BackendRegistry
**File:** `src/core/payment/__tests__/BackendRegistry.test.ts` (NEW)

Test:
- Registration works
- `get()` returns correct backend
- `get()` throws for unknown unit
- `has()` returns correct boolean

### Task 10.3: Integration Tests
**File:** `src/__tests__/multi-unit.test.ts` (NEW)

Test full flows:
- BTC mint quote → deposit → mint tokens
- BTC melt quote → burn tokens → withdrawal
- Runes mint quote → deposit → mint tokens
- Runes melt quote → burn tokens → withdrawal
- Swap between same-unit proofs

---

## Implementation Order

Execute tasks in this order to maintain a working codebase:

1. **Phase 1**: Create abstractions (no breaking changes)
2. **Phase 2**: Refactor RunesBackend (implements new interface)
3. **Phase 9**: Database migration (add unit column)
4. **Phase 4**: Update configuration (add new env vars)
5. **Phase 3**: Create BTCBackend
6. **Phase 5**: Update DI container
7. **Phase 6**: Update core services
8. **Phase 7**: Update background services
9. **Phase 8**: Update API
10. **Phase 10**: Testing

---

## Environment Variables Summary

### New Variables
```env
# Units to support (comma-separated: 'btc', 'sat', or 'btc,sat')
SUPPORTED_UNITS=sat

# BTC Backend (required if 'btc' in SUPPORTED_UNITS)
MINT_BTC_ADDRESS=bc1q...
MINT_BTC_PRIVKEY=... (or derive from MINT_SEED)
BTC_FEE_RATE=5
```

### Existing Variables (unchanged)
```env
# Runes Backend (required if 'sat' in SUPPORTED_UNITS)
SUPPORTED_RUNES=840000:3
MINT_TAPROOT_ADDRESS=bc1p...
MINT_SEGWIT_ADDRESS=bc1q...
ORD_URL=https://...
ESPLORA_URL=https://...
```

---

## Files Changed Summary

### New Files (9)
- `src/core/payment/types.ts`
- `src/core/payment/BackendRegistry.ts`
- `src/core/payment/index.ts`
- `src/btc/types.ts`
- `src/btc/tx-builder.ts`
- `src/btc/BTCBackend.ts`
- `src/btc/index.ts`
- `src/database/migrations/002_add_unit_to_utxos.sql`
- `src/__tests__/multi-unit.test.ts`

### Modified Files (10)
- `src/config/env.ts`
- `src/di/container.ts`
- `src/runes/RunesBackend.ts`
- `src/runes/types.ts`
- `src/core/services/MintService.ts`
- `src/core/services/MeltService.ts`
- `src/services/DepositMonitor.ts`
- `src/services/UtxoSyncService.ts`
- `src/services/BackgroundTaskManager.ts`
- `src/app.ts`

### Unchanged Files
- `src/core/services/SwapService.ts` (already unit-agnostic)
- `src/core/services/CheckStateService.ts` (already unit-agnostic)
- `src/core/services/P2PKService.ts` (already unit-agnostic)
- `src/core/crypto/*` (already unit-agnostic)
- `src/runes/UtxoManager.ts` (Runes-specific, stays as-is)
- `src/runes/psbt-builder.ts` (Runes-specific, stays as-is)
- `src/api/routes/*` (minimal changes, validation only)

---

## Rollback Plan

If issues arise:
1. Set `SUPPORTED_UNITS=sat` to disable BTC
2. All Runes functionality remains unchanged
3. BTCBackend is isolated and can be removed without affecting Runes

---

## Implementation Status

### Completed
- [x] Phase 1: Payment Backend Abstraction (types.ts, BackendRegistry.ts, index.ts)
- [x] Phase 2: Refactor RunesBackend (implements IPaymentBackend)
- [x] Phase 3: Create BTCBackend (BTCBackend.ts, tx-builder.ts, types.ts)
- [x] Phase 4: Update Configuration (env.ts with SUPPORTED_UNITS, BTC vars)
- [x] Phase 5: Update DI Container (BackendRegistry registration)
- [x] Phase 6: Update Core Services (MintService, MeltService)
- [x] Phase 7: Update Background Services (DepositMonitor, UtxoSyncService)
- [x] Phase 8: Update API (/v1/info, route validation)

### Remaining
- [ ] Phase 9: Database migration (add unit column to mint_utxos)
- [ ] Phase 10: Testing (unit tests, integration tests)

---

## Success Criteria

- [ ] BTC deposits are detected and credited correctly
- [ ] BTC withdrawals complete successfully
- [x] Runes functionality unchanged (code refactored but logic preserved)
- [x] `/v1/info` shows both units (dynamic based on SUPPORTED_UNITS)
- [x] Keysets are correctly separated by unit (already in keyset derivation)
- [ ] No double-spend possible across units (needs testing)
- [ ] All existing tests pass (needs database for testing)
- [ ] New unit tests pass (needs implementation)
