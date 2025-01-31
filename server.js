// server.js

import express from 'express';
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import BlockBuffer from './buffer.js';

const app = express();
const PORT = process.env.PORT || 3303;

// Rate limiting for API endpoints only
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests, please try again later'
    });
  }
});

// Apply rate limiting only to API routes
app.use('/api/', apiLimiter);

// Initialize block buffer
const blockBuffer = new BlockBuffer('gas_prices.db');

// API endpoints
const SEI_RPC_API = process.env.SEI_RPC_API || 'https://rpc.sei.basementnodes.ca/status';
const PREDICTED_GAS_API = process.env.PREDICTED_GAS_API || 'https://api.blocknative.com/gasprices/blockprices';
const EVM_RPC_API = process.env.EVM_RPC_API || 'https://evm-rpc.sei.basementnodes.ca';
const CHAIN_ID = process.env.CHAIN_ID || 1329;

// Serve static files
app.use(express.static('public'));

// Enhanced error handling for API calls
const fetchWithRetry = async (url, options = {}, retries = 3) => {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios(url, {
        timeout: 5000,
        ...options
      });
      return response;
    } catch (error) {
      lastError = error;
      if (i === retries - 1) break;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
  throw lastError;
};

async function pollPredictedGasPrice() {
  try {
    const [gasResponse, rpcResponse] = await Promise.all([
      fetchWithRetry(PREDICTED_GAS_API, { params: { chainid: CHAIN_ID } }),
      fetchWithRetry(SEI_RPC_API)
    ]);

    const syncInfo = rpcResponse.data?.sync_info;
    if (!syncInfo?.latest_block_height) return;

    const blockNumber = parseInt(syncInfo.latest_block_height, 10);
    const timestamp = syncInfo.latest_block_time;
    const blockPrices = gasResponse.data?.blockPrices?.[0];

    if (!blockPrices) return;

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
        data: {
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1
        }
      }),
      fetchWithRetry(EVM_RPC_API, {
        method: 'POST',
        data: {
          jsonrpc: '2.0',
          method: 'eth_gasPrice',
          params: [],
          id: 1
        }
      })
    ]);

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

// Optimized chart data endpoint
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

// Initialize polling
const POLL_INTERVAL = {
  PREDICTED: 5000,  // 5 seconds
  SEI: 500         // 500ms
};

setInterval(pollPredictedGasPrice, POLL_INTERVAL.PREDICTED);
setInterval(pollSeiGasPrice, POLL_INTERVAL.SEI);

// Simple error handler that doesn't expose internal details
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  pollPredictedGasPrice();
  pollSeiGasPrice();
});