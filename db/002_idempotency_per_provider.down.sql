-- =============================================================================
-- 002_idempotency_per_provider.down.sql — restaura a unicidade GLOBAL da Idempotency-Key.
-- Só é possível se nenhuma chave tiver sido usada por mais de um provedor. Essas linhas são fatos financeiros (não se apagam nem se
-- reescrevem), então, havendo repetição, a reversão FALHA explicitamente e nada muda (a migration roda em transação).
-- =============================================================================
LOCK TABLE wager_transactions IN ACCESS EXCLUSIVE MODE;  -- nenhuma repetição nova entre a conferência e a constraint

DO $$
DECLARE repeated bigint;
BEGIN
  SELECT count(*) INTO repeated
    FROM (SELECT idempotency_key FROM wager_transactions GROUP BY idempotency_key HAVING count(*) > 1) AS shared;
  IF repeated > 0 THEN
    RAISE EXCEPTION '002 down: % idempotency_key(s) usada(s) por mais de um provedor; a unicidade global não pode ser restaurada', repeated
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;

ALTER TABLE wager_transactions DROP CONSTRAINT wt_provider_idempotency_key_uq;
ALTER TABLE wager_transactions ADD CONSTRAINT wt_idempotency_key_uq UNIQUE (idempotency_key);
