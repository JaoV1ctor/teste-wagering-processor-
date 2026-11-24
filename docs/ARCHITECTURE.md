# ARCHITECTURE — Distributed Wagering Processor

> Documento vivo: cada fase acrescenta sua seção (decisão, alternativas, trade-offs, limitações).
> Fontes da verdade: `docs/CHALLENGE_README.md` (enunciado) e `docs/SPEC.md` (decisões).

---

## Fase 0 — Base técnica e spike de compatibilidade

**Objetivo.** Provar que a base funciona antes de escrever regra de negócio: Bun + NestJS + MikroORM,
Postgres e emulador de SQS reais, migration reversível do schema validado e teste do schema contra Postgres real.
Nenhuma regra de negócio foi implementada.

### O que foi verificado (e como)


| Item                                                                                                              | Resultado                                                                                                       | Prova                                                              |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Versões instaladas (fixadas, sem `^`)                                                                             | Bun 1.4.4, NestJS 12.6.0, MikroORM 7.2.11, `@aws-sdk/client-sqs` 3.1176.0, `pg` 8.23.1, TypeScript 6.0.3        | `package.json`, `bun.lock`                                         |
| Nest sob Bun (DI por tipo com `emitDecoratorMetadata`, rota HTTP)                                                 | OK                                                                                                              | `test/integration/nest-di.test.ts`                                 |
| MikroORM 7 sob Bun (decorators legacy + `reflect-metadata`, descoberta de entidade)                               | OK                                                                                                              | `test/integration/persistence.test.ts`                               |
| Entidade de persistência + mapper + domínio com construtor privado e `rehydrate`                                  | OK: persiste, relê em um fork limpo, `balance` chega como `string`                                              | `test/unit/mappers.test.ts`, `persistence.test.ts`                               |
| Migration reversível que executa `db/001_init.up.sql` / `.down.sql` sem alterá-los                                | up → down → up OK; o `down` remove tabelas **e** funções                                                        | `test/integration/migration.test.ts` e `bun run migration:up/down` |
| Schema testado em `test/integration/schema.test.ts`                                                               | 33 casos verdes (constraints, ledger, idempotência, corridas, controle negativo), 3 execuções seguidas estáveis | `test/integration/schema.test.ts`                                  |
| MiniStack: FIFO, `MessageGroupId`, deduplicação, `ChangeMessageVisibility`, DLQ com redrive (`maxReceiveCount=5`) | OK                                                                                                              | `test/integration/sqs.test.ts`                                     |
| Filas por script idempotente                                                                                      | OK (rodado duas vezes seguidas, mesmas URLs)                                                                    | `bun run infra:queues`                                             |
| `bun run check` (tsc strict + eslint + unit)                                                                      | verde. na Fase 0 ainda sem testes unitários; o flag `--pass-with-no-tests` foi removido na Fase 1                   | `bun run check`                                                    |
| Suíte de integração completa                                                                                      | 48 testes, 0 falhas                                                                                             | `bun run test:integration`                                         |


### Decisões e desvios

**1. Imagem do emulador de AWS.** A imagem do compose original (`nahuelnucera/ministack`) **não existe** no Docker Hub
(`pull access denied`). Trocada por `ministackorg/ministack:1.5.44`: licença MIT (label OCI da imagem), sem conta nem token,
tag fixa. O repositório declarado pela imagem é `github.com/ministackorg/ministack`.
Alternativa descartada: LocalStack (exige conta e token desde 23/03/2026, SPEC D9).

**2. TypeScript 6.0.3, não 7.0.2.** O npm oferece TypeScript 7.0.2, mas `typescript-eslint` 8.74.0 declara
`typescript >=4.8.4 <6.1.0`. Para manter lint e tsc na mesma versão, ficamos no 6.0.3. Reavaliar quando o `typescript-eslint` suportar o 7.

**3. Migration por `migrationsList`, não por glob.** O Migrator recebe a classe `InitMigration` explicitamente
(`orm.config.ts`). Sem descoberta de arquivos: funciona igual em Bun/TS sem build. `snapshot: false`, porque o schema vem
de `db/*.sql` (fonte única) e não de diff de entidades.
A migration lê os `.sql` e os envia **inteiros em uma única `addSql`**. Verificado no código do `MigrationRunner`: cada item vira
uma chamada `driver.execute`, sem partir por `;`. Isso importa porque as funções PL/pgSQL usam `

$$
...
$$

`.

