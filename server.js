import axios from 'axios';
import express from 'express';
import Database from 'better-sqlite3';

const app = express();
const PORT = 3303;
const DB_WRITE_INTERVAL = 10000; // 10 seconds
let lastDbWrite = Date.now();

// Initialize SQLite database
const db = new Database('gas_prices.db');

// Optimize database
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

CREATE INDEX IF NOT EXISTS idx_timestamp ON gas_prices(timestamp);
CREATE INDEX IF NOT EXISTS idx_block_height ON gas_prices(blockNumber);
`);

// Cache
let seiDataCache = [];
let evmDataCache = [];

// Sampling rates (in seconds)
const sampleRates = {
  '1h': 1,      // Every block
  '6h': 30,     // Every 30 seconds
  '12h': 60,    // Every minute
  '24h': 300,   // Every 5 minutes
  '72h': 900,   // Every 15 minutes
  '7d': 3600    // Every hour
};

function sampleData(data, timeframe) {
  const rate = sampleRates[timeframe];
  if (!rate) return data;
  return data.filter((_, i) => i % rate === 0);
}

// Rest of your existing polling and API code...

// Modified chart-data endpoint
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
    SELECT *
    FROM gas_prices
    WHERE timestamp >= ?
    ORDER BY blockNumber ASC
    `).all(timeFilter);

    const seiData = sampleData(rows.map(r => ({
      blockNumber: r.blockNumber,
      timestamp: r.timestamp,
      confidence99: r.confidence99
    })), range);

    const evmData = sampleData(rows.map(r => ({
      blockNumber: r.blockNumber,
      timestamp: r.timestamp,
      confidence99: r.evmGasPrice
    })), range);

    res.json({ seiData, evmData });
  } catch (error) {
    console.error('Error fetching chart data:', error);
    res.status(500).json({ seiData: [], evmData: [] });
  }
});
