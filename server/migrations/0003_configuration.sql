ALTER TABLE files ADD COLUMN scope TEXT NOT NULL DEFAULT 'notes'
    CHECK (scope IN ('notes', 'configuration'));
DROP INDEX files_active_paths;
CREATE UNIQUE INDEX files_active_paths ON files(scope, path_key) WHERE NOT deleted;
