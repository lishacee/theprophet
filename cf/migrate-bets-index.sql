-- Perf: composite index for per-fixture bet lookups (settle/refund/manual-settle).
-- Target queries (admin.js settleBets_/refundBets, settle.js after scoping):
--   SELECT * FROM Bets WHERE poolId=? AND fixtureId=? [AND marketType=?]
-- poolId leftmost (always equality-bound, high selectivity), then fixtureId.
-- Run once:  wrangler d1 execute prophet --remote --file=cf/migrate-bets-index.sql
CREATE INDEX IF NOT EXISTS ix_bets_pool_fixture ON Bets(poolId, fixtureId);
PRAGMA optimize;
