-- =============================================================================
-- 20260910_0024_skr_stake_snapshots.sql   (WO-1674 / HEART-001)
-- -----------------------------------------------------------------------------
-- ONE new table, no existing data touched. The backend gains the place where a
-- wallet's VERIFIED native SKR stake lives, so that nothing of value ever again
-- reads an amount the Unity client computed.
--
-- ⛔ WHY A TABLE AND NOT A SAVE FIELD. api/game/save.js:70-72 says the save blob
--    is client-owned with anti-grief ceilings, "NOT a server-authoritative
--    economy", and :410-421 says the client simulates and the server keeps "a
--    RECORD, NOT A CONTROL". A stake the client could write is exactly the thing
--    product rule 7 forbids. So Heartbound state is a Neon table and
--    SaveSchema.CurrentVersion DOES NOT BUMP — that is the correct answer, not a
--    shortcut (WO-1675 §0b).
--
-- ⛔ WHY TWO TIMESTAMPS, AND THIS IS THE LOAD-BEARING PART OF THE WHOLE TABLE.
--
--    verified_at  = when the CHAIN was last read SUCCESSFULLY. The amounts in
--                   this row belong to THIS instant and to no other.
--    last_attempt_at = when we last TRIED, successfully or not.
--
--    A single timestamp stamped on every attempt would destroy the only thing
--    this table exists to provide: the owner's 2026-09-10 13:10 ruling is that
--    an RPC outage serves "last-known verified state with a bounded grace
--    window", and the window is measured from the last SUCCESS. Overwrite
--    verified_at on a failure and every outage silently renews its own grace
--    forever — an outage lasting a month would still read as "verified a moment
--    ago". The two columns are what make "how stale is this, really" answerable.
--
-- ⛔ NULLABLE AMOUNTS, NO DEFAULTS, AND NEVER A DEFAULT OF 0.
--    NULL means THIS ROW HAS NO VERIFIED AMOUNT — we have never successfully
--    read this wallet. A DEFAULT 0 would make every such row claim a real,
--    server-observed stake of zero, which is a claim we have no evidence for and
--    which is indistinguishable from a player who genuinely unstaked.
--
--    This is EXACTLY the mistake migration 0022 had to undo: schema_version was
--    `INTEGER NOT NULL DEFAULT 10`, so a version-less client landed on a
--    fabricated 10 and drove a whole migration chain over state that had never
--    been v10 (the WO-1457 corruption). Migration 0023 then repeated the lesson
--    in its own words for reset_epoch: "column_default MUST be NULL... NULL is
--    'unknown', and the handler is written to that meaning." Same rule here, and
--    api/_lib/skr-staking.js's verifyStake() returns nulls rather than zeros on
--    every failure path for the same reason.
--
-- ⛔ NUMERIC(39,0), NOT BIGINT. shares and share_price are u128 on chain (the
--    program's Anchor IDL, read on chain 2026-09-10 at
--    4aAEUKCcju9iAEAgdeaNz4RC7sCPv63q5g714nw4QY68). A u128 does not fit in a
--    BIGINT and would overflow on insert — a live account already carries a
--    share price of 1136636001 and total_shares of 4368092298928615, and the
--    latter grows. 39 digits holds the full u128 range (2^128-1 is 39 digits).
--    Stored as an EXACT integer type, never a float: this row is read back to
--    decide a reward, and a double loses integer precision past 2^53.
--
-- ⛔ RAW BASE UNITS, NOT WHOLE SKR. SKR is 6 decimals; the conversion happens at
--    the display edge only (spec :178, acceptance criterion 7). The Unity client
--    divided to whole SKR before use (NativeSkrStakeQuery.cs:76) and that
--    precision loss is one of the three defects WO-1674 §0 names.
--
-- KEYED BY player_id, WHICH IS THE WALLET. api/schema.sql:60 —
--    "player_id TEXT PRIMARY KEY, -- BoundWallet address" — and
--    api/_lib/wallet-auth.js:129 routes a base58 id straight to ed25519
--    verification. There is no linkage table to build and none is built here.
--    The PRIMARY KEY is what satisfies acceptance criterion 6: reconnecting the
--    same authenticated wallet UPSERTS this row and cannot create a second
--    Heartbound account, structurally, the same way achievement_grants'
--    composite PK "STRUCTURALLY prevents a double-grant" (api/schema.sql:965-984).
--
-- ⚠ wallet_address IS STORED ALONGSIDE THE KEY ON PURPOSE. It is the same value
--    as player_id on the wallet rail today, and writing it down means a future
--    rail change is a visible data difference rather than a silent reinterpretation
--    of what the key meant.
--
-- ADDITIVE. Zero DROP / DELETE / TRUNCATE / rename, no back-fill, NOT ONE
-- EXISTING ROW READ OR WRITTEN.
--
-- RE-RUNNABLE. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table.
-- ⚠ AND THAT IS ALSO ITS LIMIT (memory: idempotent-ddl-hides-a-stale-table): if a
--    table of this name already existed with DIFFERENT columns, this file would
--    report success and change nothing. The verify below is a SHAPE QUERY for
--    exactly that reason — a repair is judged by the shape it leaves behind,
--    never by a statement returning.
--
-- ⛔ DO NOT "APPLY" THIS BY RE-RUNNING api/schema.sql. Only files under
--    api/migrations/ are ever applied; schema.sql is a DESCRIPTION of the schema
--    (api/schema.sql:105-107). The matching description block was added there in
--    the same commit, which is a description, not an apply.
--
-- Apply (owner, DATABASE_URL in env):
--     node tools/run-migrations.mjs
-- Judge by the MARKER on a fresh log — `MIGRATIONS_OK applied=N skipped=M`
-- (tools/run-migrations.mjs:37) — never by the exit code.
-- =============================================================================

