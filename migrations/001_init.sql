CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE merchants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  email                 TEXT NOT NULL UNIQUE,
  password_hash         TEXT NOT NULL,
  webhook_url           TEXT,
  webhook_secret        TEXT NOT NULL,
  fee_percent           NUMERIC(6, 3) NOT NULL DEFAULT 1.0,
  settlement_schedule   TEXT NOT NULL DEFAULT 'daily',  -- daily | weekly | manual
  settlement_weekday    SMALLINT NOT NULL DEFAULT 1,     -- 0=Sunday .. 6=Saturday (weekly only)
  last_settled_at       TIMESTAMPTZ,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merchants_schedule_chk CHECK (settlement_schedule IN ('daily','weekly','manual')),
  CONSTRAINT merchants_fee_chk CHECK (fee_percent >= 0 AND fee_percent < 100)
);

CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  UUID NOT NULL REFERENCES merchants(id),
  label        TEXT NOT NULL DEFAULT 'default',
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_merchant_idx ON api_keys (merchant_id);

CREATE TABLE admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  role         TEXT NOT NULL,          -- merchant | admin
  subject_id   UUID NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where each merchant wants each asset settled.
CREATE TABLE payout_addresses (
  merchant_id  UUID NOT NULL REFERENCES merchants(id),
  asset        TEXT NOT NULL,
  address      TEXT NOT NULL,
  min_amount   NUMERIC(78, 0) NOT NULL DEFAULT 0,   -- base units; balance below this is carried over
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, asset)
);

-- Next HD derivation index per key family. EVM chains share one counter so that
-- an address is never reused for two invoices on different EVM networks.
CREATE TABLE hd_counters (
  family      TEXT PRIMARY KEY,
  next_index  BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE invoices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       UUID NOT NULL REFERENCES merchants(id),
  order_id          TEXT,
  description       TEXT,
  price_amount      NUMERIC(36, 8) NOT NULL,
  price_currency    TEXT NOT NULL,
  asset             TEXT,               -- NULL until the payer picks a currency on the hosted page
  chain             TEXT,
  address           TEXT,
  memo              TEXT,               -- TON: payment comment
  derivation_index  BIGINT,
  pay_amount        NUMERIC(78, 0),     -- in the asset's smallest unit
  rate              NUMERIC(36, 18),    -- price_currency per 1 asset at quote time
  amount_received   NUMERIC(78, 0) NOT NULL DEFAULT 0, -- confirmed
  amount_pending    NUMERIC(78, 0) NOT NULL DEFAULT 0, -- detected, not yet confirmed
  status            TEXT NOT NULL DEFAULT 'pending',
  is_late           BOOLEAN NOT NULL DEFAULT FALSE,
  success_url       TEXT,
  cancel_url        TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at        TIMESTAMPTZ NOT NULL,
  fee_percent       NUMERIC(6, 3),      -- snapshot of the merchant fee when the invoice was credited
  fee_amount        NUMERIC(78, 0) NOT NULL DEFAULT 0,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoices_status_chk CHECK (status IN ('pending','confirming','partially_paid','paid','expired','cancelled'))
);

CREATE UNIQUE INDEX invoices_merchant_order_uq ON invoices (merchant_id, order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX invoices_chain_address_uq ON invoices (chain, lower(address)) WHERE memo IS NULL AND address IS NOT NULL;
CREATE UNIQUE INDEX invoices_memo_uq ON invoices (chain, memo) WHERE memo IS NOT NULL;
CREATE INDEX invoices_watch_idx ON invoices (chain, status, expires_at);
CREATE INDEX invoices_merchant_created_idx ON invoices (merchant_id, created_at DESC);

CREATE TABLE deposits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID REFERENCES invoices(id),  -- NULL = unmatched (e.g. TON payment with unknown comment)
  chain          TEXT NOT NULL,
  asset          TEXT NOT NULL,
  tx_hash        TEXT NOT NULL,
  event_index    TEXT NOT NULL DEFAULT '0',     -- log index / message id within the tx
  from_address   TEXT,
  to_address     TEXT NOT NULL,
  memo           TEXT,
  amount         NUMERIC(78, 0) NOT NULL,
  block_number   BIGINT,
  block_hash     TEXT,
  confirmations  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending',
  detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at   TIMESTAMPTZ,
  swept_at       TIMESTAMPTZ,                   -- funds moved to the hot wallet (EVM/TRON)
  CONSTRAINT deposits_status_chk CHECK (status IN ('pending','confirmed','orphaned')),
  UNIQUE (chain, tx_hash, event_index)
);
CREATE INDEX deposits_invoice_idx ON deposits (invoice_id);
CREATE INDEX deposits_pending_idx ON deposits (chain, status) WHERE status = 'pending';
CREATE INDEX deposits_unswept_idx ON deposits (chain, to_address) WHERE status = 'confirmed' AND swept_at IS NULL;

-- Generic per-key cursor (last scanned EVM block, last TON logical time, ...).
CREATE TABLE cursors (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      UUID NOT NULL REFERENCES merchants(id),
  invoice_id       UUID REFERENCES invoices(id),
  event            TEXT NOT NULL,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | failed
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  last_status_code INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);
CREATE INDEX webhook_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

CREATE TABLE sweeps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain        TEXT NOT NULL,
  address      TEXT NOT NULL,          -- deposit address being swept
  asset        TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- gas_topup | sweep
  tx_hash      TEXT,
  amount       NUMERIC(78, 0),
  status       TEXT NOT NULL DEFAULT 'sent', -- sent | confirmed | failed
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sweeps_address_idx ON sweeps (chain, address);

CREATE TABLE payouts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID NOT NULL REFERENCES merchants(id),
  asset         TEXT NOT NULL,
  chain         TEXT NOT NULL,
  address       TEXT NOT NULL,
  amount        NUMERIC(78, 0) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending_approval',
  tx_hash       TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at   TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  CONSTRAINT payouts_status_chk CHECK (status IN ('pending_approval','approved','sending','sent','completed','failed','rejected'))
);
CREATE INDEX payouts_merchant_idx ON payouts (merchant_id, created_at DESC);
CREATE INDEX payouts_status_idx ON payouts (status);

-- Append-only merchant ledger, in asset base units. Balance = SUM(amount).
CREATE TABLE ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  merchant_id  UUID NOT NULL REFERENCES merchants(id),
  asset        TEXT NOT NULL,
  amount       NUMERIC(78, 0) NOT NULL,   -- signed
  type         TEXT NOT NULL,             -- payment | fee | payout | payout_reversal | adjustment
  invoice_id   UUID REFERENCES invoices(id),
  payout_id    UUID REFERENCES payouts(id),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_type_chk CHECK (type IN ('payment','fee','payout','payout_reversal','adjustment'))
);
CREATE INDEX ledger_merchant_asset_idx ON ledger_entries (merchant_id, asset);
CREATE INDEX ledger_invoice_idx ON ledger_entries (invoice_id);
