CREATE TABLE vault (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    id TEXT NOT NULL,
    cursor BIGINT NOT NULL DEFAULT 0 CHECK(cursor >= 0)
);
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    path_key TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK(revision > 0),
    hash TEXT NOT NULL,
    size BIGINT NOT NULL CHECK(size >= 0),
    deleted BOOLEAN NOT NULL
);
CREATE UNIQUE INDEX files_active_paths ON files(path_key) WHERE NOT deleted;
CREATE TABLE changes (
    revision BIGINT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id),
    record JSONB NOT NULL
);
CREATE INDEX changes_file_id ON changes(file_id,revision);
CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result JSONB NOT NULL
);
