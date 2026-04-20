"""
generate_trades.py
------------------
Connects to PostgreSQL via psycopg2, creates (or recreates) the `sample_data`
database, and populates a `trades` table with synthetic derivatives trades.

Usage:
    python generate_trades.py

Run as many times as you like — it drops and recreates everything cleanly.

Requirements:
    pip install psycopg2-binary faker
"""

import random
import string
from datetime import date, datetime, timedelta

import psycopg2
import psycopg2.extras
from faker import Faker

# ── Connection params ─────────────────────────────────────────────────────────

PG_HOST = "localhost"
PG_PORT = 5432
PG_ADMIN_DB = "postgres"   # admin db used to create/drop target db
PG_USER = "postgres"
PG_PASSWORD = "postgres"
TARGET_DB = "sample_data"

NUM_TRADES = 1_000_000
BATCH_SIZE = 5_000

# ── Reference data ────────────────────────────────────────────────────────────

PRODUCT_TYPES = ["IRS", "CDS", "FX Forward", "FX Option", "Equity Swap",
                 "Commodity Swap", "Variance Swap", "Total Return Swap",
                 "Interest Rate Cap", "Interest Rate Floor", "Swaption",
                 "Credit Index", "Equity Option", "Basis Swap"]

INSTRUMENTS = {
    "IRS":               ["Vanilla IRS", "OIS", "Amortising IRS", "Step-up IRS"],
    "CDS":               ["Single Name CDS", "CDS Index", "Tranche CDS"],
    "FX Forward":        ["Outright Forward", "NDF", "FX Swap"],
    "FX Option":         ["European FX Option", "American FX Option", "Barrier Option"],
    "Equity Swap":       ["Total Return Equity Swap", "Price Return Swap"],
    "Commodity Swap":    ["Fixed-Float Commodity Swap", "Basis Commodity Swap"],
    "Variance Swap":     ["Equity Variance Swap", "Index Variance Swap"],
    "Total Return Swap": ["TRS on Bond", "TRS on Loan", "TRS on Index"],
    "Interest Rate Cap": ["Cap", "Caplet"],
    "Interest Rate Floor": ["Floor", "Floorlet"],
    "Swaption":          ["Payer Swaption", "Receiver Swaption", "Straddle"],
    "Credit Index":      ["CDX IG", "CDX HY", "iTraxx Europe", "iTraxx Crossover"],
    "Equity Option":     ["Call", "Put", "Straddle", "Strangle"],
    "Basis Swap":        ["3M/6M Basis", "OIS/LIBOR Basis", "Cross Currency Basis"],
}

CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "SEK",
              "NOK", "HKD", "SGD", "MXN", "BRL", "ZAR"]

CURRENCY_PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "AUD/USD",
                  "USD/CAD", "EUR/GBP", "EUR/JPY", "GBP/JPY", "USD/HKD"]

UNDERLYINGS = {
    "IRS":               ["USD SOFR", "EUR EURIBOR 3M", "GBP SONIA", "JPY TONAR"],
    "CDS":               ["Ford Motor", "Deutsche Bank", "Italy Sovereign", "CDX IG 5Y"],
    "FX Forward":        CURRENCY_PAIRS,
    "FX Option":         CURRENCY_PAIRS,
    "Equity Swap":       ["SPX", "SX5E", "NKY", "FTSE 100", "CAC 40", "DAX"],
    "Commodity Swap":    ["WTI Crude", "Brent Crude", "Natural Gas", "Gold", "Silver", "Copper"],
    "Variance Swap":     ["SPX", "SX5E", "NKY", "FTSE 100"],
    "Total Return Swap": ["US High Yield Index", "EUR IG Corporate", "Loan Portfolio A"],
    "Interest Rate Cap": ["USD SOFR", "EUR EURIBOR 3M"],
    "Interest Rate Floor": ["USD SOFR", "EUR EURIBOR 3M"],
    "Swaption":          ["USD 5Y IRS", "EUR 10Y IRS", "GBP 2Y IRS"],
    "Credit Index":      ["CDX IG 5Y", "CDX HY 5Y", "iTraxx Europe 5Y"],
    "Equity Option":     ["SPX", "AAPL", "TSLA", "NVDA", "MSFT", "SX5E"],
    "Basis Swap":        ["USD 3M/6M", "EUR 3M/6M", "EUR OIS/EURIBOR"],
}

