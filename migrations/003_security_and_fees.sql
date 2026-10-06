-- Phase 1: network-fee payer, minimum amounts, cold wallet limits, 2FA, IP allowlists,
-- payout-address hold and an audit log.

-- Who pays the deposit network fee: 'merchant' (deducted from the credit) or 'customer' (added to the amount due).
ALTER TABLE merchants ADD COLUMN fee_payer TEXT NOT NULL DEFAULT 'merchant';
ALTER TABLE merchants ADD CONSTRAINT merchants_fee_payer_chk CHECK (fee_payer IN ('merchant', 'customer'));

ALTER TABLE invoices ADD COLUMN network_fee NUMERIC(78, 0) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN fee_paid_by TEXT;

-- NULL = use the built-in default for that asset.
ALTER TABLE asset_settings ADD COLUMN min_amount NUMERIC(78, 0);
ALTER TABLE asset_settings ADD COLUMN deposit_fee NUMERIC(78, 0);
ALTER TABLE asset_settings ADD COLUMN hot_max NUMERIC(78, 0);

ALTER TABLE ledger_entries DROP CONSTRAINT ledger_type_chk;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_type_chk
  CHECK (type IN ('payment', 'fee', 'network_fee', 'payout', 'payout_fee', 'payout_reversal', 'adjustment'));

-- TOTP two-factor authentication.
ALTER TABLE merchants ADD COLUMN totp_secret TEXT;
ALTER TABLE merchants ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE merchants ADD COLUMN totp_last_step BIGINT;
ALTER TABLE admins ADD COLUMN totp_secret TEXT;
ALTER TABLE admins ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admins ADD COLUMN totp_last_step BIGINT;

-- API keys may be restricted to the merchant's server IPs.
ALTER TABLE api_keys ADD COLUMN allowed_ips TEXT[];

-- A changed payout address is not paid to until this time.
ALTER TABLE payout_addresses ADD COLUMN locked_until TIMESTAMPTZ;

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_type  TEXT NOT NULL,          -- admin | merchant | api | system
  actor_id    TEXT,
  merchant_id UUID,
  action      TEXT NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_merchant_idx ON audit_log (merchant_id, created_at DESC);
