import axios from 'axios';
import express from 'express';
import Database from 'better-sqlite3';

const app = express();
const PORT = 3303;
const DB_WRITE_INTERVAL = 10000;

// API endpoints
const SEI_RPC_API = 'https://rpc.sei.basementnodes.ca/status';
const PREDICTED_GAS_API = 'https://api.blocknative.com/gasprices/blockprices';
const EVM_RPC_API = 'https://evm-rpc.sei.basementnodes.ca';
const CHAIN_ID = 1329;

// Metrics
const metrics = {
  missedBlocks: 0,
  nullValues: 0,
  apiErrors: 0,
  lastProcessedBlock: 0,
  lastSync: null
};

// Cache and state
let predictedGasCache = [];
let seiGasPriceCache = [];
let lastDbWrite = Date.now();
let lastProcessedBlock = 0;

const db = new Database('gas_prices.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS gas_prices (
    blockNumber INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    baseFeePerGas REAL,
    confidence50 REAL,
    confidence70 REAL,
    confidence90 REAL,
    confidence99 REAL,
    seiGasPrice REAL
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON gas_prices(timestamp);
  CREATE INDEX IF NOT EXISTS idx_block_height ON gas_prices(blockNumber);
`);

const updateMetrics = (blockHeight, value) => {
  if (blockHeight > lastProcessedBlock + 1) {
    metrics.missedBlocks += blockHeight - lastProcessedBlock - 1;
  }
  if (value === null) metrics.nullValues++;
  metrics.lastProcessedBlock = blockHeight;
  metrics.lastSync = new Date();
};

async function backfillMissedBlocks(fromBlock, toBlock) {
  const missingBlocks = [];
  for (let height = fromBlock + 1; height < toBlock; height++) {
    missingBlocks.push(height);
  }
  
  await Promise.all(missingBlocks.map(async (height) => {
    try {
      const response = await axios.post(EVM_RPC_API, {
        jsonrpc: '2.0',
        method: 'eth_getBlockByNumber',
        params: [`0x${height.toString(16)}`, false],
        id: 1
      });
      
      if (response.data.result) {
        const timestamp = new Date(parseInt(response.data.result.timestamp, 16) * 1000).toISOString();
        db.prepare(`
          INSERT OR IGNORE INTO gas_prices (blockNumber, timestamp, seiGasPrice)
          VALUES (?, ?, ?)
        `).run(height, timestamp, null);
      }
    } catch (error) {
      metrics.apiErrors++;
      console.error(`Backfill error for block ${height}:`, error.message);
    }
  }));
}

async function pollPredictedGasPrice() {
  try {
    const [gasResponse, rpcResponse] = await Promise.all([
      axios.get(PREDICTED_GAS_API, { params: { chainid: CHAIN_ID } }),
      axios.get(SEI_RPC_API)
    ]);

    const syncInfo = rpcResponse.data?.sync_info;
    if (!syncInfo?.latest_block_height) {
      metrics.apiErrors++;
      return;
    }

    const blockNumber = parseInt(syncInfo.latest_block_height, 10);
    const timestamp = syncInfo.latest_block_time;
    const blockPrices = gasResponse.data?.blockPrices?.[0];

    if (!blockPrices) {
      metrics.nullValues++;
      return;
    }

    const confidences = blockPrices.estimatedPrices.reduce((acc, curr) => {
      acc[`confidence${curr.confidence}`] = curr.price;
      return acc;
    }, {});

    if (Date.now() - lastDbWrite >= DB_WRITE_INTERVAL) {
      db.prepare(`
        INSERT OR IGNORE INTO gas_prices (
          blockNumber, timestamp, baseFeePerGas,
          confidence50, confidence70, confidence90, confidence99
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        blockNumber,
        timestamp,
        blockPrices.baseFeePerGas,
        confidences.confidence50 || null,
        confidences.confidence70 || null,
        confidences.confidence90 || null,
        confidences.confidence99 || null
      );
      lastDbWrite = Date.now();
    }

    predictedGasCache = [{
      blockNumber,
      timestamp,
      confidence99: confidences.confidence99 || null
    }];

    updateMetrics(blockNumber, confidences.confidence99);
  } catch (error) {
    metrics.apiErrors++;
    console.error('Predicted gas price error:', error.message);
  }
}

async function pollSeiGasPrice() {
  try {
    const [blockNumberResp, gasPriceResp] = await Promise.all([
      axios.post(EVM_RPC_API, {
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1
      }),
      axios.post(EVM_RPC_API, {
        jsonrpc: '2.0',
        method: 'eth_gasPrice',
        params: [],
        id: 1
      })
    ]);

    const currentBlock = parseInt(blockNumberResp.data.result, 16);
    const gasPriceGwei = parseInt(gasPriceResp.data.result, 16) / 1e9;

    if (currentBlock > lastProcessedBlock + 1) {
      await backfillMissedBlocks(lastProcessedBlock, currentBlock);
    }

    if (Date.now() - lastDbWrite >= DB_WRITE_INTERVAL) {
      db.prepare(`
        UPDATE gas_prices 
        SET seiGasPrice = ? 
        WHERE blockNumber = ?
      `).run(gasPriceGwei, currentBlock);
      lastDbWrite = Date.now();
    }

    seiGasPriceCache = [{
      blockNumber: currentBlock,
      timestamp: new Date().toISOString(),
      gasPrice: gasPriceGwei
    }];

    updateMetrics(currentBlock, gasPriceGwei);
    lastProcessedBlock = currentBlock;
  } catch (error) {
    metrics.apiErrors++;
    console.error('Sei gas price error:', error.message);
  }
}

const sampleRates = {
  '1h': 1,
  '6h': 30,
  '12h': 60,
  '24h': 300,
  '72h': 900,
  '7d': 3600
};

function sampleData(data, timeframe) {
  const rate = sampleRates[timeframe];
  if (!rate) return data;
  return data.filter((_, i) => i % rate === 0);
}

app.use(express.static('public'));

app.get('/api/metrics', (_, res) => {
  res.json(metrics);
});

app.get('/api/chart-data', (req, res) => {
  try {
    const { range = '1h' } = req.query;
    const timeRanges = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '12h': 12 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '72h': 72 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000
    };

    const timeFilter = new Date(Date.now() - (timeRanges[range] || timeRanges['24h'])).toISOString();
    const rows = db.prepare(`
      SELECT * FROM gas_prices 
      WHERE timestamp >= ? 
      ORDER BY blockNumber ASC
    `).all(timeFilter);

    const predictedData = sampleData(rows.map(r => ({
      blockNumber: r.blockNumber,
      timestamp: r.timestamp,
      confidence99: r.confidence99
    })), range);

    const seiGasPriceData = sampleData(rows.map(r => ({
      blockNumber: r.blockNumber,
      timestamp: r.timestamp,
      confidence99: r.seiGasPrice
    })), range);

    res.json({ 
      predictedData, 
      seiGasPriceData,
      metrics 
    });
  } catch (error) {
    console.error('Chart data error:', error);
    res.status(500).json({ 
      predictedData: [], 
      seiGasPriceData: [], 
      metrics 
    });
  }
});

setInterval(pollPredictedGasPrice, 5000);
setInterval(pollSeiGasPrice, 500);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  pollPredictedGasPrice();
  pollSeiGasPrice();
});
