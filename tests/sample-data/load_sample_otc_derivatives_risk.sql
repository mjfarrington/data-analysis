-- Seed dataset for OTC derivatives + risk pipeline testing
-- Generates 200,000 rows per table using shared keys: (app_id, uid, uid_version)

CREATE TABLE IF NOT EXISTS sample_otc_trades (
  trade_row_id BIGSERIAL PRIMARY KEY,
  app_id VARCHAR(4) NOT NULL,
  uid VARCHAR(32) NOT NULL,
  uid_version INTEGER NOT NULL,
  trade_id VARCHAR(24) NOT NULL,
  trade_ts TIMESTAMP NOT NULL,
  product_type VARCHAR(24) NOT NULL,
  underlying_symbol VARCHAR(16) NOT NULL,
  notional NUMERIC(20,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  maturity_date DATE NOT NULL,
  counterparty VARCHAR(24) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sample_mtm_values (
  mtm_row_id BIGSERIAL PRIMARY KEY,
  app_id VARCHAR(4) NOT NULL,
  uid VARCHAR(32) NOT NULL,
  uid_version INTEGER NOT NULL,
  valuation_ts TIMESTAMP NOT NULL,
  mtm_local NUMERIC(20,2) NOT NULL,
  mtm_usd NUMERIC(20,2) NOT NULL,
  fx_rate NUMERIC(12,6) NOT NULL,
  pnl_day NUMERIC(20,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sample_risk_sensitivities (
  risk_row_id BIGSERIAL PRIMARY KEY,
  app_id VARCHAR(4) NOT NULL,
  uid VARCHAR(32) NOT NULL,
  uid_version INTEGER NOT NULL,
  as_of_date DATE NOT NULL,
  delta NUMERIC(20,8) NOT NULL,
  gamma NUMERIC(20,8) NOT NULL,
  vega NUMERIC(20,8) NOT NULL,
  theta NUMERIC(20,8) NOT NULL,
  rho NUMERIC(20,8) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sample_regulatory_risk_report (
  reg_row_id BIGSERIAL PRIMARY KEY,
  app_id VARCHAR(4) NOT NULL,
  uid VARCHAR(32) NOT NULL,
  uid_version INTEGER NOT NULL,
  report_date DATE NOT NULL,
  regulation_code VARCHAR(20) NOT NULL,
  risk_class VARCHAR(20) NOT NULL,
  sa_ccr_ead NUMERIC(20,2) NOT NULL,
  risk_weight_pct NUMERIC(8,4) NOT NULL,
  rwea NUMERIC(20,2) NOT NULL,
  capital_requirement NUMERIC(20,2) NOT NULL,
  breach_flag BOOLEAN NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otc_keys ON sample_otc_trades (app_id, uid, uid_version);
CREATE INDEX IF NOT EXISTS idx_mtm_keys ON sample_mtm_values (app_id, uid, uid_version);
CREATE INDEX IF NOT EXISTS idx_sens_keys ON sample_risk_sensitivities (app_id, uid, uid_version);
CREATE INDEX IF NOT EXISTS idx_reg_keys ON sample_regulatory_risk_report (app_id, uid, uid_version);

TRUNCATE TABLE sample_otc_trades RESTART IDENTITY;
TRUNCATE TABLE sample_mtm_values RESTART IDENTITY;
TRUNCATE TABLE sample_risk_sensitivities RESTART IDENTITY;
TRUNCATE TABLE sample_regulatory_risk_report RESTART IDENTITY;

-- Shared key-space for all 4 tables to keep identifiers consistent across datasets.
DROP TABLE IF EXISTS _seed_common_keys;
CREATE TEMP TABLE _seed_common_keys AS
SELECT
  gs,
  CASE WHEN gs % 2 = 0 THEN 'AP01' ELSE 'AP02' END AS app_id,
  'UID' || LPAD(gs::text, 9, '0') AS uid,
  ((gs % 5) + 1) AS uid_version,
  DATE '2026-01-01' + ((gs % 120)::int) AS as_of_date
FROM generate_series(1, 200000) AS gs;

INSERT INTO sample_otc_trades (
  app_id, uid, uid_version, trade_id, trade_ts, product_type,
  underlying_symbol, notional, currency, maturity_date, counterparty
)
SELECT
  k.app_id,
  k.uid,
  k.uid_version,
  'OTC' || LPAD(k.gs::text, 10, '0') AS trade_id,
  TIMESTAMP '2026-01-01 00:00:00'
    + ((k.gs % 90) || ' days')::interval
    + ((k.gs % 86400) || ' seconds')::interval AS trade_ts,
  (ARRAY['IRS','CDS','FX_OPTION','EQUITY_OPTION','COMMODITY_SWAP'])[1 + (k.gs % 5)] AS product_type,
  (ARRAY['AAPL','MSFT','NVDA','TSLA','AMZN','EURUSD','GBPUSD','XAUUSD'])[1 + (k.gs % 8)] AS underlying_symbol,
  ROUND((500000 + (random() * 25000000))::numeric, 2) AS notional,
  (ARRAY['USD','EUR','GBP'])[1 + (k.gs % 3)] AS currency,
  k.as_of_date + ((k.gs % 720)::int) AS maturity_date,
  'CP' || LPAD(((k.gs % 1500) + 1)::text, 5, '0') AS counterparty
FROM _seed_common_keys k;

INSERT INTO sample_mtm_values (
  app_id, uid, uid_version, valuation_ts, mtm_local, mtm_usd, fx_rate, pnl_day
)
SELECT
  k.app_id,
  k.uid,
  k.uid_version,
  TIMESTAMP '2026-04-01 00:00:00'
    + ((k.gs % 30) || ' days')::interval
    + ((k.gs % 86400) || ' seconds')::interval AS valuation_ts,
  ROUND(((-2500000) + (random() * 5000000))::numeric, 2) AS mtm_local,
  ROUND(((-2400000) + (random() * 4800000))::numeric, 2) AS mtm_usd,
  ROUND((0.75 + (random() * 0.5))::numeric, 6) AS fx_rate,
  ROUND(((-250000) + (random() * 500000))::numeric, 2) AS pnl_day
FROM _seed_common_keys k;

INSERT INTO sample_risk_sensitivities (
  app_id, uid, uid_version, as_of_date, delta, gamma, vega, theta, rho
)
SELECT
  k.app_id,
  k.uid,
  k.uid_version,
  k.as_of_date,
  ROUND(((-1.00) + (random() * 2.00))::numeric, 8) AS delta,
  ROUND((random() * 0.15000000)::numeric, 8) AS gamma,
  ROUND((random() * 250000)::numeric, 8) AS vega,
  ROUND(((-15000) + (random() * 30000))::numeric, 8) AS theta,
  ROUND(((-50000) + (random() * 100000))::numeric, 8) AS rho
FROM _seed_common_keys k;

INSERT INTO sample_regulatory_risk_report (
  app_id, uid, uid_version, report_date, regulation_code, risk_class,
  sa_ccr_ead, risk_weight_pct, rwea, capital_requirement, breach_flag
)
SELECT
  k.app_id,
  k.uid,
  k.uid_version,
  DATE '2026-04-30' AS report_date,
  (ARRAY['BASEL3.1','CRR3'])[1 + (k.gs % 2)] AS regulation_code,
  (ARRAY['COUNTERPARTY_CREDIT','MARKET_RISK','CVA'])[1 + (k.gs % 3)] AS risk_class,
  ROUND((25000 + (random() * 3000000))::numeric, 2) AS sa_ccr_ead,
  ROUND((0.0500 + (random() * 0.9500))::numeric, 4) AS risk_weight_pct,
  ROUND((15000 + (random() * 2500000))::numeric, 2) AS rwea,
  ROUND((1200 + (random() * 300000))::numeric, 2) AS capital_requirement,
  (k.gs % 97 = 0) AS breach_flag
FROM _seed_common_keys k;

DROP TABLE IF EXISTS _seed_common_keys;

SELECT 'sample_otc_trades' AS table_name, COUNT(*) AS row_count FROM sample_otc_trades
UNION ALL
SELECT 'sample_mtm_values' AS table_name, COUNT(*) AS row_count FROM sample_mtm_values
UNION ALL
SELECT 'sample_risk_sensitivities' AS table_name, COUNT(*) AS row_count FROM sample_risk_sensitivities
UNION ALL
SELECT 'sample_regulatory_risk_report' AS table_name, COUNT(*) AS row_count FROM sample_regulatory_risk_report
ORDER BY table_name;