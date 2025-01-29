import axios from 'axios';
import express from 'express';
import Database from 'better-sqlite3';

const app = express();
const PORT = 3303;
const DB_WRITE_INTERVAL = 10000;

// Memory-aware configuration
const CONFIG = {
  MAX_CONCURRENT_BACKFILL: 25,        // Reduced from 50
  MAX_RECORDS_PER_QUERY: 500,         // Reduced from 1000
  DB_CLEANUP_INTERVAL: 30 * 60 * 1000, // Run every 30 minutes
  CACHE_LIMITS: {
    '1h': 2000,    // Reduced from 9000
    '6h': 5000,    // Reduced from 54000
    '12h': 7500,   // Reduced from 108000
    '24h': 10000,  // Reduced from 216000
    '72h': 15000,  // Reduced from 648000
    '7d': 20000    // Reduced from 1512000
  },
  SAMPLING_RATES: {
    '1h': 1,
    '6h': 12,     // Sample every 12th point
    '12h': 24,    // Sample every 24th point
    '24h': 48,    // Sample every 48th point
    '72h': 144,   // Sample every 144th point
    '7d': 336     // Sample every 336th point
  }
};

// Add garbage collection helper
function forceGC() {
  if (global.gc) {
    try {
      global.gc();
      console.log('Manual garbage collection executed');
    } catch (e) {
      console.error('Failed to force garbage collection:', e);
    }
  }
}

// Enhanced memory monitoring
function logMemoryUsage() {
  const used = process.memoryUsage();
  console.log('Memory usage:');
  for (let key in used) {
    console.log(`${key}: ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
  }

  // Force GC if heapUsed is above 500MB
  if (used.heapUsed > 500 * 1024 * 1024) {
    console.log('High memory usage detected, forcing garbage collection');
    forceGC();
  }
}
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

const db = new Database('gas_prices.db', {
  verbose: console.log
});

// Initialize database with indices
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

// Enhanced database cleanup function
function cleanupOldData() {
  try {
    // Keep only last 7 days of data
    const cutoffTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    // Get the count of records to be deleted
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM gas_prices WHERE timestamp < ?');
    const { count } = countStmt.get(cutoffTime);
    
    if (count > 0) {
      console.log(`Cleaning up ${count} old records from database`);
      
      // Delete old records
      const deleteStmt = db.prepare('DELETE FROM gas_prices WHERE timestamp < ?');
      const result = deleteStmt.run(cutoffTime);
      
      // Vacuum the database to reclaim space
      if (result.changes > 0) {
        db.exec('VACUUM');
        console.log(`Cleaned up ${result.changes} records and optimized database`);
      }
    }
  } catch (error) {
    console.error('Error during database cleanup:', error);
  }
}

// Set up periodic cleanup using new CONFIG interval
setInterval(cleanupOldData, CONFIG.DB_CLEANUP_INTERVAL);

const updateMetrics = (blockHeight, value) => {
  if (blockHeight > lastProcessedBlock + 1) {
    metrics.missedBlocks += blockHeight - lastProcessedBlock - 1;
  }
  if (value === null) metrics.nullValues++;
  metrics.lastProcessedBlock = blockHeight;
  metrics.lastSync = new Date();
};

// Enhanced cache management with dynamic sizing
function manageCache(cache, timeRange = '1h') {
  const maxSize = CONFIG.CACHE_LIMITS[timeRange] || CONFIG.CACHE_LIMITS['1h'];
  
  if (cache.length > maxSize) {
    cache = cache.slice(-maxSize);
  }
  
  return cache;
}

// Helper function to process blocks in chunks
async function processBlockChunk(blocks) {
  return Promise.all(blocks.map(async (height) => {
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

async function backfillMissedBlocks(fromBlock, toBlock) {
  console.log(`Attempting to backfill blocks from ${fromBlock} to ${toBlock}`);
  const missingBlocks = [];
  const blockDiff = toBlock - fromBlock;
  
  // Safety check - prevent excessive backfilling
  if (blockDiff > 10000) {
    console.warn(`Large block range detected (${blockDiff} blocks). Limiting to last 10000 blocks.`);
    fromBlock = toBlock - 10000;
  }
  
  for (let height = fromBlock + 1; height < toBlock; height++) {
    missingBlocks.push(height);
  }
  
  console.log(`Processing ${missingBlocks.length} missing blocks in chunks of ${CONFIG.MAX_CONCURRENT_BACKFILL}`);
  
  // Process blocks in chunks to limit memory usage
  const chunkSize = CONFIG.MAX_CONCURRENT_BACKFILL;
  for (let i = 0; i < missingBlocks.length; i += chunkSize) {
    const chunk = missingBlocks.slice(i, i + chunkSize);
    console.log(`Processing chunk ${Math.floor(i/chunkSize) + 1}/${Math.ceil(missingBlocks.length/chunkSize)}`);
    await processBlockChunk(chunk);
  }
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
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO gas_prices (
          blockNumber, timestamp, baseFeePerGas,
          confidence50, confidence70, confidence90, confidence99
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
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

    predictedGasCache.push({
      blockNumber,
      timestamp,
      confidence99: confidences.confidence99 || null
    });
    predictedGasCache = manageCache(predictedGasCache);

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

    seiGasPriceCache.push({
      blockNumber: currentBlock,
      timestamp: new Date().toISOString(),
      gasPrice: gasPriceGwei
    });
    seiGasPriceCache = manageCache(seiGasPriceCache);

    updateMetrics(currentBlock, gasPriceGwei);
    lastProcessedBlock = currentBlock;
  } catch (error) {
    metrics.apiErrors++;
    console.error('Sei gas price error:', error.message);
  }
}

// Sample data based on timeframe
function sampleData(data, timeframe) {
  const samplingRates = {
    '1h': 1,     // No sampling for 1h
    '6h': 6,     // Sample every 6th point
    '12h': 12,   // Sample every 12th point
    '24h': 24,   // Sample every 24th point
    '72h': 72,   // Sample every 72nd point
    '7d': 168    // Sample every 168th point
  };

  const rate = samplingRates[timeframe] || 1;
  return data.filter((_, index) => index % rate === 0);
}

// Optimized chart data endpoint with sampling
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
    
    // Use more efficient query with LIMIT
    const stmt = db.prepare(`
      SELECT blockNumber, timestamp, confidence99, seiGasPrice 
      FROM gas_prices 
      WHERE timestamp >= ? 
      ORDER BY blockNumber ASC
      LIMIT 10000
    `);
    
    const rows = stmt.all(timeFilter);

    let predictedData = rows.map(r => ({
      blockNumber: r.blockNumber,
      timestamp: r.timestamp,
      confidence99: r.confidence99
    }));

    let seiGasPriceData = rows.map(r => ({
      blockNumber: r.blockNumber,
      timestamp: r.timestamp,
      confidence99: r.seiGasPrice
    }));

    // Apply sampling for larger timeframes
    if (range !== '1h') {
      predictedData = sampleData(predictedData, range);
      seiGasPriceData = sampleData(seiGasPriceData, range);
    }

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

app.use(express.static('public'));

app.get('/api/metrics', (_, res) => {
  res.json(metrics);
});

// Initialize with appropriate intervals
setInterval(pollPredictedGasPrice, 5000);
setInterval(pollSeiGasPrice, 500);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  pollPredictedGasPrice();
  pollSeiGasPrice();
});