**4. Migrator exige entidades.** `MikroORM.init` lança `No entities found` sem entidades; o script de migração e os testes
passam `discovery: { warnWhenNoEntities: false }`, porque migrar só executa SQL.

**5. Persistência separada do domínio (D4) confirmada viável.** `Wallet` (domínio) tem construtor privado e
`Wallet.rehydrate(state)`; `WalletEntity` (persistência) leva os decorators; `WalletMapper` converte.
`NUMERIC(19,2)` chega como `string` e o mapper converte para `bigint` em centavos (exige exatamente 2 casas, senão lança).
Testado com valor acima de `Number.MAX_SAFE_INTEGER` sem perda. `Money`, `debit` e `credit` entraram na Fase 1.

**6. Porte do teste de schema.** Expectativas, SQL e regex do original preservados. Mudanças de **forma**:
`test()` por caso; conexão via `DATABASE_URL`; schema aplicado por migration; protótipo de corrida com `bigint` em centavos no lugar de `Number`.
Duas diferenças de **comportamento do teste**, declaradas:
(a) o caso informativo "ordem de lock" ganhou asserções só para a **regra** (0 deadlocks, 30/30 processadas, ledger consistente);
(b) timeout de 120 s nesse caso, pois o `bun test` limita cada teste a 5 s e as rodadas do anti-padrão esperam `deadlock_timeout` (1 s) por deadlock.

### SQL gerado pelo `LockMode` do MikroORM 7.2.11 (PostgreSQL)

Capturado com `debug: ['query']` em `lock-mode.test.ts`:


| `LockMode`                  | SQL                                                                           |
| --------------------------- | ----------------------------------------------------------------------------- |
| `PESSIMISTIC_WRITE`         | `select "w0".* from "wallets" as "w0" where "w0"."id" = ? limit ? for update` |
| `PESSIMISTIC_READ`          | `... for share`                                                               |
| `PESSIMISTIC_PARTIAL_WRITE` | `... for update skip locked`                                                  |
| `PESSIMISTIC_WRITE_OR_FAIL` | `... for update nowait`                                                       |


**Conclusão: o MikroORM não gera `FOR NO KEY UPDATE`.** Confirmado também no código (`NativeQueryBuilder.js` só emite `for update`/`for share`).
Dentro de `em.transactional`, o `begin` é seguido imediatamente do `select ... for update`: a wallet é a primeira instrução da transação.
Segundo o CLAUDE.md, `FOR UPDATE` é aceitável **desde que seja a primeira instrução** (D2).

Também verificado: `em.execute('select ... for no key update', [id])` dentro de `em.transactional` usa a mesma transação, e o modo é o esperado:
outra conexão não obtém `FOR NO KEY UPDATE` (nowait) mas **obtém** `FOR KEY SHARE`. Já o `FOR UPDATE` do ORM bloqueia até o `KEY SHARE`.
Os dois lados estão em testes.

**Escolha para a Fase 2 (decisão pendente; ver Fase 1, "Locks"):** usar `LockMode.PESSIMISTIC_WRITE` (API do ORM, `FOR UPDATE`) como **primeira instrução**.
Alternativa: SQL parametrizado `FOR NO KEY UPDATE` via `em.execute`. O custo do `FOR UPDATE` é bloquear também quem só precisa de `KEY SHARE` (checagem de FK de um `INSERT` que referencia a wallet).
Como toda escrita da wallet já passa pelo lock primeiro (D2), a diferença prática esperada é pequena, mas **não foi medida**.
Observação medida (3 rodadas de 30 apostas): com a ordem errada, `FOR UPDATE` deu **86–87 deadlocks**; com a ordem errada e
`FOR NO KEY UPDATE`, **0** nesta máquina. Ou seja, o modo ameniza, mas **a ordem continua sendo a regra**: não dependemos do modo para ser correto.

### O que deu errado ou mudou no caminho

