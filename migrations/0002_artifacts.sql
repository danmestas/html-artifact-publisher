-- D1 migration 0002: artifacts as encrypted Fossil repositories.
-- Replaces 0001's pages table (and the R2 bucket): the bytes now live here,
-- split into chunks rows. See src/index.ts, "Store: artifacts in D1".

DROP TABLE IF EXISTS pages;

CREATE TABLE IF NOT EXISTS artifacts (
  -- Nanoid-style 21-char random ID
  id           TEXT PRIMARY KEY NOT NULL,
  -- Optional human-readable slug (unique, nullable)
  slug         TEXT UNIQUE,
  -- Plaintext metadata supplied by the publisher, for listing
  title        TEXT NOT NULL DEFAULT '',
  source_name  TEXT NOT NULL DEFAULT '',
  -- Random token replaced on every write; If-Match compares against it
  etag         TEXT NOT NULL,
  -- Byte length of iv || ciphertext
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  -- Unix seconds; NULL = never. Expired rows read as absent.
  expires_at   INTEGER,
  -- SHA-256 hex of the write token in the edit link
  write_hash   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_updated_at ON artifacts (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_expires_at ON artifacts (expires_at)
  WHERE expires_at IS NOT NULL;

-- iv[12] || AES-256-GCM(gzip(.fossil)), in order of n, each at most 1 MiB
CREATE TABLE IF NOT EXISTS chunks (
  id    TEXT NOT NULL,
  n     INTEGER NOT NULL,
  data  BLOB NOT NULL,
  PRIMARY KEY (id, n)
);
