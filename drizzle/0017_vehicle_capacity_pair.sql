-- NULL must not let a half-recorded capacity pass a SQL CHECK.
-- Historical vehicles with neither value nor unit remain valid.
ALTER TABLE vehicles DROP CONSTRAINT vehicles_capacity_valid;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_capacity_valid CHECK (
  (capacity_value IS NULL AND capacity_unit IS NULL)
  OR (capacity_value IS NOT NULL AND capacity_unit IS NOT NULL
      AND capacity_value > 0 AND length(trim(capacity_unit)) > 0)
);
