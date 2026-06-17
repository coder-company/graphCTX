-- M3: first-class fact observation time.
--
-- `t_created` says when graphCTX created the row and `t_recorded` says when it
-- persisted the row. Temporal graph provenance also needs the source-world time
-- when the fact was observed. Existing rows predate this distinction, so backfill
-- observation time from `t_recorded`.
ALTER TABLE facts ADD COLUMN t_observed TEXT;
UPDATE facts SET t_observed = t_recorded WHERE t_observed IS NULL;
CREATE INDEX idx_facts_observed ON facts(scope_user_id, t_observed);
