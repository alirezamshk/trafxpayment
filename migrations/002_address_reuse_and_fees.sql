-- Deposit addresses become reusable: a permanent address per merchant customer, or a per-merchant
-- pool whose addresses return after a cool-down. Funds accumulate and are swept above a threshold.
CREATE TABLE deposit_addresses (
  id                  BIGSERIAL PRIMARY KEY,
  family              TEXT NOT NULL,          -- evm | tron (EVM chains share addresses)
  derivation_index    BIGINT NOT NULL,
  address             TEXT NOT NULL,
  merchant_id         UUID NOT NULL REFERENCES merchants(id),
  customer_id         TEXT,                   -- NULL = pool address
  current_invoice_id  UUID REFERENCES invoices(id),
  last_invoice_id     UUID REFERENCES invoices(id),
  released_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family, derivation_index)
);
CREATE UNIQUE INDEX deposit_addresses_address_uq ON deposit_addresses (family, lower(address));
CREATE UNIQUE INDEX deposit_addresses_customer_uq ON deposit_addresses (merchant_id, family, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX deposit_addresses_pool_idx ON deposit_addresses (merchant_id, family, released_at)
  WHERE customer_id IS NULL AND current_invoice_id IS NULL;

ALTER TABLE invoices ADD COLUMN customer_id TEXT;
ALTER TABLE invoices ADD COLUMN deposit_address_id BIGINT REFERENCES deposit_addresses(id);
DROP INDEX IF EXISTS invoices_chain_address_uq;
CREATE INDEX invoices_chain_address_idx ON invoices (chain, lower(address)) WHERE memo IS NULL;

-- Existing invoices each had their own address: register them as pool addresses.
INSERT INTO deposit_addresses (family, derivation_index, address, merchant_id, current_invoice_id, last_invoice_id, released_at)
SELECT CASE WHEN i.chain = 'tron' THEN 'tron' ELSE 'evm' END, i.derivation_index, i.address, i.merchant_id,
       CASE WHEN i.status IN ('pending', 'confirming', 'partially_paid') AND i.expires_at > now() THEN i.id END,
       i.id,
       CASE WHEN i.status IN ('pending', 'confirming', 'partially_paid') AND i.expires_at > now() THEN NULL
            ELSE COALESCE(i.paid_at, i.expires_at) END
FROM invoices i
WHERE i.derivation_index IS NOT NULL AND i.memo IS NULL;

UPDATE invoices i SET deposit_address_id = d.id
FROM deposit_addresses d
WHERE i.derivation_index IS NOT NULL AND i.memo IS NULL
  AND d.derivation_index = i.derivation_index
  AND d.family = CASE WHEN i.chain = 'tron' THEN 'tron' ELSE 'evm' END;

-- Per-asset operator settings (editable in the admin panel). Amounts in base units.
CREATE TABLE asset_settings (
  asset            TEXT PRIMARY KEY,
  sweep_threshold  NUMERIC(78, 0) NOT NULL DEFAULT 0,
  payout_fee       NUMERIC(78, 0) NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Network fee charged to the merchant per payout.
ALTER TABLE payouts ADD COLUMN fee NUMERIC(78, 0) NOT NULL DEFAULT 0;
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_type_chk;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_type_chk
  CHECK (type IN ('payment', 'fee', 'payout', 'payout_fee', 'payout_reversal', 'adjustment'));
