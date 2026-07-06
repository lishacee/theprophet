-- Clone custom-market feature: provenance columns + fixture index.
-- Run once on the deployed DB:  wrangler d1 execute prophet --remote --file=cf/migrate-clone.sql
ALTER TABLE CustomMarkets ADD COLUMN srcPool TEXT DEFAULT '';
ALTER TABLE CustomMarkets ADD COLUMN srcCid TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS ix_cm_fixture ON CustomMarkets(fixtureId);
