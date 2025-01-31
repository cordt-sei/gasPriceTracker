# Gas Price Tracker

Real-time monitoring dashboard for Sei Network gas prices, comparing predicted values from BlockNative's API against actual on-chain gas costs.

## Data Collection

- Predicted prices polled every 5 seconds via BlockNative API
- Actual gas prices fetched every 400ms (aligned with block production)
- All data points stored in SQLite with block height, timestamp, and confidence levels

## Visualization

Interactive time-series chart displaying dual metrics:

- Predicted gas prices (green line)
- Actual gas prices (red line)
- Configurable timeframes: 1h, 6h, 12h, 24h, 72h, 7d
