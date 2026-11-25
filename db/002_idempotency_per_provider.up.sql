-- =============================================================================
-- 002_idempotency_per_provider.up.sql
-- A Idempotency-Key passa a ser única DENTRO de um provedor. Com unicidade global, um provedor que usasse a chave de outro deixava o
-- dono legítimo com conflito permanente. A unicidade de (provider_id, external_transaction_id) não muda.
-- ADD CONSTRAINT constrói o índice com a tabela bloqueada (ver docs/ARCHITECTURE.md, "Limitações conhecidas").
-- =============================================================================
ALTER TABLE wager_transactions DROP CONSTRAINT wt_idempotency_key_uq;
ALTER TABLE wager_transactions ADD CONSTRAINT wt_provider_idempotency_key_uq UNIQUE (provider_id, idempotency_key);
