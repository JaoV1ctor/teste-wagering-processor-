-- =============================================================================
-- 001_init.up.sql — Distributed Wagering Processor
-- Princípio: o BANCO é a última linha de defesa das invariantes (unicidade, imutabilidade e não-negatividade no schema).
-- A aplicação também valida, mas nada aqui depende de a aplicação estar certa.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- WALLETS
-- -----------------------------------------------------------------------------
CREATE TABLE wallets (
  id          uuid          PRIMARY KEY,
  player_id   uuid          NOT NULL,
  currency    char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance     numeric(19,2) NOT NULL CHECK (balance >= 0),          -- saldo nunca negativo
  version     integer       NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency), -- 1 wallet por player+moeda
  CONSTRAINT wallets_id_currency_uq     UNIQUE (id, currency)         -- alvo da FK composta do ledger
);

-- version só muda quando o saldo muda; id/player/moeda são imutáveis; sem DELETE.
CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallets: DELETE proibido' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'wallets: id, player_id e currency são imutáveis' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.balance IS DISTINCT FROM OLD.balance THEN
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'wallets: saldo mudou, version deve ir de % para %', OLD.version, OLD.version + 1
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'wallets: version só pode mudar quando o saldo muda' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER wallets_guard_trg BEFORE UPDATE OR DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION wallets_guard();

