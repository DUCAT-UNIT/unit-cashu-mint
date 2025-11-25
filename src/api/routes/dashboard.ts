import { FastifyPluginAsync } from 'fastify'
import { query } from '../../database/db.js'
import { env } from '../../config/env.js'

interface DashboardStats {
  // Reserve
  totalReserve: string
  utxoCount: number

  // Quotes
  mintQuotes: {
    unpaid: number
    paid: number
    issued: number
    total: number
  }
  meltQuotes: {
    unpaid: number
    pending: number
    paid: number
    total: number
  }

  // Proofs
  totalProofsSpent: number
  totalAmountSpent: string

  // Keysets
  activeKeysets: number
  totalKeysets: number

  // Recent activity
  recentMints: Array<{
    id: string
    amount: string
    state: string
    created_at: number
  }>
  recentMelts: Array<{
    id: string
    amount: string
    state: string
    created_at: number
  }>

  // System
  uptime: number
  network: string
  runeId: string
  mintName: string
}

export const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  // Dashboard stats API
  fastify.get('/admin/stats', async (_request, reply) => {
    try {
      const stats = await getDashboardStats()
      return reply.code(200).send(stats)
    } catch (error) {
      fastify.log.error(error, 'Failed to get dashboard stats')
      return reply.code(500).send({ error: 'Failed to get stats' })
    }
  })

  // UTXOs API
  fastify.get('/admin/utxos', async (_request, reply) => {
    try {
      const utxos = await getUtxos()
      return reply.code(200).send(utxos)
    } catch (error) {
      fastify.log.error(error, 'Failed to get UTXOs')
      return reply.code(500).send({ error: 'Failed to get UTXOs' })
    }
  })

  // Dashboard HTML page
  fastify.get('/dashboard', async (_request, reply) => {
    reply.type('text/html')
    return reply.send(getDashboardHTML())
  })
}

interface UtxoRecord {
  txid: string
  vout: number
  amount: string
  address: string
  value: number
  spent: boolean
  created_at: number
}

async function getUtxos(): Promise<UtxoRecord[]> {
  const result = await query<{
    txid: string
    vout: number
    amount: string
    address: string
    value: number
    spent: boolean
    created_at: string
  }>(
    `SELECT txid, vout, amount::TEXT, address, value, spent, created_at::TEXT
     FROM mint_utxos
     WHERE spent = false
     ORDER BY created_at DESC`
  )

  return result.rows.map(r => ({
    txid: r.txid,
    vout: r.vout,
    amount: r.amount,
    address: r.address,
    value: r.value,
    spent: r.spent,
    created_at: parseInt(r.created_at)
  }))
}

