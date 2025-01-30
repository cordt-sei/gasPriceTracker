// buffer-system.js
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

    // Initialize buffer cleanup interval
    setInterval(() => this.cleanBuffer(), this.options.bufferTimeWindow);
    setInterval(() => this.flushToDatabase(), this.options.writeInterval);
  }

  addBlock(blockData) {
    const { blockNumber } = blockData;
    this.buffer.set(blockNumber, {
      ...blockData,
      timestamp: blockData.timestamp || new Date().toISOString(),
      addedAt: Date.now()
    });

    // Add to write buffer
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
    return {
      bufferSize: this.buffer.size,
      writeBufferSize: this.writeBuffer.size,
      oldestBlock: Math.min(...this.buffer.keys()),
      newestBlock: Math.max(...this.buffer.keys()),
      lastWrite: this.lastWrite
    };
  }
}

export default BlockBuffer;