TENORS = ["1W", "2W", "1M", "3M", "6M", "9M", "1Y", "18M", "2Y",
          "3Y", "4Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"]

COUNTERPARTIES = [
    "Goldman Sachs", "JP Morgan", "Morgan Stanley", "Citigroup", "Bank of America",
    "Deutsche Bank", "Barclays", "HSBC", "BNP Paribas", "Societe Generale",
    "Credit Suisse", "UBS", "RBC", "TD Securities", "Nomura", "Mizuho",
    "Wells Fargo", "Macquarie", "Natixis", "ING", "Standard Chartered",
    "Credit Agricole", "Santander", "BBVA", "UniCredit",
]

TRADING_DESKS = ["Rates", "Credit", "FX", "Equity Derivatives",
                 "Commodity", "Exotics", "Structured Products"]

BOOKS = [f"BK-{d[:3].upper()}-{i:02d}" for d in TRADING_DESKS for i in range(1, 5)]

PORTFOLIOS = [f"PORT-{s}" for s in ["HEDGE", "PROP", "CLIENT", "MM", "FLOW", "STRUCT"]]

STATUSES = ["LIVE", "LIVE", "LIVE", "LIVE", "LIVE",   # weight live heavily
            "TERMINATED", "TERMINATED", "MATURED", "CANCELLED"]

LEGAL_ENTITIES = ["BANK_UK_LTD", "BANK_US_NA", "BANK_EU_SA", "BANK_ASIA_LTD"]

DAY_COUNT = ["ACT/360", "ACT/365", "30/360", "ACT/ACT"]

PAYMENT_FREQ = ["Monthly", "Quarterly", "Semi-Annual", "Annual"]

CLEARING_HOUSES = ["LCH", "CME", "Eurex", "JSCC", None, None]  # None = bilateral

# App IDs for the ETL pipeline
APPS = [
    ("APP001", "Rates Risk Engine"),
    ("APP002", "Credit Analytics"),
    ("APP003", "FX Front Office"),
    ("APP004", "Equity Derivatives System"),
    ("APP005", "Commodity Trading Platform"),
]

# ── Helpers ───────────────────────────────────────────────────────────────────

fake = Faker()
rng = random.Random(42)   # seeded for reproducibility


def rand_id(prefix: str, n: int = 8) -> str:
    return prefix + "".join(rng.choices(string.digits, k=n))


def rand_date(start: date, end: date) -> date:
    delta = (end - start).days
    return start + timedelta(days=rng.randint(0, delta))


def rand_notional() -> float:
    """Realistic notional: clustered around 1M, 10M, 50M, 100M, 500M."""
    buckets = [
        (0.35,  1_000_000,    9_999_999),
        (0.30, 10_000_000,   49_999_999),
        (0.20, 50_000_000,  199_999_999),
        (0.10, 200_000_000, 999_999_999),
        (0.05, 1_000_000_000, 5_000_000_000),
    ]
    r = rng.random()
    cum = 0
    for prob, lo, hi in buckets:
        cum += prob
        if r <= cum:
            return round(rng.uniform(lo, hi), -3)
    return 1_000_000.0


def rand_rate() -> float:
    return round(rng.uniform(-0.005, 0.09), 6)


def rand_spread() -> float:
    return round(rng.uniform(0.0005, 0.05), 6)


def rand_strike() -> float:
    return round(rng.uniform(50, 6000), 4)


