-- Currencies each merchant may accept. NULL = every currency enabled on the platform.
ALTER TABLE merchants ADD COLUMN allowed_assets TEXT[];
