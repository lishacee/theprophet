-- Prophet 101 — D1 (SQLite) schema. Mirrors the 9 Google Sheets 1:1.
-- All columns TEXT: the Sheets backend was stringly-typed and the code Number()s
-- everything on read, so we keep that contract to avoid subtle coercion diffs.
-- Natural primary keys replace Sheets' rowIndex (data layer updates by PK, not row).

CREATE TABLE IF NOT EXISTS Users (
  username  TEXT PRIMARY KEY,
  userLower TEXT UNIQUE,
  passHash  TEXT, salt TEXT, nickname TEXT,
  token     TEXT, tokenExp TEXT, createdAt TEXT
);
CREATE INDEX IF NOT EXISTS ix_users_token ON Users(token);

CREATE TABLE IF NOT EXISTS Pools (
  poolId TEXT PRIMARY KEY,
  name TEXT, tournamentIds TEXT, dateFrom TEXT, dateTo TEXT, status TEXT,
  bookmaker TEXT, pointsPerMatch TEXT, startMultiplier TEXT, noshowPenalty TEXT,
  requirePassword TEXT, joinPassword TEXT, extraMarkets TEXT
);
CREATE INDEX IF NOT EXISTS ix_pools_status ON Pools(status);

CREATE TABLE IF NOT EXISTS CustomMarkets (
  poolId TEXT, fixtureId TEXT, cid TEXT,
  name TEXT, outcomesJson TEXT, result TEXT, settledAt TEXT, createdAt TEXT, locked TEXT,
  srcPool TEXT, srcCid TEXT,               -- provenance: kèo này clone từ (srcPool, srcCid); rỗng = tạo tay
  PRIMARY KEY (poolId, fixtureId, cid)
);
CREATE INDEX IF NOT EXISTS ix_cm_fixture ON CustomMarkets(fixtureId);

CREATE TABLE IF NOT EXISTS Memberships (
  poolId TEXT, user TEXT,
  joinAt TEXT, startingPoints TEXT, currentPoints TEXT, pinnedBadges TEXT, blocked TEXT,
  PRIMARY KEY (poolId, user)
);

CREATE TABLE IF NOT EXISTS Matches (
  poolId TEXT, fixtureId TEXT,
  tournamentId TEXT, team1 TEXT, team2 TEXT, kickoff TEXT, statusId TEXT,
  ouLine TEXT, ouMarketId TEXT, included TEXT, settled TEXT, penaltyApplied TEXT,
  lastFetchAt TEXT, score TEXT, ahMarketId TEXT,
  PRIMARY KEY (poolId, fixtureId)
);
CREATE INDEX IF NOT EXISTS ix_matches_kick ON Matches(kickoff);

CREATE TABLE IF NOT EXISTS Odds (
  bookmaker TEXT, fixtureId TEXT,
  oddsJson TEXT, updatedAt TEXT, prevOddsJson TEXT, lastFetchAt TEXT,
  PRIMARY KEY (bookmaker, fixtureId)
);

CREATE TABLE IF NOT EXISTS Bets (
  betId TEXT PRIMARY KEY,
  poolId TEXT, user TEXT, fixtureId TEXT, marketType TEXT, marketId TEXT,
  outcomeId TEXT, stake TEXT, lockedOdds TEXT, placedAt TEXT, result TEXT, payout TEXT, settledAt TEXT
);
CREATE INDEX IF NOT EXISTS ix_bets_pool ON Bets(poolId);
CREATE INDEX IF NOT EXISTS ix_bets_pool_user ON Bets(poolId, user);

CREATE TABLE IF NOT EXISTS Exemptions (
  poolId TEXT, user TEXT, fixtureId TEXT,
  PRIMARY KEY (poolId, user, fixtureId)
);

-- Hall of fame: one row per ended season. standings = JSON [{nickname,points},...] highest-first.
CREATE TABLE IF NOT EXISTS Seasons (
  poolId TEXT, name TEXT, endedAt TEXT, standings TEXT
);
CREATE INDEX IF NOT EXISTS ix_seasons_pool ON Seasons(poolId);

-- Reused for BOTH cached_() values AND script-properties (ADMINS override, resetAt_<pool>, catalog cache).
CREATE TABLE IF NOT EXISTS Cache (
  key TEXT PRIMARY KEY,
  value TEXT, updatedAt TEXT
);
