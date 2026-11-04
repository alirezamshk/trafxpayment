-- Platform-wide switch per currency (admin -> currency settings). Disabled currencies are not
-- offered for new invoices; open invoices and deposits on them are still watched and settled.
ALTER TABLE asset_settings ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT false;
