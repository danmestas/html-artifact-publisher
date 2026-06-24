-- D1 migration 0001: pages table
-- Stores metadata for encrypted HTML artifact pages.
-- Actual ciphertext lives in R2 at pages/<id>.html.enc

CREATE TABLE IF NOT EXISTS pages (
  -- Nanoid-style 21-char random ID, also used as R2 key suffix
  id                TEXT PRIMARY KEY NOT NULL,

  -- Optional human-readable slug (unique, nullable)
  slug              TEXT UNIQUE,

  -- Display title (plaintext, provided by uploader)
  title             TEXT NOT NULL DEFAULT '',

  -- Source identifier supplied by the uploader (e.g. agent name, file path)
  source_name       TEXT NOT NULL DEFAULT '',

  -- SHA-256 hex of the encrypted payload bytes (integrity check)
  sha256            TEXT NOT NULL,

  -- IV used for AES-GCM, base64url-encoded (stored for reference; decryption key stays in fragment)
  iv                TEXT NOT NULL,

  -- Byte length of the stored encrypted blob
  blob_size         INTEGER NOT NULL DEFAULT 0,

  -- Unix timestamp (seconds) when this page should be deleted; NULL = no expiry
  expires_at        INTEGER,

  -- Unix timestamp (seconds) of creation
  created_at        INTEGER NOT NULL,

  -- SHA-256 hex of the one-time delete token issued at upload time
  delete_token_hash TEXT NOT NULL
);

-- Fast expiry-based cleanup scan
CREATE INDEX IF NOT EXISTS idx_pages_expires_at ON pages (expires_at)
  WHERE expires_at IS NOT NULL;

-- Fast slug lookup
CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages (slug)
  WHERE slug IS NOT NULL;

-- Listing (newest first)
CREATE INDEX IF NOT EXISTS idx_pages_created_at ON pages (created_at DESC);