async function getDashboardStats(): Promise<DashboardStats> {
  // Get reserve balance
  const reserveResult = await query<{ total: string; count: string }>(
    `SELECT COALESCE(SUM(amount::BIGINT), 0)::TEXT as total, COUNT(*)::TEXT as count
     FROM mint_utxos WHERE spent = false`
  )

  // Get mint quote stats
  const mintQuoteResult = await query<{ state: string; count: string }>(
    `SELECT state, COUNT(*)::TEXT as count FROM mint_quotes GROUP BY state`
  )
  const mintQuotes = { unpaid: 0, paid: 0, issued: 0, total: 0 }
  for (const row of mintQuoteResult.rows) {
    if (row.state === 'UNPAID') mintQuotes.unpaid = parseInt(row.count)
    else if (row.state === 'PAID') mintQuotes.paid = parseInt(row.count)
    else if (row.state === 'ISSUED') mintQuotes.issued = parseInt(row.count)
  }
  mintQuotes.total = mintQuotes.unpaid + mintQuotes.paid + mintQuotes.issued

  // Get melt quote stats
  const meltQuoteResult = await query<{ state: string; count: string }>(
    `SELECT state, COUNT(*)::TEXT as count FROM melt_quotes GROUP BY state`
  )
  const meltQuotes = { unpaid: 0, pending: 0, paid: 0, total: 0 }
  for (const row of meltQuoteResult.rows) {
    if (row.state === 'UNPAID') meltQuotes.unpaid = parseInt(row.count)
    else if (row.state === 'PENDING') meltQuotes.pending = parseInt(row.count)
    else if (row.state === 'PAID') meltQuotes.paid = parseInt(row.count)
  }
  meltQuotes.total = meltQuotes.unpaid + meltQuotes.pending + meltQuotes.paid

  // Get proof stats
  const proofResult = await query<{ count: string; total: string }>(
    `SELECT COUNT(*)::TEXT as count, COALESCE(SUM(amount), 0)::TEXT as total
     FROM proofs WHERE state = 'SPENT'`
  )

  // Get keyset stats
  const keysetResult = await query<{ active: string; total: string }>(
    `SELECT
       SUM(CASE WHEN active = true THEN 1 ELSE 0 END)::TEXT as active,
       COUNT(*)::TEXT as total
     FROM keysets`
  )

  // Get recent mints (last 10)
  const recentMintsResult = await query<{ id: string; amount: string; state: string; created_at: string }>(
    `SELECT id, amount::TEXT, state, created_at::TEXT
     FROM mint_quotes ORDER BY created_at DESC LIMIT 10`
  )

  // Get recent melts (last 10)
  const recentMeltsResult = await query<{ id: string; amount: string; state: string; created_at: string }>(
    `SELECT id, amount::TEXT, state, created_at::TEXT
     FROM melt_quotes ORDER BY created_at DESC LIMIT 10`
  )

  return {
    totalReserve: reserveResult.rows[0]?.total || '0',
    utxoCount: parseInt(reserveResult.rows[0]?.count || '0'),
    mintQuotes,
    meltQuotes,
    totalProofsSpent: parseInt(proofResult.rows[0]?.count || '0'),
    totalAmountSpent: proofResult.rows[0]?.total || '0',
    activeKeysets: parseInt(keysetResult.rows[0]?.active || '0'),
    totalKeysets: parseInt(keysetResult.rows[0]?.total || '0'),
    recentMints: recentMintsResult.rows.map(r => ({
      id: r.id,
      amount: r.amount,
      state: r.state,
      created_at: parseInt(r.created_at)
    })),
    recentMelts: recentMeltsResult.rows.map(r => ({
      id: r.id,
      amount: r.amount,
      state: r.state,
      created_at: parseInt(r.created_at)
    })),
    uptime: process.uptime(),
    network: env.NETWORK,
    runeId: env.SUPPORTED_RUNES,
    mintName: env.MINT_NAME,
  }
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mint Dashboard</title>
  <style>
    :root {
      /* Background */
      --bg-primary: #111015;
      --bg-secondary: #1D1C21;
      --bg-tertiary: #28272C;
      --bg-white: #FFFFFF;

      /* Text */
      --text-primary: #DDDDDD;
      --text-secondary: #8E8D90;
      --text-tertiary: #666666;
      --text-inverse: #111015;

      /* Brand */
      --brand-primary: #1858E4;
      --brand-secondary: #8B5CF6;
      --brand-accent: #59AA8A;

      /* Semantic */
      --success: #59AA8A;
      --warning: #F5A623;
      --error: #D04C68;
      --info: #1858E4;

      /* Border */
      --border-default: #28272C;
      --border-light: #333333;

      /* Special */
      --bitcoin: #FFB800;

      /* Spacing */
      --space-xs: 4px;
      --space-sm: 8px;
      --space-md: 16px;
      --space-lg: 24px;
      --space-xl: 32px;
      --space-xxl: 48px;

      /* Radii */
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-xl: 16px;
      --radius-xxl: 20px;

      /* Font sizes */
      --text-xs: 12px;
      --text-sm: 14px;
      --text-md: 16px;
      --text-lg: 20px;
      --text-xl: 24px;
      --text-xxl: 28px;
      --text-xxxl: 32px;
      --text-display: 36px;
      --text-giant: 44px;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      padding: var(--space-lg);
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--space-xl);
      padding-bottom: var(--space-lg);
      border-bottom: 1px solid var(--border-default);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: var(--space-md);
    }

    .logo-icon {
      width: 48px;
      height: 48px;
      background: var(--brand-primary);
      border-radius: var(--radius-lg);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--text-xl);
      font-weight: 700;
      color: var(--text-primary);
    }

    .logo h1 {
      font-size: var(--text-xl);
      font-weight: 700;
      color: var(--text-primary);
    }

    .logo .subtitle {
      font-size: var(--text-xs);
      color: var(--brand-secondary);
      margin-top: 2px;
      letter-spacing: 0.5px;
    }

    .status {
      display: flex;
      align-items: center;
      gap: var(--space-lg);
    }

    .status-item {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      font-size: var(--text-sm);
      color: var(--text-secondary);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* Grid layouts */
    .grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--space-md);
      margin-bottom: var(--space-lg);
    }

    .wide-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--space-md);
      margin-bottom: var(--space-lg);
    }

    /* Cards */
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      padding: var(--space-lg);
      transition: all 0.2s ease;
    }

    .card:hover {
      border-color: var(--brand-primary);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--space-md);
    }

    .card-title {
      font-size: var(--text-xs);
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      font-weight: 600;
    }

    .card-icon {
      font-size: var(--text-lg);
      opacity: 0.8;
    }

    .card-value {
      font-size: var(--text-xxxl);
      font-weight: 700;
      margin-bottom: var(--space-sm);
      font-variant-numeric: tabular-nums;
      color: var(--text-primary);
    }

    .card-value.brand { color: var(--brand-primary); }
    .card-value.accent { color: var(--brand-accent); }
    .card-value.secondary { color: var(--brand-secondary); }
    .card-value.warning { color: var(--warning); }

    .card-detail {
      font-size: var(--text-xs);
      color: var(--text-tertiary);
    }

    /* Section titles */
    .section-title {
      font-size: var(--text-sm);
      font-weight: 600;
      margin-bottom: var(--space-md);
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }

    /* Quote stats */
    .quote-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-md);
    }

    .quote-stat {
      background: var(--bg-tertiary);
      border-radius: var(--radius-md);
      padding: var(--space-md);
      text-align: center;
    }

    .quote-stat-value {
      font-size: var(--text-xl);
      font-weight: 700;
      margin-bottom: var(--space-xs);
    }

    .quote-stat-label {
      font-size: 11px;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .state-unpaid { color: var(--warning); }
    .state-paid, .state-pending { color: var(--brand-primary); }
    .state-issued { color: var(--success); }

    /* Tables */
    .table-card {
      grid-column: span 2;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th {
      text-align: left;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-tertiary);
      padding: var(--space-md);
      border-bottom: 1px solid var(--border-default);
      font-weight: 600;
    }

    td {
      padding: var(--space-md);
      font-size: var(--text-sm);
      border-bottom: 1px solid var(--border-default);
    }

    tr:hover td {
      background: var(--bg-tertiary);
    }

    /* Badges */
    .badge {
      display: inline-block;
      padding: var(--space-xs) 10px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .badge-unpaid { background: rgba(245, 166, 35, 0.15); color: var(--warning); }
    .badge-paid { background: rgba(24, 88, 228, 0.15); color: var(--brand-primary); }
    .badge-pending { background: rgba(139, 92, 246, 0.15); color: var(--brand-secondary); }
    .badge-issued { background: rgba(89, 170, 138, 0.15); color: var(--success); }

    /* Utility classes */
    .mono {
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: var(--text-xs);
      color: var(--text-secondary);
    }

    .amount {
      font-weight: 600;
      color: var(--text-primary);
    }

    .time-ago {
      color: var(--text-tertiary);
      font-size: var(--text-xs);
    }

    /* Footer */
    .footer {
      margin-top: var(--space-xl);
      padding-top: var(--space-lg);
      border-top: 1px solid var(--border-default);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: var(--text-xs);
      color: var(--text-tertiary);
    }

    .refresh-indicator {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }

    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--border-default);
      border-top-color: var(--brand-primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      opacity: 0;
    }

    .spinner.active {
      opacity: 1;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Tabs */
    .tabs {
      display: flex;
      gap: var(--space-sm);
      margin-bottom: var(--space-lg);
      border-bottom: 1px solid var(--border-default);
      padding-bottom: var(--space-sm);
    }

    .tab {
      padding: var(--space-sm) var(--space-md);
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: var(--text-sm);
      font-weight: 600;
      cursor: pointer;
      border-radius: var(--radius-md);
      transition: all 0.2s ease;
    }

    .tab:hover {
      color: var(--text-primary);
      background: var(--bg-tertiary);
    }

    .tab.active {
      color: var(--text-primary);
      background: var(--brand-primary);
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    /* Links */
    a {
      color: var(--brand-primary);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    /* External link icon */
    .external-link {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
    }

    .external-link::after {
      content: '\\2197';
      font-size: 10px;
    }

    /* Responsive */
    @media (max-width: 1200px) {
      .grid { grid-template-columns: repeat(2, 1fr); }
    }

    @media (max-width: 768px) {
      .grid { grid-template-columns: 1fr; }
      .wide-grid { grid-template-columns: 1fr; }
      .table-card { grid-column: span 1; }
      .status { display: none; }
      body { padding: var(--space-md); }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">
        <div class="logo-icon">U</div>
        <div>
          <h1 id="mintName">Mint Dashboard</h1>
          <div class="subtitle" id="network">Loading...</div>
        </div>
      </div>
      <div class="status">
        <div class="status-item">
          <div class="status-dot"></div>
          <span>Online</span>
        </div>
        <div class="status-item">
          <span>Uptime: <span id="uptime">--</span></span>
        </div>
        <div class="status-item">
          <span>Rune: <span id="runeId" class="mono">--</span></span>
        </div>
      </div>
    </header>

    <div class="tabs">
      <button class="tab active" onclick="showTab('overview')">Overview</button>
      <button class="tab" onclick="showTab('utxos')">UTXOs</button>
    </div>

    <div id="tab-overview" class="tab-content active">
    <div class="grid">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Total Reserve</span>
          <span class="card-icon">&#x1F48E;</span>
        </div>
        <div class="card-value accent" id="totalReserve">--</div>
        <div class="card-detail"><span id="utxoCount">--</span> UTXOs &bull; UNIT</div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Total Mints</span>
          <span class="card-icon">&#x1FA99;</span>
        </div>
        <div class="card-value brand" id="totalMints">--</div>
        <div class="card-detail"><span id="issuedMints">--</span> issued</div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Total Melts</span>
          <span class="card-icon">&#x1F525;</span>
        </div>
        <div class="card-value secondary" id="totalMelts">--</div>
        <div class="card-detail"><span id="paidMelts">--</span> completed</div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Proofs Spent</span>
          <span class="card-icon">&#x1F4DC;</span>
        </div>
        <div class="card-value warning" id="totalProofs">--</div>
        <div class="card-detail"><span id="totalSpentAmount">--</span> UNIT total</div>
      </div>
    </div>

    <div class="wide-grid">
      <div class="card">
        <div class="section-title">&#x1F4E5; Mint Quotes</div>
        <div class="quote-stats">
          <div class="quote-stat">
            <div class="quote-stat-value state-unpaid" id="mintUnpaid">--</div>
            <div class="quote-stat-label">Unpaid</div>
          </div>
          <div class="quote-stat">
            <div class="quote-stat-value state-paid" id="mintPaid">--</div>
            <div class="quote-stat-label">Paid</div>
          </div>
          <div class="quote-stat">
            <div class="quote-stat-value state-issued" id="mintIssued">--</div>
            <div class="quote-stat-label">Issued</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="section-title">&#x1F4E4; Melt Quotes</div>
        <div class="quote-stats">
          <div class="quote-stat">
            <div class="quote-stat-value state-unpaid" id="meltUnpaid">--</div>
            <div class="quote-stat-label">Unpaid</div>
          </div>
          <div class="quote-stat">
            <div class="quote-stat-value state-pending" id="meltPending">--</div>
            <div class="quote-stat-label">Pending</div>
          </div>
          <div class="quote-stat">
            <div class="quote-stat-value state-issued" id="meltPaid">--</div>
            <div class="quote-stat-label">Paid</div>
          </div>
        </div>
      </div>
    </div>

    <div class="wide-grid">
      <div class="card table-card">
        <div class="section-title">&#x1F551; Recent Mint Quotes</div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Amount</th>
              <th>State</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="recentMints">
            <tr><td colspan="4" style="text-align: center; color: var(--text-tertiary);">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="wide-grid">
      <div class="card table-card">
        <div class="section-title">&#x1F551; Recent Melt Quotes</div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Amount</th>
              <th>State</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="recentMelts">
            <tr><td colspan="4" style="text-align: center; color: var(--text-tertiary);">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid" style="grid-template-columns: repeat(2, 1fr);">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Active Keysets</span>
          <span class="card-icon">&#x1F511;</span>
        </div>
        <div class="card-value brand" id="activeKeysets">--</div>
        <div class="card-detail"><span id="totalKeysets">--</span> total keysets</div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Network</span>
          <span class="card-icon">&#x1F310;</span>
        </div>
        <div class="card-value secondary" id="networkDisplay">--</div>
        <div class="card-detail">Bitcoin network</div>
      </div>
    </div>
    </div><!-- end tab-overview -->

    <div id="tab-utxos" class="tab-content">
      <div class="card">
        <div class="section-title">&#x1F4B0; UNIT Reserve UTXOs</div>
        <table>
          <thead>
            <tr>
              <th>Output</th>
              <th>Amount</th>
              <th>Sats</th>
              <th>Created</th>
              <th>Explorer</th>
            </tr>
          </thead>
          <tbody id="utxosList">
            <tr><td colspan="5" style="text-align: center; color: var(--text-tertiary);">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div><!-- end tab-utxos -->

    <footer class="footer">
      <div>Cashu Mint Dashboard v1.0</div>
      <div class="refresh-indicator">
        <div class="spinner" id="spinner"></div>
        <span>Auto-refresh: <span id="countdown">10</span>s</span>
      </div>
    </footer>
  </div>

  <script>
    function formatNumber(n) {
      if (typeof n === 'string') n = parseInt(n) || 0;
      return n.toLocaleString();
    }

    // Format UNIT amounts (stored as smallest unit, divide by 100)
    function formatUnit(n) {
      if (typeof n === 'string') n = parseInt(n) || 0;
      const unitValue = n / 100;
      // Always show 2 decimal places
      return unitValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatUptime(seconds) {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      if (days > 0) return days + 'd ' + hours + 'h';
      if (hours > 0) return hours + 'h ' + mins + 'm';
      return mins + 'm';
    }

    function timeAgo(timestamp) {
      const now = Date.now();
      const diff = now - timestamp;
      const mins = Math.floor(diff / 60000);
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);
      if (days > 0) return days + 'd ago';
      if (hours > 0) return hours + 'h ago';
      if (mins > 0) return mins + 'm ago';
      return 'just now';
    }

    function getBadgeClass(state) {
      return 'badge badge-' + state.toLowerCase();
    }

    function truncateId(id) {
      if (id.length <= 12) return id;
      return id.slice(0, 6) + '...' + id.slice(-4);
    }

    async function fetchStats() {
      document.getElementById('spinner').classList.add('active');
      try {
        const res = await fetch('/admin/stats');
        const data = await res.json();

        // Update header
        document.getElementById('mintName').textContent = data.mintName;
        document.getElementById('network').textContent = data.network.toUpperCase() + ' Network';
        document.getElementById('uptime').textContent = formatUptime(data.uptime);
        document.getElementById('runeId').textContent = data.runeId;

        // Update cards (amounts are in smallest unit, divide by 100 for UNIT display)
        document.getElementById('totalReserve').textContent = formatUnit(data.totalReserve);
        document.getElementById('utxoCount').textContent = formatNumber(data.utxoCount);
        document.getElementById('totalMints').textContent = formatNumber(data.mintQuotes.total);
        document.getElementById('issuedMints').textContent = formatNumber(data.mintQuotes.issued);
        document.getElementById('totalMelts').textContent = formatNumber(data.meltQuotes.total);
        document.getElementById('paidMelts').textContent = formatNumber(data.meltQuotes.paid);
        document.getElementById('totalProofs').textContent = formatNumber(data.totalProofsSpent);
        document.getElementById('totalSpentAmount').textContent = formatUnit(data.totalAmountSpent);

        // Update quote stats
        document.getElementById('mintUnpaid').textContent = formatNumber(data.mintQuotes.unpaid);
        document.getElementById('mintPaid').textContent = formatNumber(data.mintQuotes.paid);
        document.getElementById('mintIssued').textContent = formatNumber(data.mintQuotes.issued);
        document.getElementById('meltUnpaid').textContent = formatNumber(data.meltQuotes.unpaid);
        document.getElementById('meltPending').textContent = formatNumber(data.meltQuotes.pending);
        document.getElementById('meltPaid').textContent = formatNumber(data.meltQuotes.paid);

        // Update keysets
        document.getElementById('activeKeysets').textContent = formatNumber(data.activeKeysets);
        document.getElementById('totalKeysets').textContent = formatNumber(data.totalKeysets);
        document.getElementById('networkDisplay').textContent = data.network.toUpperCase();

        // Update recent mints table
        const mintsBody = document.getElementById('recentMints');
        if (data.recentMints.length === 0) {
          mintsBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-tertiary);">No mint quotes yet</td></tr>';
        } else {
          mintsBody.innerHTML = data.recentMints.map(m =>
            '<tr>' +
              '<td class="mono">' + truncateId(m.id) + '</td>' +
              '<td class="amount">' + formatUnit(m.amount) + ' UNIT</td>' +
              '<td><span class="' + getBadgeClass(m.state) + '">' + m.state + '</span></td>' +
              '<td class="time-ago">' + timeAgo(m.created_at) + '</td>' +
            '</tr>'
          ).join('');
        }

        // Update recent melts table
        const meltsBody = document.getElementById('recentMelts');
        if (data.recentMelts.length === 0) {
          meltsBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-tertiary);">No melt quotes yet</td></tr>';
        } else {
          meltsBody.innerHTML = data.recentMelts.map(m =>
            '<tr>' +
              '<td class="mono">' + truncateId(m.id) + '</td>' +
              '<td class="amount">' + formatUnit(m.amount) + ' UNIT</td>' +
              '<td><span class="' + getBadgeClass(m.state) + '">' + m.state + '</span></td>' +
              '<td class="time-ago">' + timeAgo(m.created_at) + '</td>' +
            '</tr>'
          ).join('');
        }

      } catch (err) {
        console.error('Failed to fetch stats:', err);
      } finally {
        document.getElementById('spinner').classList.remove('active');
      }
    }

    // Tab switching
    let currentTab = 'overview';
    let utxosLoaded = false;

    function showTab(tabName) {
      currentTab = tabName;

      // Update tab buttons
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');

      // Update tab content
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('tab-' + tabName).classList.add('active');

      // Load UTXOs on first visit
      if (tabName === 'utxos' && !utxosLoaded) {
        fetchUtxos();
        utxosLoaded = true;
      }
    }

    // Fetch UTXOs
    async function fetchUtxos() {
      const utxosBody = document.getElementById('utxosList');
      utxosBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-tertiary);">Loading...</td></tr>';

      try {
        const res = await fetch('/admin/utxos');
        const utxos = await res.json();

        if (utxos.length === 0) {
          utxosBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-tertiary);">No UTXOs found</td></tr>';
        } else {
          utxosBody.innerHTML = utxos.map(u => {
            const outpoint = u.txid + ':' + u.vout;
            const explorerUrl = 'https://ord-mutinynet.ducatprotocol.com/output/' + outpoint;
            return '<tr>' +
              '<td class="mono">' + u.txid.slice(0, 8) + '...' + u.txid.slice(-4) + ':' + u.vout + '</td>' +
              '<td class="amount">' + formatUnit(u.amount) + ' UNIT</td>' +
              '<td>' + formatNumber(u.value) + '</td>' +
              '<td class="time-ago">' + timeAgo(u.created_at) + '</td>' +
              '<td><a href="' + explorerUrl + '" target="_blank" rel="noopener" class="external-link">View</a></td>' +
            '</tr>';
          }).join('');
        }
      } catch (err) {
        console.error('Failed to fetch UTXOs:', err);
        utxosBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--error);">Failed to load UTXOs</td></tr>';
      }
    }

    // Initial fetch
    fetchStats();

    // Auto refresh every 10 seconds
    let countdown = 10;
    setInterval(() => {
      countdown--;
      document.getElementById('countdown').textContent = countdown;
      if (countdown <= 0) {
        countdown = 10;
        fetchStats();
        // Also refresh UTXOs if on that tab
        if (currentTab === 'utxos') {
          fetchUtxos();
        }
      }
    }, 1000);
  </script>
</body>
</html>`
}
