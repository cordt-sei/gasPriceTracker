// buffer.js

import Database from 'better-sqlite3';

class BlockBuffer {
  constructor(dbPath, options = {}) {
    this.buffer = new Map();
    this.writeBuffer = new Map();
    this.db = new Database(dbPath, { verbose: console.log });
    this.lastWrite = Date.now();
    this.options = {
      bufferTimeWindow: 30000, // 30 second buffer
      writeInterval: 5000,     // Batch write every 5 seconds
      ...options
    };

    // Initialize database schema
    this.initializeDatabase();

    // Initialize buffer cleanup interval
    setInterval(() => this.cleanBuffer(), this.options.bufferTimeWindow);
    setInterval(() => this.flushToDatabase(), this.options.writeInterval);
  }

  initializeDatabase() {
    console.log('Initializing database...');
    this.db.exec(`
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

    const tableInfo = this.db.prepare('PRAGMA table_info(gas_prices)').all();
    console.log('Table schema:', tableInfo);
  }

  addBlock(blockData) {
    const { blockNumber } = blockData;
    this.buffer.set(blockNumber, {
      ...blockData,
      timestamp: blockData.timestamp || new Date().toISOString(),
      addedAt: Date.now()
    });
    this.writeBuffer.set(blockNumber, blockData);
  }

  getRecentBlocks(timeWindow = 15000) {
    const cutoffTime = Date.now() - timeWindow;
    return Array.from(this.buffer.values())
      .filter(block => block.addedAt >= cutoffTime)
      .sort((a, b) => a.blockNumber - b.blockNumber);
  }

  cleanBuffer() {
    const cutoffTime = Date.now() - this.options.bufferTimeWindow;
    for (const [blockNumber, data] of this.buffer.entries()) {
      if (data.addedAt < cutoffTime) {
        this.buffer.delete(blockNumber);
      }
    }
  }

  async flushToDatabase() {
    if (this.writeBuffer.size === 0) return;
    
    const batchInsert = this.db.prepare(`
      INSERT OR REPLACE INTO gas_prices (
        blockNumber, timestamp, baseFeePerGas,
        confidence50, confidence70, confidence90, confidence99,
        seiGasPrice
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((blocks) => {
      for (const block of blocks) {
        batchInsert.run(
          block.blockNumber,
          block.timestamp,
          block.baseFeePerGas,
          block.confidence50 || null,
          block.confidence70 || null,
          block.confidence90 || null,
          block.confidence99 || null,
          block.seiGasPrice || null
        );
      }
    });

    try {
      const blocksToWrite = Array.from(this.writeBuffer.values());
      insertMany(blocksToWrite);
      this.writeBuffer.clear();
      this.lastWrite = Date.now();
    } catch (error) {
      console.error('Error writing batch to database:', error);
    }
  }

  getBufferStats() {
    const blocks = Array.from(this.buffer.keys());
    return {
      bufferSize: this.buffer.size,
      writeBufferSize: this.writeBuffer.size,
      oldestBlock: blocks.length ? Math.min(...blocks) : 0,
      newestBlock: blocks.length ? Math.max(...blocks) : 0,
      lastWrite: this.lastWrite
    };
  }
}

export default BlockBuffer;