def generate_trade(trade_num: int, business_dates: list[date]) -> tuple:
    product_type = rng.choice(PRODUCT_TYPES)
    instrument   = rng.choice(INSTRUMENTS[product_type])
    underlying   = rng.choice(UNDERLYINGS[product_type])
    tenor        = rng.choice(TENORS)
    currency     = rng.choice(CURRENCIES)

    trade_date   = rand_date(date(2022, 1, 1), date(2025, 12, 31))
    maturity_date = trade_date + timedelta(
        days=rng.choice([90, 180, 365, 730, 1095, 1825, 2555, 3650])
    )
    settlement_date = trade_date + timedelta(days=rng.choice([0, 1, 2, 3]))

    notional      = rand_notional()
    notional_2    = notional * rng.uniform(0.95, 1.05) if product_type in ("Cross Currency Basis", "FX Forward") else None
    currency_2    = rng.choice([c for c in CURRENCIES if c != currency]) if notional_2 else None

    fixed_rate    = rand_rate() if product_type in ("IRS", "Basis Swap", "Interest Rate Cap", "Interest Rate Floor") else None
    spread        = rand_spread() if product_type in ("CDS", "Credit Index", "Total Return Swap") else None
    strike_price  = rand_strike() if product_type in ("FX Option", "Equity Option", "Swaption") else None
    premium       = round(notional * rng.uniform(0.0001, 0.05), 2) if strike_price else None
    fx_rate       = round(rng.uniform(0.65, 160), 6) if product_type in ("FX Forward", "FX Option") else None

    pay_leg_currency = currency
    receive_leg_currency = rng.choice([c for c in CURRENCIES if c != currency])
    day_count        = rng.choice(DAY_COUNT)
    payment_freq     = rng.choice(PAYMENT_FREQ)

    book          = rng.choice(BOOKS)
    portfolio     = rng.choice(PORTFOLIOS)
    desk          = rng.choice(TRADING_DESKS)
    counterparty  = rng.choice(COUNTERPARTIES)
    legal_entity  = rng.choice(LEGAL_ENTITIES)
    status        = rng.choice(STATUSES)
    clearing      = rng.choice(CLEARING_HOUSES)

    # Risk/PnL
    mtm_value     = round(rng.uniform(-5_000_000, 5_000_000), 2)
    dv01          = round(rng.uniform(-50_000, 50_000), 2) if product_type in ("IRS", "Basis Swap", "Swaption", "Interest Rate Cap", "Interest Rate Floor") else None
    cs01          = round(rng.uniform(-20_000, 20_000), 2) if product_type in ("CDS", "Credit Index", "Total Return Swap") else None
    delta         = round(rng.uniform(-1, 1), 6) if product_type in ("FX Option", "Equity Option", "Swaption", "Equity Swap") else None
    gamma         = round(rng.uniform(-0.01, 0.01), 8) if delta is not None else None
    vega          = round(rng.uniform(-100_000, 100_000), 2) if delta is not None else None

    # Classification
    asset_class   = (
        "Rates" if product_type in ("IRS", "Basis Swap", "Swaption", "Interest Rate Cap", "Interest Rate Floor")
        else "Credit" if product_type in ("CDS", "Credit Index")
        else "FX" if product_type in ("FX Forward", "FX Option")
        else "Equity" if product_type in ("Equity Swap", "Equity Option", "Variance Swap")
        else "Commodity"
    )

    regulation    = rng.choice(["EMIR", "CFTC", "MiFID II", "SFTR"])
    is_cleared    = clearing is not None
    uti           = rand_id("UTI-")
    usi           = rand_id("USI-") if regulation == "CFTC" else None

    # App / business date (for ETL targeting)
    app_id, app_name = rng.choice(APPS)
    business_date    = rng.choice(business_dates)

    created_at    = fake.date_time_between(start_date="-3y", end_date="now")
    updated_at    = fake.date_time_between(start_date=created_at, end_date="now")

    return (
        f"TRD-{trade_num:07d}",  # unique sequential trade ID
        product_type,
        instrument,
        asset_class,
        underlying,
        currency,
        tenor,
        trade_date,
        settlement_date,
        maturity_date,
        notional,
        notional_2,
        currency_2,
        fixed_rate,
        spread,
        strike_price,
        premium,
        fx_rate,
        pay_leg_currency,
        receive_leg_currency,
        day_count,
        payment_freq,
        book,
        portfolio,
        desk,
        counterparty,
        legal_entity,
        status,
        clearing,
        is_cleared,
        mtm_value,
        dv01,
        cs01,
        delta,
        gamma,
        vega,
        regulation,
        uti,
        usi,
        app_id,
        app_name,
        business_date,
        created_at,
        updated_at,
    )


