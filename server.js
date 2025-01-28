import axios from 'axios';
import express from 'express';
import Database from 'better-sqlite3';

const app = express();
const PORT = 3303;

// Initialize SQLite database
const db = new Database('gas_prices.db');

// Create or update the table to store historical data
db.exec(`
  CREATE TABLE IF NOT EXISTS gas_prices (
    blockNumber INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    baseFeePerGas REAL,
    confidence50 REAL,
    confidence70 REAL,
    confidence90 REAL,
    confidence99 REAL,
    evmGasPrice REAL
  );
`);

// Cache data for quick access
let seiDataCache = [];
let evmDataCache = [];
let cacheTTL = Date.now();

// Helper to purge rows older than 30 days
function purgeOldData() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    DELETE FROM gas_prices
    WHERE timestamp < ?
  `).run(thirtyDaysAgo);
}

// Poll Sei gas prices
const pollSeiGasPrices = async () => {
  try {
    const [gasResponse, rpcResponse] = await Promise.all([
      axios.get('https://api.blocknative.com/gasprices/blockprices', {
        params: { chainid: 1329 },
      }),
      axios.get('http://10.70.48.165:26657/status'),
    ]);

    const syncInfo = rpcResponse.data?.sync_info;
    if (!syncInfo?.latest_block_height || !syncInfo?.latest_block_time) {
      console.error('Invalid Sei RPC response format:', rpcResponse.data);
      return;
    }

    const blockNumber = parseInt(syncInfo.latest_block_height, 10);
    const timestamp = syncInfo.latest_block_time;

    const blockPrices = gasResponse.data?.blockPrices || [];
    if (!blockPrices.length) {
      console.warn('No valid gas price data from Blocknative API.');
      return;
    }

    const block = blockPrices[0];
    const baseFee = block.baseFeePerGas;
    const confidences = block.estimatedPrices.reduce((acc, curr) => {
      acc[`confidence${curr.confidence}`] = curr.price;
      return acc;
    }, {});

    // Insert or ignore duplicate blocks
    db.prepare(`
      INSERT OR IGNORE INTO gas_prices (
        blockNumber,
        timestamp,
        baseFeePerGas,
        confidence50,
        confidence70,
        confidence90,
        confidence99,
        evmGasPrice
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      blockNumber,
      timestamp,
      baseFee,
      confidences.confidence50 || null,
      confidences.confidence70 || null,
      confidences.confidence90 || null,
      confidences.confidence99 || null
    );

    // Update cache
    seiDataCache = [
      { blockNumber, timestamp, confidence99: confidences.confidence99 || null },
    ];
    cacheTTL = Date.now();

    purgeOldData();
  } catch (error) {
    console.error('Error polling Sei gas prices:', error.message);
  }
};

// Poll EVM gas prices
const pollEvmGasPrices = async () => {
  try {
    const [blockNumberResp, gasPriceResp] = await Promise.all([
      axios.post(
        'http://10.70.48.165:8545',
        { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 },
        { headers: { 'Content-Type': 'application/json' } }
      ),
      axios.post(
        'http://10.70.48.165:8545',
        { jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 },
        { headers: { 'Content-Type': 'application/json' } }
      ),
    ]);

    const evmBlockDec = parseInt(blockNumberResp.data.result, 16);
    const gasPriceGwei = parseInt(gasPriceResp.data.result, 16) / 1e9;

    const tmBlockResp = await axios.get(
      `http://10.70.48.165:26657/block?height=${evmBlockDec}`
    );
    const blockTime = tmBlockResp.data?.block?.header?.time || new Date().toISOString();

    db.prepare(`
      INSERT OR IGNORE INTO gas_prices (
        blockNumber,
        timestamp,
        baseFeePerGas,
        confidence50,
        confidence70,
        confidence90,
        confidence99,
        evmGasPrice
      )
      VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?)
    `).run(evmBlockDec, blockTime, gasPriceGwei);

    evmDataCache = [{ blockNumber: evmBlockDec, timestamp: blockTime, confidence99: gasPriceGwei }];

    purgeOldData();
  } catch (error) {
    console.error('Error polling EVM gas prices:', error.message);
  }
};

// Polling intervals
setInterval(pollSeiGasPrices, 400);
setInterval(pollEvmGasPrices, 400);

// Serve static files
app.use(express.static('public'));

// API: Historical data
app.get('/api/gas-prices', (req, res) => {
  const { range = '24h' } = req.query;

  const now = Date.now();
  const timeFilter = new Date(now - {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
  }[range] || 24 * 60 * 60 * 1000).toISOString();

  try {
    const rows = db
      .prepare(`
        SELECT *
        FROM gas_prices
        WHERE timestamp >= ?
        ORDER BY blockNumber ASC
      `)
      .all(timeFilter);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching gas prices:', error.message);
    res.status(500).json({ error: 'Failed to fetch gas prices.' });
  }
});

// API: Chart data
app.get('/api/chart-data', (req, res) => {
  try {
    const { range = '24h' } = req.query;

    const now = Date.now();
    const timeFilter = new Date(now - {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '12h': 12 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
    }[range] || 24 * 60 * 60 * 1000).toISOString();

    const maxDataPoints = Math.floor({
      '1h': 3600 / 0.4,
      '6h': 6 * 3600 / 0.4,
      '12h': 12 * 3600 / 0.4,
      '24h': 24 * 3600 / 0.4,
    }[range] || (24 * 3600) / 0.4);

    const rows = db
      .prepare(`
        SELECT *
        FROM gas_prices
        WHERE timestamp >= ?
        ORDER BY blockNumber ASC
        LIMIT ?
      `)
      .all(timeFilter, maxDataPoints);

    const seiData = rows.map((r) => ({ blockNumber: r.blockNumber, timestamp: r.timestamp, confidence99: r.confidence99 || null }));
    const evmData = rows.map((r) => ({ blockNumber: r.blockNumber, timestamp: r.timestamp, confidence99: r.evmGasPrice || null }));

    res.json({ seiData, evmData });
  } catch (error) {
    console.error('Error fetching chart data:', error.message);
    res.status(500).json({ seiData: [], evmData: [] });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
