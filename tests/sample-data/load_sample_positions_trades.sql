CREATE TABLE IF NOT EXISTS sample_positions (
  position_id BIGSERIAL PRIMARY KEY,
  app_id VARCHAR(10) NOT NULL,
  uid VARCHAR(32) NOT NULL,
  uid_version INTEGER NOT NULL,
  account VARCHAR(20) NOT NULL,
  as_of_date DATE NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  market_value NUMERIC(20,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sample_trades (
  trade_row_id BIGSERIAL PRIMARY KEY,
  app_id VARCHAR(10) NOT NULL,
  uid VARCHAR(32) NOT NULL,
  uid_version INTEGER NOT NULL,
  account VARCHAR(20) NOT NULL,
  trade_id VARCHAR(24) NOT NULL,
  trade_ts TIMESTAMP NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  side VARCHAR(4) NOT NULL,
  quantity NUMERIC(18,4) NOT NULL,
  price NUMERIC(18,6) NOT NULL,
  notional NUMERIC(20,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sample_positions_app_uid ON sample_positions (app_id, uid);
CREATE INDEX IF NOT EXISTS idx_sample_trades_app_uid ON sample_trades (app_id, uid);

TRUNCATE TABLE sample_positions;
TRUNCATE TABLE sample_trades;

INSERT INTO sample_positions (app_id, uid, uid_version, account, as_of_date, symbol, quantity, market_value, currency)
SELECT
  'APP001' AS app_id,
  'UID' || LPAD(gs::text, 8, '0') AS uid,
  ((gs % 5) + 1) AS uid_version,
  'ACC' || LPAD(((gs % 25000) + 1)::text, 6, '0') AS account,
  DATE '2026-01-01' + ((gs % 115)::int) AS as_of_date,
  (ARRAY['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','JPM','XOM','EURUSD'])[1 + (gs % 10)] AS symbol,
  ROUND((10 + (random() * 5000))::numeric, 4) AS quantity,
  ROUND((1000 + (random() * 5000000))::numeric, 2) AS market_value,
  (ARRAY['USD','EUR','GBP'])[1 + (gs % 3)] AS currency
FROM generate_series(1, 250000) AS gs;

INSERT INTO sample_trades (app_id, uid, uid_version, account, trade_id, trade_ts, symbol, side, quantity, price, notional, currency)
SELECT
  'APP001' AS app_id,
  'UID' || LPAD(gs::text, 8, '0') AS uid,
  ((gs % 5) + 1) AS uid_version,
  'ACC' || LPAD(((gs % 25000) + 1)::text, 6, '0') AS account,
  'TRD' || LPAD(gs::text, 9, '0') AS trade_id,
  TIMESTAMP '2026-01-01 00:00:00' + ((gs % 90) || ' days')::interval + ((gs % 86400) || ' seconds')::interval AS trade_ts,
  (ARRAY['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','JPM','XOM','EURUSD'])[1 + (gs % 10)] AS symbol,
  (ARRAY['BUY','SELL'])[1 + (gs % 2)] AS side,
  ROUND((1 + (random() * 2000))::numeric, 4) AS quantity,
  ROUND((10 + (random() * 800))::numeric, 6) AS price,
  ROUND(((1 + (random() * 2000)) * (10 + (random() * 800)))::numeric, 2) AS notional,
  (ARRAY['USD','EUR','GBP'])[1 + (gs % 3)] AS currency
FROM generate_series(1, 250000) AS gs;

SELECT 'sample_positions' AS table_name, COUNT(*) AS row_count FROM sample_positions
UNION ALL
SELECT 'sample_trades' AS table_name, COUNT(*) AS row_count FROM sample_trades;