CREATE_TABLE_SQL = """
CREATE TABLE trades (
    -- Identity
    trade_id            VARCHAR(20)     PRIMARY KEY,

    -- Product classification
    product_type        VARCHAR(50)     NOT NULL,
    instrument          VARCHAR(80)     NOT NULL,
    asset_class         VARCHAR(30)     NOT NULL,
    underlying          VARCHAR(80)     NOT NULL,
    currency            CHAR(3)         NOT NULL,
    tenor               VARCHAR(10),

    -- Lifecycle dates
    trade_date          DATE            NOT NULL,
    settlement_date     DATE,
    maturity_date       DATE,

    -- Notional & economics
    notional            NUMERIC(22, 2)  NOT NULL,
    notional_2          NUMERIC(22, 2),
    currency_2          CHAR(3),
    fixed_rate          NUMERIC(12, 6),
    spread              NUMERIC(12, 6),
    strike_price        NUMERIC(18, 4),
    premium             NUMERIC(22, 2),
    fx_rate             NUMERIC(18, 6),

    -- Leg conventions
    pay_leg_currency    CHAR(3),
    receive_leg_currency CHAR(3),
    day_count           VARCHAR(10),
    payment_frequency   VARCHAR(20),

    -- Organisational
    book                VARCHAR(20)     NOT NULL,
    portfolio           VARCHAR(20),
    trading_desk        VARCHAR(40),
    counterparty        VARCHAR(60)     NOT NULL,
    legal_entity        VARCHAR(30),

    -- Status & clearing
    status              VARCHAR(20)     NOT NULL DEFAULT 'LIVE',
    clearing_house      VARCHAR(20),
    is_cleared          BOOLEAN         NOT NULL DEFAULT FALSE,

    -- Risk / PnL
    mtm_value           NUMERIC(22, 2),
    dv01                NUMERIC(18, 2),
    cs01                NUMERIC(18, 2),
    delta               NUMERIC(12, 6),
    gamma               NUMERIC(14, 8),
    vega                NUMERIC(18, 2),

    -- Regulation
    regulation          VARCHAR(20),
    uti                 VARCHAR(30),
    usi                 VARCHAR(30),

    -- ETL / pipeline fields
    app_id              VARCHAR(10)     NOT NULL,
    app_name            VARCHAR(60)     NOT NULL,
    business_date       DATE            NOT NULL,

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP       NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX idx_trades_business_date  ON trades (business_date);
CREATE INDEX idx_trades_app_id         ON trades (app_id);
CREATE INDEX idx_trades_trade_date     ON trades (trade_date);
CREATE INDEX idx_trades_product_type   ON trades (product_type);
CREATE INDEX idx_trades_asset_class    ON trades (asset_class);
CREATE INDEX idx_trades_status         ON trades (status);
CREATE INDEX idx_trades_counterparty   ON trades (counterparty);
CREATE INDEX idx_trades_book           ON trades (book);
CREATE INDEX idx_trades_app_business   ON trades (app_id, business_date);
"""

