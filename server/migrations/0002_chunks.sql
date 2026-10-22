CREATE TABLE version_chunks (
    revision BIGINT NOT NULL REFERENCES changes(revision) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    chunk_hash TEXT NOT NULL,
    chunk_size BIGINT NOT NULL CHECK (chunk_size > 0),
    PRIMARY KEY (revision, ordinal)
);
CREATE INDEX version_chunks_hash ON version_chunks(chunk_hash);
ALTER TABLE files ADD COLUMN chunked BOOLEAN NOT NULL DEFAULT FALSE;
