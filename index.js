import axios from 'axios';
import Database from 'better-sqlite3';

const SEI_RPC_API = 'https://rpc.sei.basementnodes.ca/status';
const GAS_PRICE_API = 'https://api.blocknative.com/gasprices/blockprices';
const EVM_RPC_API = 'https://evm-rpc.sei.basementnodes.ca';
const SEI_POLL_INTERVAL = 5000; // 5 seconds for Blocknative API
const EVM_POLL_INTERVAL = 400; // 400ms for EVM RPC
const CHAIN_ID = 1329; // Sei network chain ID

let seiDataCache = [];
let evmDataCache = [];

// Initialize SQLite database
const db = new Database('gas_prices.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS gas_prices (
    blockNumber INTEGER PRIMARY KEY,
    timestamp TEXT,
    baseFeePerGas REAL,
    confidence50 REAL,
    confidence70 REAL,
    confidence90 REAL,
    confidence99 REAL
  );
`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO gas_prices (blockNumber, timestamp, baseFeePerGas, confidence50, confidence70, confidence90, confidence99)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const fetchSeiGasPrices = async () => {
  try {
    const [gasResponse, rpcResponse] = await Promise.all([
      axios.get(GAS_PRICE_API, { params: { chainid: CHAIN_ID } }),
      axios.get(SEI_RPC_API),
    ]);

    const syncInfo = rpcResponse.data?.sync_info;
    if (!syncInfo?.latest_block_height || !syncInfo?.latest_block_time) {
      console.error("Invalid Sei RPC response format or missing fields:", rpcResponse.data);
      return [];
    }

    const currentBlockHeight = parseInt(syncInfo.latest_block_height, 10);
    const currentBlockTime = syncInfo.latest_block_time;

    if (!gasResponse.data.blockPrices?.length) {
      console.warn("No valid gas price data from Blocknative API:", gasResponse.data);
      return [];
    }

    const block = gasResponse.data.blockPrices[0];
    const baseFee = block.baseFeePerGas;
    const confidences = block.estimatedPrices.reduce((acc, curr) => {
      acc[`confidence${curr.confidence}`] = curr.price;
      return acc;
    }, {});

    insertStmt.run(
      currentBlockHeight,
      currentBlockTime,
      baseFee,
      confidences.confidence50 || null,
      confidences.confidence70 || null,
      confidences.confidence90 || null,
      confidences.confidence99 || null
    );

    seiDataCache = [
      {
        blockNumber: currentBlockHeight,
        timestamp: currentBlockTime,
        confidence99: confidences.confidence99 || null,
      },
    ];
    return seiDataCache;
  } catch (error) {
    console.error("Error fetching Sei gas prices:", error.message);
    return [];
  }
};

const fetchEvmGasPrices = async () => {
  try {
    const response = await axios.post(
      EVM_RPC_API,
      {
        jsonrpc: '2.0',
        method: 'eth_gasPrice',
        params: [],
        id: 1,
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const gasPriceWei = parseInt(response.data.result, 16); // Convert from Wei to decimal
    const gasPriceGwei = gasPriceWei / 1e9;

    evmDataCache = [
      {
        blockNumber: 'N/A',
        timestamp: new Date().toISOString(),
        confidence99: gasPriceGwei,
      },
    ];
    return evmDataCache;
  } catch (error) {
    console.error('Error fetching EVM gas prices:', error.message);
    return [];
  }
};

// polling for current price data
setInterval(fetchSeiGasPrices, SEI_POLL_INTERVAL);
setInterval(fetchEvmGasPrices, EVM_POLL_INTERVAL);

export { seiDataCache, evmDataCache };