INSERT_COLS = """
    trade_id, product_type, instrument, asset_class, underlying, currency, tenor,
    trade_date, settlement_date, maturity_date,
    notional, notional_2, currency_2, fixed_rate, spread, strike_price, premium, fx_rate,
    pay_leg_currency, receive_leg_currency, day_count, payment_frequency,
    book, portfolio, trading_desk, counterparty, legal_entity,
    status, clearing_house, is_cleared,
    mtm_value, dv01, cs01, delta, gamma, vega,
    regulation, uti, usi,
    app_id, app_name, business_date,
    created_at, updated_at
"""


def admin_conn():
    return psycopg2.connect(host=PG_HOST, port=PG_PORT, dbname=PG_ADMIN_DB,
                            user=PG_USER, password=PG_PASSWORD)


def target_conn():
    return psycopg2.connect(host=PG_HOST, port=PG_PORT, dbname=TARGET_DB,
                            user=PG_USER, password=PG_PASSWORD)


def drop_and_create_db():
    con = admin_conn()
    con.autocommit = True
    cur = con.cursor()

    print(f"Dropping database '{TARGET_DB}' if it exists…")
    cur.execute(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
        "WHERE datname = %s AND pid <> pg_backend_pid()",
        (TARGET_DB,)
    )
    cur.execute(f'DROP DATABASE IF EXISTS "{TARGET_DB}"')
    print(f"Creating database '{TARGET_DB}'…")
    cur.execute(f'CREATE DATABASE "{TARGET_DB}"')
    cur.close()
    con.close()


def create_schema():
    con = target_conn()
    cur = con.cursor()
    print("Creating trades table and indexes…")
    cur.execute(CREATE_TABLE_SQL)
    con.commit()
    cur.close()
    con.close()


def insert_trades():
    today = date.today()
    business_dates = [today - timedelta(days=i * 5) for i in range(60)]

    col_names = [c.strip() for c in INSERT_COLS.split(",") if c.strip()]
    sql = f"INSERT INTO trades ({INSERT_COLS}) VALUES %s"

    con = target_conn()
    cur = con.cursor()
    total = 0
    print(f"Inserting {NUM_TRADES:,} trades in batches of {BATCH_SIZE:,}…")

    for batch_start in range(0, NUM_TRADES, BATCH_SIZE):
        batch = [
            generate_trade(i, business_dates)
            for i in range(batch_start, min(batch_start + BATCH_SIZE, NUM_TRADES))
        ]
        psycopg2.extras.execute_values(cur, sql, batch, page_size=BATCH_SIZE)
        con.commit()
        total += len(batch)
        print(f"  {total:>7,} / {NUM_TRADES:,} rows inserted")

    cur.close()
    con.close()


def print_summary():
    con = target_conn()
    cur = con.cursor()

    cur.execute("SELECT COUNT(*) FROM trades")
    total = cur.fetchone()[0]

    cur.execute("SELECT asset_class, COUNT(*) FROM trades GROUP BY 1 ORDER BY 2 DESC")
    by_class = cur.fetchall()

    cur.execute("SELECT app_id, app_name, COUNT(*) FROM trades GROUP BY 1, 2 ORDER BY 1")
    by_app = cur.fetchall()

    cur.execute("SELECT business_date, COUNT(*) FROM trades GROUP BY 1 ORDER BY 1 DESC LIMIT 5")
    by_date = cur.fetchall()

    cur.close()
    con.close()

    print("\n" + "═" * 50)
    print(f"  Total rows : {total:,}")
    print("\n  By asset class:")
    for cls, cnt in by_class:
        print(f"    {cls:<20} {cnt:>7,}")
    print("\n  By app:")
    for app_id, app_name, cnt in by_app:
        print(f"    {app_id}  {app_name:<35} {cnt:>7,}")
    print("\n  Most recent business dates:")
    for bd, cnt in by_date:
        print(f"    {bd}  {cnt:>7,} rows")
    print("═" * 50)


if __name__ == "__main__":
    drop_and_create_db()
    create_schema()
    insert_trades()
    print_summary()
    print("\nDone. Connect with:")
    print(f"  psql -h {PG_HOST} -p {PG_PORT} -U {PG_USER} -d {TARGET_DB}")
