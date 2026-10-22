CREATE TABLE auth_settings (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    challenge_key TEXT NOT NULL
);
CREATE TABLE auth_owner (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    generation BIGINT NOT NULL DEFAULT 1
);
CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES auth_owner(id),
    csrf_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    last_seen BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE auth_challenges (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('setup','reset')),
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    generation BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    delivered BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
CREATE TABLE auth_limits (
    key TEXT PRIMARY KEY,
    starts_at BIGINT NOT NULL,
    count INTEGER NOT NULL
);
