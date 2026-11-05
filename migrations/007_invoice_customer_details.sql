-- Extra invoice details recorded by the merchant: a per-merchant sequential invoice number
-- and optional customer contact details (name, email, phone, account/username in the merchant's system).
ALTER TABLE merchants ADD COLUMN invoice_seq BIGINT NOT NULL DEFAULT 0;
ALTER TABLE invoices
  ADD COLUMN invoice_number   BIGINT,
  ADD COLUMN customer_name    TEXT,
  ADD COLUMN customer_email   TEXT,
  ADD COLUMN customer_phone   TEXT,
  ADD COLUMN customer_account TEXT;

-- Number existing invoices per merchant in creation order, then continue the counter from there.
UPDATE invoices i SET invoice_number = n.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY merchant_id ORDER BY created_at, id) AS rn FROM invoices) n
 WHERE n.id = i.id;
UPDATE merchants m SET invoice_seq = COALESCE((SELECT max(invoice_number) FROM invoices i WHERE i.merchant_id = m.id), 0);

ALTER TABLE invoices ALTER COLUMN invoice_number SET NOT NULL;
CREATE UNIQUE INDEX invoices_merchant_number_idx ON invoices (merchant_id, invoice_number);
