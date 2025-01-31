// server.js

import express from 'express';
import axios from 'axios';
import BlockBuffer from './buffer.js';

const app = express();
const PORT = process.env.PORT || 3303;

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self';" +
    "script-src-elem 'self' https://cdn.jsdelivr.net 'unsafe-inline';"
  );
  next();
});

// Initialize block buffer with error handling
let blockBuffer;
try {
  blockBuffer = new BlockBuffer('gas_prices.db');
} catch (error) {
  console.error('Failed to initialize block buffer:', error);
  process.exit(1);
}

// API endpoints with environment variables and fallbacks
const SEI_RPC_API = process.env.SEI_RPC_API || 'https://rpc.sei.basementnodes.ca/status';
const PREDICTED_GAS_API = process.env.PREDICTED_GAS_API || 'https://api.blocknative.com/gasprices/blockprices';
const EVM_RPC_API = process.env.EVM_RPC_API || 'https://evm-rpc.sei.basementnodes.ca';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '1329', 10);

// Serve static files with proper caching
app.use(express.static('public', {
  maxAge: '1h',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      // Don't cache HTML files
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Enhanced error handling for API calls with exponential backoff
const fetchWithRetry = async (url, options = {}, retries = 3) => {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios({
        timeout: 5000,
        ...options,
        url,
        headers: {
          'User-Agent': 'SeiGasTracker/2.0.1',
          ...options.headers
        }
      });
      return response;
    } catch (error) {
      lastError = error;
      console.warn(`Attempt ${i + 1}/${retries} failed for ${url}:`, error.message);
      if (i === retries - 1) break;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
  throw lastError;
};

async function pollPredictedGasPrice() {
  try {
    const [gasResponse, rpcResponse] = await Promise.all([
      fetchWithRetry(PREDICTED_GAS_API, { 
        params: { chainid: CHAIN_ID },
        headers: {
          'Accept': 'application/json'
        }
      }),
      fetchWithRetry(SEI_RPC_API)
    ]);

    const syncInfo = rpcResponse.data?.sync_info;
    if (!syncInfo?.latest_block_height) {
      console.warn('Missing block height in RPC response');
      return;
    }

    const blockNumber = parseInt(syncInfo.latest_block_height, 10);
    const timestamp = syncInfo.latest_block_time;
    const blockPrices = gasResponse.data?.blockPrices?.[0];

    if (!blockPrices) {
      console.warn('Missing block prices in gas response');
      return;
    }

    const confidences = blockPrices.estimatedPrices.reduce((acc, curr) => {
      acc[`confidence${curr.confidence}`] = curr.price;
      return acc;
    }, {});

    blockBuffer.addBlock({
      blockNumber,
      timestamp,
      baseFeePerGas: blockPrices.baseFeePerGas,
      ...confidences
    });

  } catch (error) {
    console.error('Predicted gas price error:', error.message);
  }
}

async function pollSeiGasPrice() {
  try {
    const [blockNumberResp, gasPriceResp] = await Promise.all([
      fetchWithRetry(EVM_RPC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        data: {
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1
        }
      }),
      fetchWithRetry(EVM_RPC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        data: {
          jsonrpc: '2.0',
          method: 'eth_gasPrice',
          params: [],
          id: 1
        }
      })
    ]);

    if (!blockNumberResp.data?.result || !gasPriceResp.data?.result) {
      console.warn('Invalid RPC response format');
      return;
    }

    const currentBlock = parseInt(blockNumberResp.data.result, 16);
    const gasPriceGwei = parseInt(gasPriceResp.data.result, 16) / 1e9;

    blockBuffer.addBlock({
      blockNumber: currentBlock,
      seiGasPrice: gasPriceGwei,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Sei gas price error:', error.message);
  }
}

// Optimized chart data endpoint with error handling
app.get('/api/chart-data', async (req, res) => {
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

    if (!timeRanges[range]) {
      return res.status(400).json({ error: 'Invalid time range' });
    }

    if (range === '1h') {
      const recentBlocks = blockBuffer.getRecentBlocks(15000);
      const timeFilter = new Date(Date.now() - timeRanges[range]).toISOString();
      
      const dbData = blockBuffer.db.prepare(`
        SELECT blockNumber, timestamp, confidence99, seiGasPrice 
        FROM gas_prices 
        WHERE timestamp >= ? AND timestamp < ?
        ORDER BY blockNumber ASC
      `).all(timeFilter, recentBlocks[0]?.timestamp || new Date().toISOString());

      const combinedData = [...dbData, ...recentBlocks];
      
      res.json({
        predictedData: combinedData.map(r => ({
          blockNumber: r.blockNumber,
          timestamp: r.timestamp,
          confidence99: r.confidence99
        })),
        seiGasPriceData: combinedData.map(r => ({
          blockNumber: r.blockNumber,
          timestamp: r.timestamp,
          confidence99: r.seiGasPrice
        })),
        bufferStats: blockBuffer.getBufferStats()
      });
    } else {
      const timeFilter = new Date(Date.now() - timeRanges[range]).toISOString();
      const rows = blockBuffer.db.prepare(`
        SELECT blockNumber, timestamp, confidence99, seiGasPrice 
        FROM gas_prices 
        WHERE timestamp >= ? 
        ORDER BY blockNumber ASC
      `).all(timeFilter);

      res.json({
        predictedData: rows.map(r => ({
          blockNumber: r.blockNumber,
          timestamp: r.timestamp,
          confidence99: r.confidence99
        })),
        seiGasPriceData: rows.map(r => ({
          blockNumber: r.blockNumber,
          timestamp: r.timestamp,
          confidence99: r.seiGasPrice
        }))
      });
    }
  } catch (error) {
    console.error('Chart data error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize polling with proper error handling
const POLL_INTERVAL = {
  PREDICTED: 5000,  // 5 seconds
  SEI: 500         // 500ms
};

let predictedInterval;
let seiInterval;

function startPolling() {
  // Initial polls
  pollPredictedGasPrice().catch(console.error);
  pollSeiGasPrice().catch(console.error);

  // Set up intervals
  predictedInterval = setInterval(() => {
    pollPredictedGasPrice().catch(console.error);
  }, POLL_INTERVAL.PREDICTED);

  seiInterval = setInterval(() => {
    pollSeiGasPrice().catch(console.error);
  }, POLL_INTERVAL.SEI);
}

// Cleanup function
function cleanup() {
  if (predictedInterval) clearInterval(predictedInterval);
  if (seiInterval) clearInterval(seiInterval);
  if (blockBuffer?.db) {
    try {
      blockBuffer.db.close();
    } catch (error) {
      console.error('Error closing database:', error);
    }
  }
}

// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  cleanup();
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal');
  cleanup();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT signal');
  cleanup();
  process.exit(0);
});

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startPolling();
});

// Handle server errors
server.on('error', (error) => {
  console.error('Server error:', error);
  cleanup();
  process.exit(1);
});