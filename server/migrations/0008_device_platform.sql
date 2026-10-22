-- The plugin reports its form factor and OS so the administration page can show
-- phones, tablets, and desktops differently. Existing rows stay NULL, which the
-- page renders as a generic device instead of guessing.
ALTER TABLE devices ADD COLUMN client_platform TEXT;