CREATE TABLE IF NOT EXISTS skr_stake_snapshots (
    player_id            TEXT        PRIMARY KEY,
    wallet_address       TEXT        NOT NULL,
    guardian_pool        TEXT        NOT NULL,
    user_stake_address   TEXT,

    -- Raw chain values. NULL = never successfully verified. See the header.
    shares_raw           NUMERIC(39,0),
    share_price_raw      NUMERIC(39,0),
    active_staked_raw    NUMERIC(39,0),
    unstaking_raw        NUMERIC(39,0),
    unstake_timestamp    BIGINT,
    cooldown_seconds     BIGINT,
    unstaking_ready      BOOLEAN     NOT NULL DEFAULT FALSE,
    source_slot          BIGINT,

    -- The seven states of api/_lib/skr-staking.js's VerificationStatus, and the
    -- CHECK is the only copy of that list outside the JS. Following the
    -- rail/network CHECK precedent at api/schema.sql:1138,1146-1149.
    -- StakingComplianceRegression asserts the two lists still agree.
    verification_status  TEXT        NOT NULL
        CHECK (verification_status IN (
            'VERIFIED', 'NO_STAKE', 'RPC_UNAVAILABLE', 'ACCOUNT_NOT_FOUND',
            'WALLET_NOT_LINKED', 'INVALID_RESPONSE', 'STALE')),
    error_code           TEXT,

    -- ⛔ THE TWO CLOCKS. verified_at is the last SUCCESS and is what the grace
    --    window is measured from; last_attempt_at moves on every try. Never
    --    collapse them — see the header.
    verified_at          TIMESTAMPTZ,
    last_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Operational read: "who is currently verified, and how fresh are they" — the
-- query HEART-004's pulse processing and HEART-011's analytics both want, and
-- the one a full scan would make expensive once the table is large.
CREATE INDEX IF NOT EXISTS idx_skr_stake_snapshots_status_verified
    ON skr_stake_snapshots (verification_status, verified_at DESC);

-- =============================================================================
-- Verify by SHAPE, never by exit code (memory: idempotent-ddl-hides-a-stale-table).
--
-- Expect 17 rows; the four amount columns numeric/YES/NULL default, both
-- timestamps present, verified_at NULLABLE and last_attempt_at NOT NULL:
--
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'skr_stake_snapshots'
--    ORDER BY ordinal_position;
--
-- ⛔ active_staked_raw MUST read is_nullable 'YES' and column_default NULL. A
--    NOT NULL DEFAULT 0 here is the WO-1457 mistake wearing a different column
--    name: it turns "we have never read this wallet" into "this wallet has no
--    stake", which is the one confusion this entire work order exists to end.
--
-- And that the CHECK really constrains (expect the seven states):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'skr_stake_snapshots'::regclass AND contype = 'c';
-- =============================================================================