- Docker Desktop estava parado; foi iniciado. Limite do ambiente: 2 CPUs, ~3,8 GB. Postgres + MiniStack subiram `healthy` e a suíte rodou nesse limite.
- Imagem do MiniStack inexistente (decisão 1).
- `typescript-eslint` incompatível com TypeScript 7 (decisão 2).
- Migrator sem entidades (decisão 4).
- `bun test` com timeout padrão de 5 s derrubou o caso de ordem de lock na primeira execução (decisão 6b). Não era falha de schema.
- `bun test` sem arquivos de teste retorna erro.

### Limitações da Fase 0

- `.env` é local e ignorado pelo git; `.env.example` tem só as chaves. `requireEnv` falha cedo se faltar variável. O `README.md` (Fase 7) deve instruir `copy .env.example .env` e os valores de dev do compose.
- A migration roda em transação única; `down` apaga todos os dados do schema (esperado em dev; **nunca** rodar contra dados reais).
- O banco de testes acumula linhas entre execuções (UUIDs aleatórios, sem colisão). Isolamento por banco/schema fica para quando a suíte crescer.

---

## Fase 1 — Domínio e wallet

**Objetivo.** Modelar o núcleo de domínio (`Money`, `Wallet`, `LedgerEntry`, `WagerTransaction`) sem dependência de framework ou ORM,
montar as camadas da SPEC §9 e entregar `POST /wallets`, `GET /wallets/:walletId` e `GET /wallets/:walletId/ledger`
com o crédito de abertura (`OPENING` + `CREDIT`) gravado de forma atômica com a wallet.

### Estrutura

```
src/domain/          Money · Wallet · LedgerEntry · WagerTransaction · FailureCode · erros   (TypeScript puro)
src/application/     CreateWallet · GetWallet · ListLedger · portas (repositórios, UnitOfWork) · cursor · hash de payload
src/infrastructure/  entidades MikroORM · mappers · repositórios · MikroOrmUnitOfWork · retry transitório
src/interface/http/  controller · DTOs (zod) · mapeamento de erros · filtro global
```

As dependências apontam para dentro. Os casos de uso são classes comuns que recebem as portas no construtor; só `app.module.ts`
conhece o Nest e faz a composição. O domínio não importa Nest, MikroORM, zod nem `node:crypto`.

### Decisões

**1. `Money` em `bigint` de centavos.** Imutável, sempre não negativo, com moeda (`^[A-Z]{3}$`).
`fromString` aceita só `\d{1,17}(\.\d{1,2})?`: rejeita mais de 2 casas (o Postgres arredonda `10.005` para `10.01` em silêncio),
sinais, notação científica, espaços e valores que não cabem em `NUMERIC(19,2)`. O intervalo também é checado em `add`, para que
um crédito nunca produza um valor que o banco recusaria com `22003`. Moedas diferentes lançam `CurrencyMismatchError`.
Alternativas descartadas: `decimal.js` (dependência sem ganho para escala fixa 2) e string pura (sem aritmética segura).

**2. `Wallet.debit/credit` devolvem o `LedgerEntry`.** A invariante "toda alteração de saldo tem um lançamento" vira estrutural:
não há método que mude o saldo sem produzir o lançamento. O lançamento é construído (e sua aritmética validada) **antes** de
qualquer mutação, então uma falha deixa saldo e `version` intactos. `version` sobe só quando o saldo muda; valor zero é rejeitado.
`Wallet.create` devolve `{ wallet, openingEntry }`: com saldo inicial > 0 a wallet nasce na `version` 1 já com o lançamento
`CREDIT` de 0 até o saldo; com saldo 0 não há lançamento.
A exclusão mútua entre processos continua sendo do banco (lock da wallet, Fase 2); o domínio só garante as invariantes locais.

