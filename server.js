import axios from 'axios';
import express from 'express';
import Database from 'better-sqlite3';

const app = express();
const PORT = 3003;

// Initialize SQLite database
const db = new Database('gas_prices.db');

// Create or update the table to store historical data
db.exec(`
  CREATE TABLE IF NOT EXISTS gas_prices (
    blockNumber INTEGER PRIMARY KEY,
    timestamp TEXT,
    baseFeePerGas REAL,
    confidence50 REAL,
    confidence70 REAL,
    confidence90 REAL,
    confidence99 REAL,
    evmGasPrice REAL
  );
`);

let seiDataCache = [];
let evmDataCache = [];
let cacheTTL = Date.now();

let currentSeiBlockNumber = null;

// Helper to purge rows older than 30 days
function purgeOldData() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    DELETE FROM gas_prices
    WHERE timestamp < ?
  `).run(thirtyDaysAgo);
}

const pollSeiGasPrices = async () => {
  try {
    const [gasResponse, rpcResponse] = await Promise.all([
      axios.get('https://api.blocknative.com/gasprices/blockprices', {
        params: { chainid: 1329 },
      }),
      axios.get('https://rpc.sei.basementnodes.ca/status'),
    ]);

    const syncInfo = rpcResponse.data?.sync_info;
    if (!syncInfo?.latest_block_height || !syncInfo?.latest_block_time) {
      console.error('Invalid Sei RPC response format:', rpcResponse.data);
      return;
    }

    const blockNumber = parseInt(syncInfo.latest_block_height, 10);
    const timestamp = syncInfo.latest_block_time;
    currentSeiBlockNumber = blockNumber;

    const blockPrices = gasResponse.data?.blockPrices || [];
    if (!blockPrices.length) {
      console.warn('No valid gas price data from Blocknative API:', gasResponse.data);
      return;
    }

    // Grab the first predicted block
    const block = blockPrices[0];
    const baseFee = block.baseFeePerGas;
    const confidences = block.estimatedPrices.reduce((acc, curr) => {
      acc[`confidence${curr.confidence}`] = curr.price;
      return acc;
    }, {});

    // Insert predicted row (if not present):
    // 8 columns -> 7 placeholders + 1 literal NULL => 8 total.
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

    // Update in-memory "latest" cache
    seiDataCache = [
      {
        blockNumber,
        timestamp,
        confidence99: confidences.confidence99 || null,
      },
    ];
    cacheTTL = Date.now();

    // Purge data older than 30 days
    purgeOldData();
  } catch (error) {
    console.error('Error polling Sei gas prices:', error.message);
  }
};

// fetch EVM block number + gas price, use Tendermint for block timestamp
const pollEvmGasPrices = async () => {
  try {
    // get block number & gas price concurrently
    const [blockNumberResp, gasPriceResp] = await Promise.all([
      axios.post(
        'https://evm-rpc.sei.basementnodes.ca',
        {
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1,
        },
        { headers: { 'Content-Type': 'application/json' } }
      ),
      axios.post(
        'https://evm-rpc.sei.basementnodes.ca',
        {
          jsonrpc: '2.0',
          method: 'eth_gasPrice',
          params: [],
          id: 1,
        },
        { headers: { 'Content-Type': 'application/json' } }
      ),
    ]);

    // Convert block number hex -> decimal
    const evmBlockHex = blockNumberResp.data.result;
    const evmBlockDec = parseInt(evmBlockHex, 16);

    // Convert gas price hex -> decimal Wei -> Gwei
    const gasPriceHex = gasPriceResp.data.result;
    const gasPriceWei = parseInt(gasPriceHex, 16);
    const gasPriceGwei = gasPriceWei / 1e9;

    const tmBlockResp = await axios.get(
      `https://rpc.sei.basementnodes.ca/block?height=${evmBlockDec}`
    );
    const tmBlockHeader = tmBlockResp.data?.block?.header;
    let blockTime = tmBlockHeader?.time; // e.g. "2024-12-26T18:13:29.130124875Z"

    if (!blockTime) {
      // Fallback to "now" if the block isn't found, or handle differently
      console.warn(`No Tendermint block time found for block #${evmBlockDec}`);
      blockTime = new Date().toISOString();
    }

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

    db.prepare(`
      UPDATE gas_prices
      SET timestamp = COALESCE(timestamp, ?),
          evmGasPrice = ?
      WHERE blockNumber = ?
    `).run(blockTime, gasPriceGwei, evmBlockDec);

    // 4) Update in-memory EVM cache
    evmDataCache = [
      {
        blockNumber: evmBlockDec.toString(),
        timestamp: blockTime,
        confidence99: gasPriceGwei,
      },
    ];

    // Purge old data
    purgeOldData();
  } catch (error) {
    console.error('Error polling EVM gas prices:', error.message);
  }
};

setInterval(pollSeiGasPrices, 400);
setInterval(pollEvmGasPrices, 400);

// Serve static files
app.use(express.static('public'));

// API: Return historical data
app.get('/api/gas-prices', (req, res) => {
  const { range = '7d' } = req.query;

  let timeFilter = Date.now();
  switch (range) {
    case '1h':
      timeFilter -= 60 * 60 * 1000;
      break;
    case '1d':
      timeFilter -= 24 * 60 * 60 * 1000;
      break;
    case '30d':
      timeFilter -= 30 * 24 * 60 * 60 * 1000;
      break;
    default:
      timeFilter -= 7 * 24 * 60 * 60 * 1000;
  }

  try {
    const rows = db
      .prepare(`
        SELECT *
        FROM gas_prices
        WHERE timestamp >= ?
        ORDER BY blockNumber ASC
      `)
      .all(new Date(timeFilter).toISOString());
    res.json(rows);
  } catch (error) {
    console.error('Error fetching gas prices:', error.message);
    res.status(500).json({ error: 'Failed to fetch gas prices.' });
  }
});

// API: Return data for chart
app.get('/api/chart-data', (req, res) => {
  try {
    const { range = '7d' } = req.query;

    let timeFilter = Date.now();
    switch (range) {
      case '1h':
        timeFilter -= 60 * 60 * 1000;
        break;
      case '1d':
        timeFilter -= 24 * 60 * 60 * 1000;
        break;
      case '30d':
        timeFilter -= 30 * 24 * 60 * 60 * 1000;
        break;
      default:
        timeFilter -= 7 * 24 * 60 * 60 * 1000;
    }

    if (Date.now() - cacheTTL > 10000) {
      console.warn('Cache expired, data may be stale.');
    }

    const rows = db
      .prepare(`
        SELECT blockNumber, timestamp,
               baseFeePerGas,
               confidence99,
               evmGasPrice
        FROM gas_prices
        WHERE timestamp >= ?
        ORDER BY blockNumber ASC
      `)
      .all(new Date(timeFilter).toISOString());

    const seiData = rows.map((r) => ({
      blockNumber: r.blockNumber,
      timestamp: r.timestamp,
      confidence99: r.confidence99,
    }));

    const evmData = rows.map((r) => ({
      blockNumber: r.blockNumber,
      timestamp: r.timestamp,
      confidence99: r.evmGasPrice,
    }));

    res.json({ seiData, evmData });
  } catch (error) {
    console.error('Error fetching chart data:', error.message);
    res.status(500).json({ error: 'Failed to fetch chart data.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