-- -----------------------------------------------------------------------------
-- WAGER_TRANSACTIONS
-- -----------------------------------------------------------------------------
CREATE TABLE wager_transactions (
  id                                uuid          PRIMARY KEY,
  provider_id                       text          NOT NULL,
  external_transaction_id           text          NOT NULL,
  idempotency_key                   text          NOT NULL,
  payload_hash                      char(64)      NOT NULL,           -- sha256 hex do JSON canônico
  wallet_id                         uuid          NOT NULL REFERENCES wallets(id),
  player_id                         uuid          NOT NULL,
  round_id                          text          NOT NULL,
  game_id                           text          NOT NULL,
  kind                              text          NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                            numeric(19,2) NOT NULL CHECK (amount > 0),
  currency                          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference_external_transaction_id text,
  reference_transaction_id          uuid          REFERENCES wager_transactions(id),
  status                            text          NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                      text,
  observed_balance                  numeric(19,2) CHECK (observed_balance >= 0), -- saldo visto ao decidir; usado no replay
  attempts                          integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at                   timestamptz,
  created_at                        timestamptz   NOT NULL DEFAULT now(),
  updated_at                        timestamptz   NOT NULL DEFAULT now(),
  processed_at                      timestamptz,

  -- Idempotência persistente: duas chaves de unicidade
  CONSTRAINT wt_idempotency_key_uq UNIQUE (idempotency_key),
  CONSTRAINT wt_external_id_uq     UNIQUE (provider_id, external_transaction_id),

  -- REFUND/ROLLBACK exigem referência; BET/OPENING não têm; WIN/LOSS podem ter (ver docs/ARCHITECTURE.md, "Interpretações do enunciado")
  CONSTRAINT wt_reference_by_kind CHECK (
       (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
    OR (kind IN ('WIN','LOSS'))
    OR (kind IN ('BET','OPENING')     AND reference_external_transaction_id IS NULL)
  ),
  CONSTRAINT wt_not_self_reference CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id),
  -- failureCode estável: obrigatório em REJECTED/FAILED e proibido nos demais
  CONSTRAINT wt_failure_code_iff_failed CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  -- PROCESSED sempre carrega processed_at e o saldo observado
  CONSTRAINT wt_processed_fields CHECK (status <> 'PROCESSED' OR (processed_at IS NOT NULL AND observed_balance IS NOT NULL)),
  CONSTRAINT wt_processed_at_only_processed CHECK (processed_at IS NULL OR status = 'PROCESSED'),
  -- uma reversão processada sempre aponta a transação revertida
  CONSTRAINT wt_reversal_has_reference CHECK (
    NOT (status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')) OR reference_transaction_id IS NOT NULL
  )
);

-- Reversão única: no máximo UMA reversão efetiva por transação referenciada (ver docs/ARCHITECTURE.md, "Interpretações do enunciado").
-- Mesmo que a aplicação falhe, o banco impede crédito duplicado por REFUND+ROLLBACK da mesma BET.
CREATE UNIQUE INDEX wt_one_effective_reversal_uq
  ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';

-- Worker de PENDING_REFERENCE: varre só as pendentes e vencidas.
CREATE INDEX wt_pending_reference_due_idx
  ON wager_transactions (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';

CREATE INDEX wt_wallet_created_idx ON wager_transactions (wallet_id, created_at);

-- Estados terminais não mudam; colunas de identidade são imutáveis; sem DELETE;
-- PENDING_REFERENCE nunca volta a PENDING.
CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager_transactions: DELETE proibido' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'wager_transactions: % está em estado terminal (%) e não pode mudar', OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
    RAISE EXCEPTION 'wager_transactions: transição PENDING_REFERENCE -> PENDING é inválida'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.provider_id <> OLD.provider_id
     OR NEW.external_transaction_id <> OLD.external_transaction_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.wallet_id <> OLD.wallet_id
     OR NEW.player_id <> OLD.player_id
     OR NEW.round_id <> OLD.round_id
     OR NEW.game_id <> OLD.game_id
     OR NEW.kind <> OLD.kind
     OR NEW.amount <> OLD.amount
     OR NEW.currency <> OLD.currency
     OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'wager_transactions: colunas de identidade são imutáveis' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER wager_transactions_guard_trg BEFORE UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard();

-- -----------------------------------------------------------------------------
-- WALLET_LEDGER_ENTRIES — somente inserção
-- -----------------------------------------------------------------------------
-- seq é atribuído por trigger DEPOIS de travar a wallet (ver ledger_chain_check), garantindo
-- que a ordem do seq == ordem de commit por wallet. Serve de cursor estável na paginação.
CREATE SEQUENCE wallet_ledger_seq;

CREATE TABLE wallet_ledger_entries (
  seq            bigint        NOT NULL UNIQUE,
  id             uuid          PRIMARY KEY,
  wallet_id      uuid          NOT NULL,
  transaction_id uuid          NOT NULL REFERENCES wager_transactions(id),
  direction      text          NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount         numeric(19,2) NOT NULL CHECK (amount > 0),
  currency       char(3)       NOT NULL,
  balance_before numeric(19,2) NOT NULL CHECK (balance_before >= 0),
  balance_after  numeric(19,2) NOT NULL CHECK (balance_after >= 0),
  created_at     timestamptz   NOT NULL DEFAULT now(),
  -- a moeda do lançamento tem de ser a da wallet
  CONSTRAINT le_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
  -- no máximo 1 lançamento por transação por wallet
  CONSTRAINT le_one_per_tx_wallet_uq UNIQUE (transaction_id, wallet_id),
  -- aritmética do lançamento (isBalanced no domínio, repetido no banco)
  CONSTRAINT le_balanced CHECK (
       (direction = 'CREDIT' AND balance_after = balance_before + amount)
    OR (direction = 'DEBIT'  AND balance_after = balance_before - amount)
  )
);

CREATE INDEX le_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq);

-- Imutabilidade: nenhum UPDATE, DELETE ou TRUNCATE.
CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries é imutável (% proibido)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER ledger_no_update_delete_trg BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER ledger_no_truncate_trg BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();

-- Cadeia do ledger: balance_before de uma entrada = balance_after da anterior (ou 0 na primeira).
-- O PRÓPRIO BANCO serializa os lançamentos por wallet: o trigger trava a linha da wallet antes de
-- conferir a cadeia. Se a aplicação esquecer o lock, o 2º lançamento espera o 1º commitar, enxerga
-- o saldo novo e FALHA por cadeia quebrada (before desatualizado) — em vez de gravar lost update.
-- FOR NO KEY UPDATE: mesmo nível que um UPDATE comum e não bloqueia checagens de FK de outras transações.
CREATE FUNCTION ledger_chain_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_after numeric(19,2);
BEGIN
  PERFORM 1 FROM wallets WHERE id = NEW.wallet_id FOR NO KEY UPDATE;
  NEW.seq := nextval('wallet_ledger_seq');
  SELECT balance_after INTO last_after
    FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN last_after := 0; END IF;
  IF NEW.balance_before <> last_after THEN
    RAISE EXCEPTION 'ledger: cadeia quebrada na wallet % (before=%, esperado=%)', NEW.wallet_id, NEW.balance_before, last_after
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ledger_chain_trg BEFORE INSERT ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_chain_check();

-- Saldo materializado == ledger. Verificado NO COMMIT (deferido), para permitir
-- gravar wallet e ledger em qualquer ordem dentro da mesma transação.
-- Com a cadeia acima, "último balance_after == saldo" implica soma(ledger) == saldo.
CREATE FUNCTION assert_wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  w_id uuid; w_balance numeric(19,2); last_after numeric(19,2);
BEGIN
  IF TG_TABLE_NAME = 'wallets' THEN w_id := NEW.id; ELSE w_id := NEW.wallet_id; END IF;
  SELECT balance INTO w_balance FROM wallets WHERE id = w_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT balance_after INTO last_after
    FROM wallet_ledger_entries WHERE wallet_id = w_id ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN last_after := 0; END IF;
  IF w_balance <> last_after THEN
    RAISE EXCEPTION 'wallet % divergente do ledger (saldo=%, ledger=%)', w_id, w_balance, last_after
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER wallets_match_ledger_trg
  AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();
CREATE CONSTRAINT TRIGGER ledger_match_wallet_trg
  AFTER INSERT ON wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();

-- -----------------------------------------------------------------------------
-- INBOX / OUTBOX
-- -----------------------------------------------------------------------------
CREATE TABLE inbox_messages (
  consumer_name text        NOT NULL,
  message_id    text        NOT NULL,
  payload_hash  char(64)    NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  PRIMARY KEY (consumer_name, message_id)                -- deduplicação persistente
);

CREATE TABLE outbox_messages (
  id              uuid        PRIMARY KEY,               -- = eventId (o consumidor deduplica por ele)
  aggregate_id    uuid        NOT NULL,
  event_type      text        NOT NULL,
  payload         jsonb       NOT NULL,                  -- envelope serializado (MoneyProps como string)
  occurred_at     timestamptz NOT NULL,
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);

-- Publishers varrem só o que está pendente e vencido (SELECT ... FOR UPDATE SKIP LOCKED).
CREATE INDEX outbox_due_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
