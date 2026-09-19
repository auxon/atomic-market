-- Generic atomic-swap order book. Pet-specific columns are gone on purpose:
-- per-asset display lives in metadata JSON, policy in fee_bps/fee_address.
CREATE TABLE IF NOT EXISTS listings (
  origin TEXT PRIMARY KEY,          -- "<txid>.<vout>" of the asset outpoint
  asset_kind TEXT NOT NULL,         -- "ordinal" | "bsv21"
  title TEXT NOT NULL,
  image TEXT,
  description TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  price_sats INTEGER NOT NULL,
  seller TEXT NOT NULL,             -- seller address
  seller_handle TEXT,
  seller_unlock TEXT,               -- atomic offer pre-sig (SINGLE|ANYONECANPAY); null = direct sale
  pay_script TEXT,                  -- seller P2PKH hex (atomic offers)
  input_script TEXT,                -- carrier locking script hex (atomic offers; buyers verify against chain)
  token_id TEXT,                    -- bsv21 "<txid>_<vout>"
  token_amount TEXT,                -- bsv21 base units, decimal string
  fee_bps INTEGER NOT NULL DEFAULT 200,
  fee_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active|paid|sold|cancelled
  buy_txid TEXT,
  buyer_handle TEXT,
  transfer_txid TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings (status);
CREATE INDEX IF NOT EXISTS idx_listings_kind ON listings (asset_kind);