**3. `WagerTransaction` e a máquina de estados (SPEC §4).** Nasce `PENDING`; transições `markProcessed`, `markPendingReference`,
`reject`, `fail`. `PROCESSED`, `REJECTED` e `FAILED` são terminais e qualquer transição a partir deles lança
`InvalidTransactionStateError` (erro de programação, não caminho de negócio). `PENDING_REFERENCE` aceita reagendamento (soma
`attempts`) e nunca volta a `PENDING`. Todas as transições recebem o instante `at` como argumento, o que mantém o domínio
determinístico e testável. `reject` só aceita códigos de rejeição e `fail` só `INTERNAL_PERMANENT_ERROR`, espelhando o CHECK
`wt_failure_code_iff_failed`. `create` valida a exigência de referência por tipo (mesma regra do CHECK `wt_reference_by_kind`) e
`markProcessed` de uma reversão exige `referenceTransactionId` (CHECK `wt_reversal_has_reference`). `ledgerDirectionFor` encapsula
a direção: BET debita; WIN e OPENING creditam; reverter BET credita; reverter WIN ou REFUND debita; LOSS não move saldo.
Nesta fase só o caminho `OPENING` é exercitado de ponta a ponta; o restante é coberto por testes de unidade e será consumido na Fase 2.

**4. Unit-of-work e ordem de escrita.** `UnitOfWork.run` abre uma transação SQL sobre um fork novo do `EntityManager` e entrega
repositórios ligados a ela; `read` faz o mesmo sem transação. Cada `add` faz `flush` imediato, de modo que os `INSERT` saem na ordem
em que o caso de uso os chama (**wallet → transação → ledger**, a ordem global do projeto) e não na ordem que o ORM escolheria
num flush final. `persistence.test.ts` registra o SQL emitido e afirma essa ordem. Na criação não há `SELECT ... FOR UPDATE` a fazer:
a linha da wallet é nova e invisível para os demais até o commit, e a duplicidade é decidida pelo `UNIQUE (player_id, currency)`.
Alternativa descartada: persistir tudo e deixar um único `flush` no fim (ordem de INSERT delegada ao ORM, o que fere a regra de locks).

**5. `POST /wallets` atômico.** Wallet, transação `OPENING` (`provider_id = 'internal'`, `external_transaction_id = idempotency_key =
opening:{walletId}`, já `PROCESSED` com `observed_balance`) e lançamento `CREDIT` entram na mesma transação SQL. O `payload_hash`
usa o mesmo JSON canônico (chaves ordenadas recursivamente + SHA-256) que será usado nas transações de apostas. O banco confere a
consistência no COMMIT (trigger deferido): um teste mostra que gravar saldo sem lançamento falha e não deixa resíduo.
Wallet duplicada: a violação de `wallets_player_currency_uq` é traduzida no repositório para `WalletAlreadyExistsError` → `409`.
Com 50 requisições simultâneas para o mesmo player há 1 `201`, 49 `409`, 1 `OPENING` e 1 lançamento
(`test/concurrency/create-wallet.test.ts`). `initialBalance = 0.00` é aceito e não gera `OPENING` nem lançamento.

**6. Ledger paginado por keyset.** A consulta usa `seq > cursor ORDER BY seq LIMIT n+1` (o item extra revela a próxima página).
O cursor é o `base64url` do `seq`, e o decoder só aceita a forma canônica (sem padding, sem zeros à esquerda, dentro de `bigint`):
um cursor adulterado vira `400 INVALID_CURSOR` em vez de chegar ao banco. `seq` é atribuído pelo trigger do ledger com a wallet
travada até o COMMIT; por isso, dentro de uma mesma wallet, nenhum lançamento com `seq` menor aparece depois de um maior já visível, e
a paginação não repete nem omite itens mesmo com escritas entre as chamadas (testado inserindo lançamentos entre a 1ª e a 2ª página).
`limit` padrão 50, teto 100 (valores maiores são reduzidos ao teto; valores inválidos, `400`). Alternativa descartada: `OFFSET`
(instável sob inserção e de custo linear).

**7. Validação na borda com zod 4.** Objetos `strict` (campo desconhecido é erro). O zod só valida a forma; as regras de dinheiro
são de `Money`, chamado dentro do schema, para existir uma única fonte da verdade. `amount` como `number` JSON é rejeitado.
Ids são `z.uuid()`: id malformado devolve `400` e nunca chega ao Postgres (que responderia `22P02` e viraria 500).
Alternativa descartada: `class-validator` (decorators e segunda definição das regras de dinheiro).

