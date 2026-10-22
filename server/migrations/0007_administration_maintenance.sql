-- Device lifecycle details for the administration page. Existing rows keep NULL
-- values, which the page reports as unknown instead of inventing activity.
ALTER TABLE devices ADD COLUMN created_at BIGINT;
ALTER TABLE devices ADD COLUMN last_seen_at BIGINT;
ALTER TABLE devices ADD COLUMN client_version TEXT;
-- The last applied collection, shared by the web page and scripts/gc.mjs.
CREATE TABLE maintenance (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    collected_at BIGINT NOT NULL,
    objects BIGINT NOT NULL CHECK(objects >= 0),
    bytes BIGINT NOT NULL CHECK(bytes >= 0)
);
