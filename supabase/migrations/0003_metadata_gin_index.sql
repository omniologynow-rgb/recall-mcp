-- Add GIN index on memories.metadata for faster @> jsonb containment queries.
-- jsonb_path_ops is smaller and faster than default for path-based operators
-- like @>. See: https://www.postgresql.org/docs/15/datatype-json.html#INDEXES-JSONB
--
-- R7 production hardening — deferred from R6 to avoid scope creep in the
-- metadata-aware recall feature.

CREATE INDEX IF NOT EXISTS idx_memories_metadata_gin
    ON memories USING GIN (metadata jsonb_path_ops);
