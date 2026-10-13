import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'crypto'
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
  if (!env.ADMIN_ENABLED) {
    fastify.log.info('Admin dashboard routes disabled')
    return
  }

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAdminRequest(request.headers.authorization)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer realm="admin"')
        .send({ error: 'Unauthorized' })
    }
  }

  // Dashboard stats API
  fastify.get('/admin/stats', { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      const stats = await getDashboardStats()
      return reply.code(200).send(stats)
    } catch (error) {
      fastify.log.error(error, 'Failed to get dashboard stats')
      return reply.code(500).send({ error: 'Failed to get stats' })
    }
  })

  // UTXOs API
  fastify.get('/admin/utxos', { preHandler: requireAdmin }, async (_request, reply) => {
    try {
      const utxos = await getUtxos()
      return reply.code(200).send(utxos)
    } catch (error) {
      fastify.log.error(error, 'Failed to get UTXOs')
      return reply.code(500).send({ error: 'Failed to get UTXOs' })
    }
  })

  // Dashboard HTML page
  fastify.get('/dashboard', { preHandler: requireAdmin }, async (_request, reply) => {
    reply.type('text/html')
    return reply.send(getDashboardHTML())
  })
}

function isAdminRequest(authorization?: string): boolean {
  if (!env.ADMIN_TOKEN || !authorization?.startsWith('Bearer ')) {
    return false
  }

  const provided = Buffer.from(authorization.slice('Bearer '.length))
  const expected = Buffer.from(env.ADMIN_TOKEN)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
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
  const reserveResult = await query<{ total: string; count: string }>(
    `SELECT COALESCE(SUM(amount::BIGINT), 0)::TEXT as total, COUNT(*)::TEXT as count
     FROM mint_utxos WHERE spent = false`
  )

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

  const proofResult = await query<{ count: string; total: string }>(
    `SELECT COUNT(*)::TEXT as count, COALESCE(SUM(amount), 0)::TEXT as total
     FROM proofs WHERE state = 'SPENT'`
  )

  const keysetResult = await query<{ active: string; total: string }>(
    `SELECT
       SUM(CASE WHEN active = true THEN 1 ELSE 0 END)::TEXT as active,
       COUNT(*)::TEXT as total
     FROM keysets`
  )

  const recentMintsResult = await query<{ id: string; amount: string; state: string; created_at: string }>(
    `SELECT id, amount::TEXT, state, created_at::TEXT
     FROM mint_quotes ORDER BY created_at DESC LIMIT 10`
  )

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
    runeId: env.SUPPORTED_RUNES || '',
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
      --bg-primary: #111015;
      --bg-secondary: #1D1C21;
      --bg-tertiary: #28272C;
      --bg-white: #FFFFFF;

      --text-primary: #DDDDDD;
      --text-secondary: #8E8D90;
      --text-tertiary: #666666;
      --text-inverse: #111015;

      --brand-primary: #1858E4;
      --brand-secondary: #8B5CF6;
      --brand-accent: #59AA8A;

      --success: #59AA8A;
      --warning: #F5A623;
      --error: #D04C68;
      --info: #1858E4;

      --border-default: #28272C;
      --border-light: #333333;
      --bitcoin: #FFB800;

      --space-xs: 4px;
      --space-sm: 8px;
      --space-md: 16px;
      --space-lg: 24px;
      --space-xl: 32px;
      --space-xxl: 48px;

      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-xl: 16px;
      --radius-xxl: 20px;

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

    .section-title {
      font-size: var(--text-sm);
      font-weight: 600;
      margin-bottom: var(--space-md);
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }

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

    a {
      color: var(--brand-primary);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .external-link {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
    }

    .external-link::after {
      content: '\\2197';
      font-size: 10px;
    }

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
    </div>

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
    </div>

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

    function formatUnit(n) {
      if (typeof n === 'string') n = parseInt(n) || 0;
      return n.toLocaleString();
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
      return 'badge badge-' + String(state).toLowerCase();
    }

    function truncateId(id) {
      if (!id || id.length <= 12) return id || '';
      return id.slice(0, 6) + '...' + id.slice(-4);
    }

    function renderEmptyRow(tbody, message, colspan) {
      tbody.textContent = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = colspan;
      td.style.textAlign = 'center';
      td.style.color = 'var(--text-tertiary)';
      td.textContent = message;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    function renderQuoteRows(tbody, items, emptyMessage) {
      if (!items || items.length === 0) {
        renderEmptyRow(tbody, emptyMessage, 4);
        return;
      }
      tbody.textContent = '';
      for (const item of items) {
        const tr = document.createElement('tr');

        const tdId = document.createElement('td');
        tdId.className = 'mono';
        tdId.textContent = truncateId(String(item.id || ''));
        tr.appendChild(tdId);

        const tdAmount = document.createElement('td');
        tdAmount.className = 'amount';
        tdAmount.textContent = formatUnit(item.amount) + ' UNIT';
        tr.appendChild(tdAmount);

        const tdState = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = getBadgeClass(item.state);
        badge.textContent = String(item.state || '');
        tdState.appendChild(badge);
        tr.appendChild(tdState);

        const tdTime = document.createElement('td');
        tdTime.className = 'time-ago';
        tdTime.textContent = timeAgo(Number(item.created_at) || 0);
        tr.appendChild(tdTime);

        tbody.appendChild(tr);
      }
    }

    async function fetchStats() {
      document.getElementById('spinner').classList.add('active');
      try {
        const res = await fetch('/admin/stats');
        const data = await res.json();

        document.getElementById('mintName').textContent = data.mintName;
        document.getElementById('network').textContent = data.network.toUpperCase() + ' Network';
        document.getElementById('uptime').textContent = formatUptime(data.uptime);
        document.getElementById('runeId').textContent = data.runeId;

        document.getElementById('totalReserve').textContent = formatUnit(data.totalReserve);
        document.getElementById('utxoCount').textContent = formatNumber(data.utxoCount);
        document.getElementById('totalMints').textContent = formatNumber(data.mintQuotes.total);
        document.getElementById('issuedMints').textContent = formatNumber(data.mintQuotes.issued);
        document.getElementById('totalMelts').textContent = formatNumber(data.meltQuotes.total);
        document.getElementById('paidMelts').textContent = formatNumber(data.meltQuotes.paid);
        document.getElementById('totalProofs').textContent = formatNumber(data.totalProofsSpent);
        document.getElementById('totalSpentAmount').textContent = formatUnit(data.totalAmountSpent);

        document.getElementById('mintUnpaid').textContent = formatNumber(data.mintQuotes.unpaid);
        document.getElementById('mintPaid').textContent = formatNumber(data.mintQuotes.paid);
        document.getElementById('mintIssued').textContent = formatNumber(data.mintQuotes.issued);
        document.getElementById('meltUnpaid').textContent = formatNumber(data.meltQuotes.unpaid);
        document.getElementById('meltPending').textContent = formatNumber(data.meltQuotes.pending);
        document.getElementById('meltPaid').textContent = formatNumber(data.meltQuotes.paid);

        document.getElementById('activeKeysets').textContent = formatNumber(data.activeKeysets);
        document.getElementById('totalKeysets').textContent = formatNumber(data.totalKeysets);
        document.getElementById('networkDisplay').textContent = data.network.toUpperCase();

        renderQuoteRows(document.getElementById('recentMints'), data.recentMints, 'No mint quotes yet');
        renderQuoteRows(document.getElementById('recentMelts'), data.recentMelts, 'No melt quotes yet');
      } catch (err) {
        console.error('Failed to fetch stats:', err);
      } finally {
        document.getElementById('spinner').classList.remove('active');
      }
    }

    let currentTab = 'overview';
    let utxosLoaded = false;

    function showTab(tabName) {
      currentTab = tabName;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');

      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('tab-' + tabName).classList.add('active');

      if (tabName === 'utxos' && !utxosLoaded) {
        fetchUtxos();
        utxosLoaded = true;
      }
    }

    async function fetchUtxos() {
      const utxosBody = document.getElementById('utxosList');
      renderEmptyRow(utxosBody, 'Loading...', 5);

      try {
        const res = await fetch('/admin/utxos');
        const utxos = await res.json();

        if (!utxos || utxos.length === 0) {
          renderEmptyRow(utxosBody, 'No UTXOs found', 5);
        } else {
          utxosBody.textContent = '';
          for (const u of utxos) {
            const tr = document.createElement('tr');

            const tdOut = document.createElement('td');
            tdOut.className = 'mono';
            const txid = String(u.txid || '');
            tdOut.textContent = (txid.length > 12 ? txid.slice(0, 8) + '...' + txid.slice(-4) : txid) + ':' + u.vout;
            tr.appendChild(tdOut);

            const tdAmount = document.createElement('td');
            tdAmount.className = 'amount';
            tdAmount.textContent = formatUnit(u.amount) + ' UNIT';
            tr.appendChild(tdAmount);

            const tdVal = document.createElement('td');
            tdVal.textContent = formatNumber(u.value);
            tr.appendChild(tdVal);

            const tdTime = document.createElement('td');
            tdTime.className = 'time-ago';
            tdTime.textContent = timeAgo(Number(u.created_at) || 0);
            tr.appendChild(tdTime);

            const tdExp = document.createElement('td');
            const link = document.createElement('a');
            const outpoint = encodeURIComponent(String(u.txid || '')) + ':' + encodeURIComponent(String(u.vout ?? 0));
            link.href = 'https://ord-mutinynet.ducatprotocol.com/output/' + outpoint;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.className = 'external-link';
            link.textContent = 'View';
            tdExp.appendChild(link);
            tr.appendChild(tdExp);

            utxosBody.appendChild(tr);
          }
        }
      } catch (err) {
        console.error('Failed to fetch UTXOs:', err);
        renderEmptyRow(utxosBody, 'Failed to load UTXOs', 5);
      }
    }

    fetchStats();

    let countdown = 10;
    setInterval(() => {
      countdown--;
      document.getElementById('countdown').textContent = countdown;
      if (countdown <= 0) {
        countdown = 10;
        fetchStats();
        if (currentTab === 'utxos') {
          fetchUtxos();
        }
      }
    }, 1000);
  </script>
</body>
</html>`
}