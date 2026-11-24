-- 001_init.down.sql — reverte 001_init.up.sql (ordem inversa de dependência)
DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;

DROP TRIGGER IF EXISTS ledger_match_wallet_trg ON wallet_ledger_entries;
DROP TRIGGER IF EXISTS wallets_match_ledger_trg ON wallets;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP FUNCTION IF EXISTS assert_wallet_matches_ledger();
DROP FUNCTION IF EXISTS ledger_chain_check();
DROP FUNCTION IF EXISTS ledger_immutable();
DROP SEQUENCE IF EXISTS wallet_ledger_seq;

DROP TABLE IF EXISTS wager_transactions;
DROP FUNCTION IF EXISTS wager_transactions_guard();

DROP TABLE IF EXISTS wallets;
DROP FUNCTION IF EXISTS wallets_guard();