**8. Mapeamento de erros (SPEC §5.2, parte aplicável).** Um único `toHttpError` puro, aplicado por um filtro global:
`400 VALIDATION_ERROR | INVALID_CURSOR | BAD_REQUEST`, `404 WALLET_NOT_FOUND | NOT_FOUND`, `409 WALLET_ALREADY_EXISTS`,
`503 SERVICE_UNAVAILABLE` + `Retry-After`, `500 INTERNAL_ERROR` genérico (sem vazar mensagem, stack ou string de conexão).
Corpo sempre `{ code, message, details? }`. Erros de domínio inesperados (por exemplo, `InvalidMoneyError` fora do DTO) são
tratados como bug: `500`.

**9. Erros transitórios.** `MikroOrmUnitOfWork` reexecuta o trabalho em `40P01`, `40001` e falhas de conexão (3 tentativas, backoff
exponencial com jitter total, base 20 ms). Esgotado, lança `TransientInfrastructureError` → `503`. Erros permanentes passam intactos.
Contrato: o callback de `run` não pode ter efeito fora do banco, pois pode ser reexecutado.

**10. Regra de lint contra `number` para dinheiro (README §14).** Em `src/**`, `no-restricted-syntax` bloqueia `parseFloat`,
`Number.parseFloat`, `Number(...)`, `+x` unário, `Math.round` e `.toFixed`, além de qualquer propriedade, parâmetro ou variável
cujo nome contenha `amount`, `balance`, `cents` ou `money` anotada como `number`. `test/unit/money-lint.test.ts` executa o ESLint
sobre trechos de código e prova que a regra barra e que não barra usos legítimos (contagens, `parseInt` de paginação).
Limitação: a regra é sintática e baseada em nomes, não em tipos; um valor monetário em variável de nome neutro anotada como `number`
não seria pego. A defesa de fundo é estrutural: o único tipo de dinheiro do domínio é `Money`, e as bordas só trocam strings decimais.

### Verificação

| Camada | Arquivos | Prova |
| --- | --- | --- |
| Unidade (148) | `test/unit/*` | `Money` (escala, >2 casas, entradas inválidas, moedas, limites de `NUMERIC(19,2)`), `Wallet` (saldo nunca negativo, `version`, cadeia dos lançamentos), `LedgerEntry` (aritmética, imutabilidade), `WagerTransaction` (todas as transições e terminais), cursor, hash, mappers, retry, mapeamento HTTP, regra de lint |
| Integração (97 no total, Postgres real) | `persistence`, `wallets-http`, `create-wallet-atomicity`, `lock-mode` | `OPENING` atômico; falha injetada no ledger não deixa wallet nem transação; ordem dos INSERTs; status HTTP e matriz de validação; paginação sem repetição nem omissão; comportamento de `LockMode` do ORM |
| Concorrência (2) | `test/concurrency/create-wallet.test.ts` | 50 criações da mesma wallet; 50 wallets distintas em paralelo; em ambos `wallet.balance == saldo reconstruído pelo ledger` |

Nenhum teste de integração ou de concorrência mocka PostgreSQL. A falha do teste de atomicidade é injetada trocando o método `add`
do repositório do ledger; o banco continua real.

### Limitações e pontos em aberto

- `POST /wallets` não é idempotente por chave: repetir a mesma requisição devolve `409`, não a wallet original (o README trata a duplicata como conflito).
- Os ids de wallet são UUID v4 gerados no servidor; o exemplo do README usa v7. Sem impacto funcional.
- `limit` acima do teto é reduzido silenciosamente em vez de rejeitado.
- O log de erros 5xx é mínimo (tipo, mensagem e stack, nunca o corpo); o formato estruturado com `correlationId` entra na Fase 6.
- Leituras (`GET`) não travam a wallet: devolvem o último estado commitado, o que é o esperado para consulta.
- O banco de testes acumula linhas entre execuções (UUIDs aleatórios; sem colisão).
- Decisão aberta para a Fase 2: lock com `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`, API do ORM) ou SQL parametrizado `FOR NO KEY UPDATE`.
  Em ambos a wallet é a primeira instrução da transação.
