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
| MikroORM 7 sob Bun (decorators legacy + `reflect-metadata`, descoberta de entidade)                               | OK                                                                                                              | `test/integration/orm-spike.test.ts`                               |
| Entidade de persistência + mapper + domínio com construtor privado e `rehydrate`                                  | OK: persiste, relê em um fork limpo, `balance` chega como `string`                                              | `orm-spike.test.ts` (1º e 2º testes)                               |
| Migration reversível que executa `db/001_init.up.sql` / `.down.sql` sem alterá-los                                | up → down → up OK; o `down` remove tabelas **e** funções                                                        | `test/integration/migration.test.ts` e `bun run migration:up/down` |
| `reference/schema.test.mjs` portado para `bun test`                                                               | 33 casos verdes (constraints, ledger, idempotência, corridas, controle negativo), 3 execuções seguidas estáveis | `test/integration/schema.test.ts`                                  |
| MiniStack: FIFO, `MessageGroupId`, deduplicação, `ChangeMessageVisibility`, DLQ com redrive (`maxReceiveCount=5`) | OK                                                                                                              | `test/integration/sqs.test.ts`                                     |
| Filas por script idempotente                                                                                      | OK (rodado duas vezes seguidas, mesmas URLs)                                                                    | `bun run infra:queues`                                             |
| `bun run check` (tsc strict + eslint + unit)                                                                      | verde. **Ainda não há testes unitários** (Fase 1); o script usa `--pass-with-no-tests` até lá                   | `bun run check`                                                    |
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
Testado com valor acima de `Number.MAX_SAFE_INTEGER` sem perda. O `Wallet` do spike é só estado; `Money`, `debit` e `credit` são da Fase 1.

**6. Porte do teste de schema.** Expectativas, SQL e regex do original preservados. Mudanças de **forma**:
`test()` por caso; conexão via `DATABASE_URL`; schema aplicado por migration; protótipo de corrida com `bigint` em centavos no lugar de `Number`.
Duas diferenças de **comportamento do teste**, declaradas:
(a) o caso informativo "ordem de lock" ganhou asserções só para a **regra** (0 deadlocks, 30/30 processadas, ledger consistente);
(b) timeout de 120 s nesse caso, pois o `bun test` limita cada teste a 5 s e as rodadas do anti-padrão esperam `deadlock_timeout` (1 s) por deadlock.

### SQL gerado pelo `LockMode` do MikroORM 7.2.11 (PostgreSQL)

Capturado com `debug: ['query']` em `orm-spike.test.ts`:


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

**Escolha para a Fase 2 (a confirmar com o João):** usar `LockMode.PESSIMISTIC_WRITE` (API do ORM, `FOR UPDATE`) como **primeira instrução**.
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
- `bun test` sem arquivos de teste retorna erro; `check` usa `--pass-with-no-tests` até a Fase 1.

### Limitações da Fase 0

- `.env` é local e ignorado pelo git; `.env.example` tem só as chaves. `requireEnv` falha cedo se faltar variável. O `README.md` (Fase 7) deve instruir `copy .env.example .env` e os valores de dev do compose.
- A migration roda em transação única; `down` apaga todos os dados do schema (esperado em dev; **nunca** rodar contra dados reais).
- O banco de testes acumula linhas entre execuções (UUIDs aleatórios, sem colisão). Isolamento por banco/schema fica para quando a suíte crescer.
- Lint ainda não proíbe `number` para dinheiro; entra na Fase 1 junto com `Money`.
- `test:concurrency` está vazio (`--pass-with-no-tests`); os cenários entram nas Fases 2–5.