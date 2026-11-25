# ARCHITECTURE — Distributed Wagering Processor

Decisões, alternativas, trade-offs e limitações do serviço. A primeira parte é temática; o registro detalhado, fase a fase, está em [Detalhes](#detalhes).
"Enunciado" é o documento do desafio; os números #1 a #8 citados nos testes são os cenários de concorrência obrigatórios dele.

---

## Sumário

- [Visão geral](#visão-geral)
- [Garantias e como são provadas](#garantias-e-como-são-provadas)
- [Decisões transversais](#decisões-transversais): [ORM](#orm-mikroorm), [Money](#mapeamento-do-money), [transações e locks](#estratégia-transacional-e-de-locks)
- [Autenticação](#autenticação)
- [Limitações conhecidas](#limitações-conhecidas): [trade-offs](#trade-offs-assumidos)
- [Detalhes](#detalhes)
  - [Regras e contratos](#regras-e-contratos): [estados](#máquina-de-estados-de-wagertransaction), [códigos de falha](#códigos-de-falha), [payloadHash](#idempotência-e-payloadhash), [limite do PENDING_REFERENCE](#limite-do-pending_reference), [interpretações](#interpretações-do-enunciado)
  - [Registro de decisões por fase](#registro-de-decisões-por-fase):
    [0, base técnica](#fase-0--base-técnica-e-spike-de-compatibilidade) ·
    [1, domínio e wallet](#fase-1--domínio-e-wallet) ·
    [2, HTTP, idempotência e lock](#fase-2--betwinloss-por-http-idempotência-e-lock) ·
    [3, reversões e worker](#fase-3--refund-rollback-pending_reference-e-worker) ·
    [4, SQS e inbox](#fase-4--consumidor-sqs-inbox-dlq-e-shutdown) ·
    [5, outbox](#fase-5--outbox-transacional-publishers-e-eventos-de-integração) ·
    [6, operação](#fase-6--reconciliação-health-métricas-e-logs) ·
    [revisão independente](#revisão-independente-correções-e-limitações-restantes)

## Visão geral

O serviço processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de vários provedores e mantém, por wallet, um saldo materializado e um ledger imutável que sempre conferem.
Deve continuar correto com mensagens duplicadas, fora de ordem ou simultâneas, com várias instâncias e com quedas antes ou depois do commit.

Componentes (todos no mesmo processo NestJS sob Bun; qualquer número de instâncias):

- **HTTP**: wallets, consulta de ledger, submissão e consulta de transações, reconciliação, health e métricas.
- **Consumidor SQS** (`wager-transactions.fifo`, com DLQ): a mesma submissão, por fila, com inbox persistente.
- **Worker de `PENDING_REFERENCE`**: reprocessa o que chegou antes da transação referenciada.
- **Publisher do outbox**: envia à fila `wager-events` os eventos já commitados.

PostgreSQL é a única fonte de verdade e o árbitro da concorrência; nenhuma garantia depende de memória do processo.

```
POST /wagering/transactions ─┐
                             ├─> ProcessWagerTransactionUseCase
wager-transactions.fifo ─────┘     chave já conhecida? replay ou conflito, sem lock de wallet
                                   BEGIN
                                     inbox (só SQS) ─> lock da wallet ─> transação ─> saldo + ledger ─> outbox
                                   COMMIT ─> só então resposta HTTP ou ack
                                        │
              referência ausente ───────┼──> PENDING_REFERENCE ──> worker (mesma regra, mesma ordem de locks)
                                        └──> outbox_messages ──> publisher (claim por lease) ──> wager-events
```

Camadas: `interface` e `infrastructure` dependem de `application`, que depende de `domain` (TypeScript puro, sem Nest nem ORM). A composição fica em `src/app.module.ts`.

## Garantias e como são provadas

Os testes de integração e de concorrência usam Postgres e MiniStack reais. A invariante `wallet.balance == saldo reconstruído pelo ledger` é conferida nos cenários que movem saldo.

| Garantia | Mecanismo | Teste que a prova |
| --- | --- | --- |
| Dinheiro nunca é `number` | `Money` (`bigint` em centavos), strings decimais nas bordas, `NUMERIC(19,2)`, regra de lint em `src/` | `test/unit/money.test.ts`, `test/unit/money-lint.test.ts` |
| Corrida não produz saldo negativo | Lock por wallet antes de decidir, regra no domínio e `CHECK (balance >= 0)` | `test/concurrency/wager-transactions.test.ts` (duas apostas de 80,00 em 100,00; 30 de 10,00 em 100,00), `test/integration/schema.test.ts` |
| Sem débito ou crédito duplicado | `UNIQUE` da chave e do id externo, um lançamento por transação e wallet, no máximo uma reversão efetiva (índice parcial) | `test/concurrency/wager-transactions.test.ts` (mesma `BET` x50), `test/concurrency/reversals.test.ts`, `test/concurrency/sqs-consumer.test.ts` |
| Idempotência no banco | `INSERT ... ON CONFLICT (idempotency_key)`, `payloadHash` separa replay de conflito; inbox com `PK (consumer_name, message_id)` | `test/integration/process-wager-transaction.test.ts`, `test/integration/process-wager-inbox.test.ts`, `test/concurrency/outbox.test.ts` (replay depois de reiniciar o serviço) |
| Correto com várias instâncias | Exclusão mútua por lock de linha; publisher e worker dividem trabalho por lease com `SKIP LOCKED`; nada em memória | `test/concurrency/wager-multiprocess.test.ts` (3 processos), `test/concurrency/reversals.test.ts`, `test/concurrency/outbox.test.ts` |
| Evento só depois do commit, sem perda | Transactional outbox na mesma transação do fato; publisher só enxerga o commitado; entrega at-least-once | `test/integration/outbox-publisher.test.ts`, `test/integration/outbox-atomicity.test.ts`, `test/concurrency/outbox.test.ts` |
| Ledger imutável e auditável | Triggers contra `UPDATE`, `DELETE` e `TRUNCATE`, cadeia `before`/`after`, saldo conferido no `COMMIT`, reconciliação por API | `test/integration/schema.test.ts`, `test/integration/reconciliation.test.ts` |
| Testes sem mock de Postgres ou SQS | Containers do `docker-compose.yml`; falhas injetadas embrulhando o adaptador ou o repositório real, ou apontando para um endereço morto | `test/integration/sqs.test.ts`, `test/integration/health.test.ts`, `test/integration/sqs-consumer.test.ts` |

**Verificação final** (Bun 1.4.4, Postgres 16 e MiniStack 1.5.44 do `docker-compose.yml`, 2026-11-25):

| Comando | Cobre | Resultado |
| --- | --- | --- |
| `bun run check` | tipos, lint e testes de unidade | 430 testes em 30 arquivos, 0 falhas |
| `bun run test:integration` | Postgres e MiniStack reais | 388 testes em 38 arquivos, 0 falhas |
| `bun run test:concurrency` | paralelismo e processos reais | 22 testes em 7 arquivos, 0 falhas |

## Decisões transversais

### ORM: MikroORM

O enunciado aceita MikroORM (preferencial) ou TypeORM. Ficamos com o **MikroORM 7**; o TypeORM era o plano B caso o MikroORM não funcionasse sob Bun. Como funcionou, o TypeORM não foi instalado nem medido, e não afirmamos que lhe falte algum destes recursos.

O que pesou, tudo exercitado no projeto:

- **Lock pessimista explícito** e inspecionável: o SQL que o `LockMode` gera foi capturado em teste.
- **Transação e SQL cru na mesma unidade de trabalho**: dentro de `em.transactional`, `em.execute` usa a mesma transação; entidades, `ON CONFLICT`, `SKIP LOCKED` e o lock da wallet convivem nela.
- **Migrations por lista** (`migrationsList`): a classe é registrada explicitamente, sem glob nem etapa de build, e executa o SQL de `db/` como está.

O que o ORM **não** faz, e o que isso custa:

- Não gera `FOR NO KEY UPDATE`: o lock da wallet é SQL escrito à mão, seguido de uma releitura pelo ORM (uma consulta a mais).
- `em.execute` com `?` não é prepared statement do servidor: o MikroORM escapa e interpola os valores no cliente (testado com entrada maliciosa; os valores nunca são concatenados por nós).
- O `INSERT ... ON CONFLICT` do inbox e da transação, os claims com `SKIP LOCKED` e a reconciliação são SQL cru.
- Unit of Work e Identity Map quase não são aproveitados: há um fork do `EntityManager` por chamada e `flush` a cada `add`, para os `INSERT` saírem na ordem de locks.
- O schema não é derivado das entidades (`snapshot: false`): constraints e triggers vivem em SQL, e divergência entre entidade e tabela só aparece em execução, nos testes.
- `MikroORM.init` exige ao menos uma entidade, salvo `warnWhenNoEntities: false` (necessário para só migrar).

Detalhes: [Fase 0](#fase-0--base-técnica-e-spike-de-compatibilidade) e [Fase 2](#fase-2--betwinloss-por-http-idempotência-e-lock).

### Mapeamento do Money

- **Domínio** (`src/domain/money.ts`): classe imutável, não negativa, `bigint` em centavos mais moeda de três letras; operar moedas diferentes lança erro.
- **Bordas** (HTTP, SQS, eventos): `{ "amount": "25.00", "currency": "BRL" }`; `number` JSON é rejeitado, assim como mais de 2 casas.
- **Banco**: `NUMERIC(19,2)` e `char(3)`; a entidade declara o valor como `string` e o mapper converte com `Money.fromString`. Nenhum passo intermediário é ponto flutuante.
- O Postgres arredonda `10.005` em silêncio; por isso a rejeição acontece em `Money`, antes do banco.

**Por que assim.** `bigint` em centavos é exato, tem escala fixa de 2 por construção e não pede dependência. Descartados: `decimal.js` (dependência sem ganho para essa escala) e string pura (sem aritmética segura).
**Adaptações do esqueleto do enunciado:** o valor é um `bigint` no lugar de `Decimal`; as factories são `fromString`, `fromCents` e `zero`; não há `negate` nem `isNegative`, porque `Money` nunca é negativo: entradas negativas são proibidas, o saldo não pode ser negativo e o sentido do movimento está em `DEBIT`/`CREDIT`.
A única grandeza com sinal, a `difference` da reconciliação, é calculada no banco e devolvida como string decimal. Moeda é validada pela forma (três letras maiúsculas), não contra a lista ISO-4217.

Alternativas e testes: [Fase 1](#fase-1--domínio-e-wallet).

### Estratégia transacional e de locks

- Uma transação SQL por processamento (`READ COMMITTED`, o padrão do Postgres): inbox, transação, saldo, ledger e outbox são atômicos.
- **Lock pessimista por wallet** (`FOR NO KEY UPDATE`), na primeira instrução que toca a wallet. Não há lock global.
- **Ordem global: wallet → transação → ledger → outbox.** O inbox vem antes e não toca a wallet. Inserir a transação antes de travar a wallet causa deadlock (medido com `FOR UPDATE`).
- `lock_timeout` de 3 s; deadlock, serialização, timeout de lock e falha de conexão têm 3 tentativas com jitter; esgotadas, `503` no HTTP e mensagem sem ack no SQS.
- Publisher e worker reivindicam por **lease** (`SKIP LOCKED`) numa transação curta e processam fora dela; o worker então trava a wallet primeiro.
- O banco é a última defesa: `CHECK`, `UNIQUE`, índice parcial e triggers valem mesmo que a aplicação erre.

**Campo `version` da wallet.** Começa em 1 e sobe exatamente 1 a cada mudança de saldo, nunca sem ela: regra do domínio, repetida pelo trigger `wallets_guard`.
**Não é o controle de concorrência:** `saveBalance` atualiza por `id`, sem `WHERE version = ?`, e quem exclui é o lock. Ele aparece nas respostas de wallet e, como `walletVersion` em `WalletBalanceChanged`, permite ao consumidor ordenar as mudanças de saldo e detectar lacunas.

| Alternativa descartada | Motivo |
| --- | --- |
| Otimista (`version` + retry) | Muitas requisições na mesma wallet viram tempestade de retries; as reversões têm vários passos e pedem estado estável |
| `UPDATE` atômico condicionado ao saldo | Resolve só o caso de um passo; reversões precisariam de outro mecanismo |
| `FOR UPDATE` pelo `LockMode` do ORM | Também serializa, mas conflita com o `FOR KEY SHARE` das checagens de FK; a vantagem de `FOR NO KEY UPDATE` neste fluxo não foi medida |
| Lock global | Proibido pelo enunciado; a unidade de concorrência é a wallet |

Detalhes: [Fase 2](#fase-2--betwinloss-por-http-idempotência-e-lock), [Fase 3](#fase-3--refund-rollback-pending_reference-e-worker) e [Fase 5](#fase-5--outbox-transacional-publishers-e-eventos-de-integração).

## Autenticação

**Decisão: não implementar autenticação.** O enunciado a deixa a critério do candidato, não a pontua, e aceita a omissão se documentada com um ponto de extensão no código. O tempo foi para correção financeira, concorrência e idempotência.
**Consequência hoje:** quem alcança a porta HTTP opera como qualquer provedor. O serviço não deve ser exposto fora de uma rede confiável.

Desenho que adotaríamos:

1. **Identity Provider externo** com OIDC (por exemplo, Keycloak), fluxo *client credentials*, um client por provedor. Nenhuma tabela própria de usuários ou senhas.
2. Um guard valida o token: assinatura pelas chaves do JWKS, `iss`, `aud` e `exp`. Token ausente ou inválido: `401`.
3. O provedor é identificado por uma **claim do token** (por exemplo, `provider_id`, configurada no client) e comparada com o `providerId` do corpo. Divergência: `403`, sem gravar nada.
4. A mesma comparação vale para a consulta por `/providers/:providerId/...`. Wallets, reconciliação e consulta por id interno exigem um papel de operador ou a checagem do dono da transação.
5. `/health/*` e `/metrics` ficam abertos, restritos por rede.
6. A **fila é canal interno confiável**: quem pode produzir é controlado pela política da fila (IAM), não por token na mensagem. A identidade contida na mensagem continua passando pelas mesmas validações do HTTP (formato, referência resolvida dentro do provedor, player e moeda da wallet).

Como o `providerId` entra no `payloadHash`, um replay só devolve o resultado a quem envia o mesmo `providerId`. A `idempotencyKey`, porém, é única no serviço inteiro: um provedor que use a chave de outro recebe `409`.

### Ponto de extensão no código

**Hoje o `AuthGuard` é no-op:** `authenticate()` devolve `true` sem ler a requisição, e o adaptador da porta aceita qualquer `providerId`. Nada é autenticado nem autorizado.
A validação real entra em dois lugares:

1. **Quem é o chamador:** em `AuthGuard.authenticate`. Ele hoje não recebe parâmetros; `canActivate`, que já tem o `ExecutionContext`, passaria o contexto a ele para ler e validar o token.
2. **Em nome de quem pode agir:** em um novo adaptador de `ProviderIdentityPort`, registrado no lugar de `TrustedProviderIdentity` no token `PROVIDER_IDENTITY` em `src/app.module.ts`.

| Peça | Onde | Hoje | Com autenticação real |
| --- | --- | --- | --- |
| `AuthGuard`, global (`APP_GUARD`) | `src/interface/http/auth.guard.ts` | No-op: `authenticate()` devolve `true` | Recebe o `ExecutionContext` e valida o token |
| `@OpenRoute()` | `HealthController`, `MetricsController` | Essas rotas nem chegam a `authenticate()` | Continuam abertas |
| `ProviderIdentityPort` | `src/application/ports.ts` | Chamada em `POST /wagering/transactions`, depois da validação e antes do caso de uso | Compara a claim do token com `declaredProviderId` e rejeita |
| Adaptador `TrustedProviderIdentity` | `src/infrastructure/identity/trusted-provider-identity.ts` | Confia no `providerId` do corpo | Substituído na composição (`src/app.module.ts`) |

`test/integration/auth-extension.test.ts` prova que status, corpo, replay e saldo não mudam com ou sem `Authorization`, que o guard é chamado nas rotas protegidas e não nas abertas, e que uma recusa do guard ou da porta responde `403` sem gravar nada.
O que **ainda faltaria**: chamar a porta na consulta por `/providers/:providerId/...`, definir os papéis das demais rotas e dar ao `401` e ao `403` um `code` próprio no mapeamento de erros (hoje o `403` sai como `HTTP_ERROR`). O consumidor SQS não passa pelo guard nem pela porta.

## Limitações conhecidas

Resumo; o detalhe e a justificativa da maioria estão na seção de cada fase.

- **Chave de idempotência:** o header HTTP tem os espaços das pontas removidos; `data.idempotencyKey` da fila não.
- **Contratos:** `POST /wallets` não é idempotente (repetir dá `409`); o `providerId` `internal` não é reservado; não há `statement_timeout`.
- **Segurança:** sem autenticação; `/metrics` e health abertos; a aplicação conecta como dona das tabelas, e quem tem esse papel pode desligar triggers (não há papel restrito de banco).
- **Escala:** escritas na mesma wallet são serializadas; throughput sob carga não foi medido (sem teste de carga). Prazos, lotes e backoffs são estimativas. Ver [Fase 2](#fase-2--betwinloss-por-http-idempotência-e-lock).
- **Reversões e referências:** sem reversão parcial; referência que não chega em cerca de 3 a 4,5 minutos vira `REJECTED`, mas um reprocesso que só falha com erro não tem teto de tentativas. Ver [Limite do PENDING_REFERENCE](#limite-do-pending_reference).
- **Fila (falhas):** erro inesperado vai à DLQ na primeira ocorrência, e mensagem anterior à criação da wallet também.
- **Fila (ordem):** a ordem por wallet não sobrevive à DLQ, não cobre HTTP nem pendências, e não há heartbeat de visibilidade. O `MessageGroupId` é escolhido pelo produtor e o consumidor não o altera: **produtores externos devem normalizar o `walletId` para minúsculas antes de usá-lo como grupo** (o produtor de demonstração, `scripts/send-wager-message.ts`, já faz isso). Sem isso, o mesmo `walletId` com caixas diferentes cai em grupos diferentes, sem ordem entre eles (o saldo continua protegido pelo banco). Comportamentos verificados no MiniStack, não na AWS. Ver [Fase 4](#fase-4--consumidor-sqs-inbox-dlq-e-shutdown).
- **Eventos:** at-least-once e sem ordem de entrega (o consumidor deduplica por `eventId` e ordena o saldo por `walletVersion`); outbox sem DLQ; inbox e outbox sem retenção. Ver [Fase 5](#fase-5--outbox-transacional-publishers-e-eventos-de-integração).
- **Operação:** reconciliação sob demanda, com custo proporcional ao ledger da wallet; métricas por instância; sem dashboard, alertas nem tracing; saídas do runtime e de bibliotecas podem escapar do log JSON. Ver [Fase 6](#fase-6--reconciliação-health-métricas-e-logs).
- **Relógio:** leases e backoffs usam o relógio da aplicação; desvio entre instâncias desloca vencimentos.
- **Escopo:** o fluxo é exercitado em BRL (o modelo é multi-moeda e o conflito é testado); sem partidas dobradas; o `docker-compose.yml` sobe só Postgres e MiniStack, e a aplicação roda com `bun run start`.

### Trade-offs assumidos

| Escolha | Ganho | Custo |
| --- | --- | --- |
| Lock pessimista por wallet | Regras decididas sobre estado estável, sem tempestade de retries | Escritas da mesma wallet em série; quem espera segura uma conexão do pool |
| Domínio separado do ORM, com mappers | Domínio puro e testável sem banco | Mais código; divergência entidade e tabela só aparece em execução |
| Constraints e triggers no banco | Invariantes valem mesmo com erro na aplicação | Regras repetidas em dois lugares; mudar o schema exige migration |
| Outbox com publicação separada | Nenhum evento sem commit nem perdido | Duplicatas possíveis, latência de cerca de 1 s, sem ordem de entrega |
| Erro desconhecido na fila vai à DLQ | Bug não entra em laço de reentrega | Falha transitória não reconhecida exige reprocesso manual |
| Log sem mensagem de erro de terceiros | Não vaza valores nem payload | Diagnóstico com menos texto |

---

## Detalhes

### Regras e contratos

Referência única de estados, códigos, idempotência e interpretações. O raciocínio de cada decisão está no registro por fase, adiante.

#### Máquina de estados de WagerTransaction

Estados terminais: **`PROCESSED`, `REJECTED` e `FAILED`**. A transação nasce `PENDING` (`WagerTransaction.create`).

| De \ Para | `PENDING` | `PENDING_REFERENCE` | `PROCESSED` | `REJECTED` | `FAILED` |
| --- | --- | --- | --- | --- | --- |
| `PENDING` | proibida (não há método) | válida (`markPendingReference`) | válida (`markProcessed`) | válida (`reject`) | válida (`fail`) |
| `PENDING_REFERENCE` | **proibida** (domínio e trigger) | válida (reagenda, `attempts + 1`) | válida | válida | válida |
| `PROCESSED` (terminal) | proibida | proibida | proibida | proibida | proibida |
| `REJECTED` (terminal) | proibida | proibida | proibida | proibida | proibida |
| `FAILED` (terminal) | proibida | proibida | proibida | proibida | proibida |

- **Condições:** `markProcessed` de `REFUND` ou `ROLLBACK` exige `referenceTransactionId`; `reject` aceita qualquer código menos `INTERNAL_PERMANENT_ERROR`; `fail` aceita só esse.
- **Domínio:** transicionar um terminal lança `InvalidTransactionStateError` (erro de programação).
- **Banco** (trigger `wager_transactions_guard`): recusa qualquer `UPDATE` de linha terminal, `PENDING_REFERENCE` para `PENDING`, mudança de colunas de identidade e `DELETE`. As demais transições ficam a cargo do domínio.
- **O que é gravado hoje:** `PROCESSED`, `REJECTED` e `PENDING_REFERENCE`. A aplicação não persiste `PENDING`, e nenhum caminho chama `fail`.
- **Provas:** `test/unit/wager-transaction.test.ts`, `test/integration/schema.test.ts`.

#### Códigos de falha

Fonte: `src/domain/failure-code.ts` (12 códigos). A ordem de precedência das regras está em "Regras de reversão e códigos de falha" (Fase 3).

- **HTTP:** vale para a submissão e para o replay. A consulta (`GET`) responde `200` com `status` e `failureCode`. Pela fila não há status: a mensagem recebe ack e a rejeição sai no evento `WagerTransactionRejected`.
- **Reenviar:** nenhum `failureCode` se resolve reenviando a mesma requisição, que devolve o mesmo resultado. Reenvio é para `503` (e, na fila, a mensagem sem ack).
- **Corrigir:** é uma **nova** transação, com `externalTransactionId` e `Idempotency-Key` novos. Mesma chave com payload corrigido, ou mesmo id externo com outra chave, dá `409`.
- **Desistir:** não há payload que mude o resultado daquela operação naquele momento.

| Código | Quando ocorre | HTTP | O que o provedor faz |
| --- | --- | --- | --- |
| `INSUFFICIENT_BALANCE` | `BET` maior que o saldo | `422` | Desistir; outra aposta é outra transação |
| `BALANCE_LIMIT_EXCEEDED` | Crédito passaria do máximo de `NUMERIC(19,2)` | `422` | Desistir e escalar à operação |
| `REVERSAL_WOULD_OVERDRAW` | Reversão que debita (`ROLLBACK` de `WIN` ou `REFUND`) deixaria o saldo negativo | `422` | Desistir e escalar; como rejeitada não conta como reversão, uma nova é avaliada se houver saldo |
| `REFERENCE_NOT_FOUND` | A referência não chegou, ou seguiu pendente, até o limite do worker | `202` na submissão; `422` no replay após o limite | Corrigir: enviar a referenciada e depois uma nova transação |
| `REFERENCE_MISMATCH` | Referência de outro player, wallet, rodada ou moeda | `422` | Corrigir o payload |
| `INVALID_REFERENCE_KIND` | `REFUND` que não aponta `BET`; `ROLLBACK` que não aponta `BET`, `WIN` ou `REFUND`; `WIN`/`LOSS` que não aponta `BET` | `422` | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | A referência está `REJECTED` ou `FAILED` | `422` | Desistir: não há o que reverter |
| `ALREADY_REVERSED` | `REFUND`/`ROLLBACK` de referência que já tem reversão efetiva | `422` | Desistir: já está revertida |
| `AMOUNT_MISMATCH` | Valor de `REFUND`/`ROLLBACK` diferente do da referência | `422` | Corrigir o payload |
| `CURRENCY_MISMATCH` | Moeda diferente da wallet | `422` | Corrigir o payload |
| `PLAYER_MISMATCH` | `playerId` não é o dono da wallet | `422` | Corrigir o payload |
| `INTERNAL_PERMANENT_ERROR` (status `FAILED`) | Erro permanente de infraestrutura; previsto no domínio, **nenhum caminho atual o grava** (ver Fase 4) | `422` se existisse | Desistir e contatar o suporte |

Erros sem `failureCode` (`400`, `404`, `409`, `500`, `503`) estão na tabela "Mapeamento HTTP" (Fase 1, decisão 8).

#### Idempotência e payloadHash

Implementação: `src/application/payload-hash.ts`; o caso de uso monta a entrada (`src/application/process-wager-transaction.use-case.ts`), igual para HTTP e SQS.

| Entra no hash | Observação |
| --- | --- |
| `playerId`, `walletId` | UUIDs já normalizados para minúsculas na borda |
| `providerId`, `externalTransactionId`, `roundId`, `gameId`, `kind` | Como recebidos depois da validação, sem aparar nem mudar maiúsculas |
| `money.amount`, `money.currency` | `amount` normalizado para 2 casas por `Money.toProps()`: `"5"` e `"5.00"` dão o mesmo hash |
| `referenceExternalTransactionId` | Só quando presente; ausente, a chave não aparece no JSON |

**Fica de fora:** a chave de idempotência (header `Idempotency-Key` ou `data.idempotencyKey`), `correlationId`, `messageId`, `type` e `occurredAt` da mensagem e cabeçalhos como `Authorization`. Campo desconhecido no corpo é recusado na validação, então não há o que ignorar.

**Canonização (`canonicalJson`):** chaves de objeto ordenadas recursivamente (comparação por unidades UTF-16), sem espaços; chaves com valor `undefined` omitidas; arrays mantêm a ordem (o payload atual não tem arrays); escalares serializados por `JSON.stringify`.
**Hash:** SHA-256 do texto em UTF-8, em hexadecimal (64 caracteres). Exemplo, que é o vetor fixo de `test/unit/payload-hash.test.ts`:

```
{"externalTransactionId":"ext-1","gameId":"g1","kind":"BET","money":{"amount":"10.00","currency":"BRL"},"playerId":"p1","providerId":"prov","roundId":"r1","walletId":"w1"}
c35c7153b3f48996a7edd07ab2e00c8b4c871d1b2511ed96f6d5a3194fb0606a
```

**UUIDs:** como a normalização vem antes do hash, a mesma operação com outra caixa é replay. Não há migração de hashes: um registro gravado antes da normalização, a partir de UUID em maiúsculas, teria outro hash, e o reenvio daria conflito.

**Uso:** gravado em `wager_transactions.payload_hash` e em `inbox_messages.payload_hash`. Mesma chave e mesmo hash é replay; mesma chave e outro hash é conflito (`409`; na fila, DLQ).
A transação interna `OPENING` usa o mesmo algoritmo, com `providerId = "internal"` e `roundId = gameId = "opening"`.

#### Limite do PENDING_REFERENCE

Vale para `REFUND`, `ROLLBACK` e `WIN`/`LOSS` com referência. Constantes em `src/domain/reference-retry-policy.ts`, não configuráveis em runtime.

| Ponto | Valor | Natureza |
| --- | --- | --- |
| Limite | 1 avaliação na submissão + 8 reprocessamentos; a 9ª sem referência grava `REJECTED/REFERENCE_NOT_FOUND` e o evento | Escolha nossa (**estimativa**) |
| Backoff | `min(60 s, 1 s · 2ⁿ⁻¹)` mais jitter de 0 a +50% | Escolha nossa (**estimativa**) |
| Espera somada | 183 s sem jitter, até cerca de 274 s com jitter, mais o intervalo do worker (1 s entre passadas) | Calculado das constantes, não medido em produção |
| Premissa | A desordem entre uma operação e a sua referência se resolve em segundos; alguns minutos cobrem atraso de fila e retry do provedor | **Hipótese, não medida** |

**É um limite de tentativas, não um TTL por relógio.** Só conta a avaliação concluída. Se o reprocesso falha com erro, a transação SQL é desfeita, `attempts` não muda e a pendência volta após o lease de 30 s, **sem teto**; com o worker parado, o prazo também não corre.
Prova do limite: `test/integration/pending-reference-worker.test.ts`. Justificativa de cada número: "PENDING_REFERENCE e o worker" (Fase 3).

#### Interpretações do enunciado

Pontos que o enunciado deixa em aberto ou ambíguos, e a leitura adotada.

| # | Tema | Leitura adotada | Detalhe |
| --- | --- | --- | --- |
| 1 | Reversão única | No máximo **uma** reversão efetiva (`REFUND` ou `ROLLBACK`) por referência, não uma por tipo; rejeitada não conta; desfazer o `REFUND` não libera a `BET` | Fase 3 |
| 2 | Valores | Toda submissão exige `amount > 0`, inclusive `LOSS` (que não move saldo); `initialBalance` zero é aceito e não gera `OPENING` | Fases 1 e 2 |
| 3 | `WIN`/`LOSS` com referência | Opcional; se vier, tem de ser uma `BET` `PROCESSED` do mesmo player, wallet, rodada e moeda; o valor pode diferir; ausente no banco, fica pendente | Fase 3 |
| 4 | Referência ainda pendente | Quem depende dela também espera | Fase 3 |
| 5 | Resolução da referência | Por `(providerId, referenceExternalTransactionId)`: o mesmo id em outro provedor não é a referência | Fase 3 |
| 6 | Replay | Mesmo status HTTP e `failureCode`, saldo observado na época; replay de pendente devolve o estado atual | Fases 2 e 3 |
| 7 | Duas chaves de unicidade | Mesmo `(providerId, externalTransactionId)` com outra chave é conflito `409` | Fase 2 |
| 8 | `Idempotency-Key` | Obrigatória; o formato `{providerId}:{externalTransactionId}` é recomendação, não exigência | Fase 2 |
| 9 | Wallet inexistente | `404`, nada gravado | Fase 2 |
| 10 | Player ou moeda divergentes | Rejeição auditável (`422`); precedência: player, moeda, referência, saldo | Fases 2 e 3 |
| 11 | Crédito acima do máximo | Código próprio, `BALANCE_LIMIT_EXCEEDED`, em vez de erro `500` | Fase 3 |
| 12 | Conflito e wallet inexistente pela fila | Tratados como permanentes (DLQ), não como erro de negócio com ack, porque nada fica gravado | Fase 4 |
| 13 | `FAILED` pela fila | Não é gravado; a trilha é a DLQ com `FailureReason` | Fase 4 |
| 14 | `messageId` repetido com outro conteúdo | Erro permanente | Fase 4 |
| 15 | Eventos | `LOSS` gera `Processed` sem `BalanceChanged`; `PendingReference` só na 1ª vez; replay não gera evento; `OPENING` gera os mesmos de qualquer transação aplicada | Fases 5 e 6 |
| 16 | Destino dos eventos | Fila SQS padrão `wager-events` | Fase 5 |
| 17 | `correlationId` ausente | É o id da transação | Fase 5 |
| 18 | Divergência na reconciliação | Resposta `200` com `consistent: false`, log e métrica; nunca corrige | Fase 6 |
| 19 | Caixa dos UUIDs | Normalizados para minúsculas uma vez, na borda (`uuidSchema`, `src/interface/http/wallets.dto.ts`): `playerId` e `walletId` no HTTP e na mensagem SQS, e `:walletId` e `:transactionId` nas rotas. O `payloadHash` usa o valor já normalizado. Ids que não são UUID (`idempotencyKey`, `externalTransactionId`, `referenceExternalTransactionId` e os demais) ficam como chegaram. O `MessageGroupId` não passa pela borda: o produtor deve normalizar o `walletId` antes de escolhê-lo. Provas em `test/unit/uuid-case.test.ts`, `test/integration/uuid-case.test.ts` e `test/unit/send-wager-message.test.ts` | Idempotência e payloadHash |

### Registro de decisões por fase

Cada fase registra o que foi decidido, as alternativas, os trade-offs e as limitações daquele momento; quando uma fase posterior supera um ponto, o texto diz.
Os controles negativos (mutações temporárias no código) descrevem a execução feita quando a decisão foi tomada. Os totais atuais de testes estão em "Verificação final", no início do documento.

#### Fase 0 — Base técnica e spike de compatibilidade

**Objetivo.** Verificar a base antes das regras de negócio: Bun + NestJS + MikroORM, Postgres e emulador de SQS reais,
migration reversível do schema e testes do schema contra Postgres real.

##### O que foi verificado (e como)

| Item | Resultado | Prova |
| --- | --- | --- |
| Versões instaladas (fixadas, sem `^`) | Bun 1.4.4, NestJS 12.6.0, MikroORM 7.2.11, `@aws-sdk/client-sqs` 3.1176.0, `pg` 8.23.1, TypeScript 6.0.3 | `package.json`, `bun.lock` |
| Nest sob Bun (DI por tipo com `emitDecoratorMetadata`, rota HTTP) | OK | `test/integration/nest-di.test.ts` |
| MikroORM 7 sob Bun (decorators legacy + `reflect-metadata`, descoberta de entidade) | OK | `test/integration/persistence.test.ts` |
| Entidade de persistência + mapper + domínio com construtor privado e `rehydrate` | Persiste, relê em um fork limpo, `balance` chega como `string` | `test/unit/mappers.test.ts`, `test/integration/persistence.test.ts` |
| Migration reversível que executa `db/001_init.up.sql` e `db/001_init.down.sql` | up, down e up de novo; o `down` remove tabelas **e** funções | `test/integration/migration.test.ts`, `bun run migration:up` e `migration:down` |
| Schema (constraints, ledger, idempotência, corridas, controle negativo sem lock) | 33 casos verdes, estáveis em 3 execuções seguidas | `test/integration/schema.test.ts` |
| MiniStack: FIFO, `MessageGroupId`, deduplicação, `ChangeMessageVisibility`, DLQ com redrive (`maxReceiveCount=5`) | OK | `test/integration/sqs.test.ts` |
| Criação das filas por script idempotente | Repetir devolve as mesmas URLs | `bun run infra:queues` |

##### Decisões

**1. Emulador de AWS: `ministackorg/ministack:1.5.44`.** Licença MIT (label OCI da imagem), sem conta nem token, tag fixa; o repositório declarado pela imagem é `github.com/ministackorg/ministack`.
O enunciado aceita LocalStack ou MiniStack; descartamos o LocalStack porque passou a exigir conta e token em 23/03/2026.

**2. TypeScript 6.0.3, não 7.0.2.** O npm oferece o 7.0.2, mas `typescript-eslint` 8.74.0 declara `typescript >=4.8.4 <6.1.0`.
Para lint e `tsc` usarem a mesma versão, ficamos no 6.0.3. Reavaliar quando o `typescript-eslint` suportar o 7.

**3. Migration por `migrationsList`, não por glob.** O Migrator recebe a classe `InitMigration` explicitamente (`orm.config.ts`), sem descoberta de arquivos:
funciona igual em Bun/TS sem build. `snapshot: false`, porque o schema vem de `db/*.sql` (fonte única) e não de diff de entidades.
A migration lê os `.sql` e envia cada um **inteiro em uma única `addSql`**. Verificado no código do `MigrationRunner`: cada item vira uma chamada `driver.execute`, sem partir por `;`.
Isso importa porque o corpo das funções PL/pgSQL é delimitado por `$$` e contém `;`.

**4. O Migrator exige entidades.** `MikroORM.init` lança `No entities found` sem entidades; o script de migração e os testes que só migram passam
`discovery: { warnWhenNoEntities: false }`, porque migrar só executa SQL.

**5. Persistência separada do domínio.** `Wallet` (domínio) tem construtor privado e `Wallet.rehydrate(state)`; `WalletEntity` (persistência) leva os decorators; `WalletMapper` converte.
`NUMERIC(19,2)` chega como `string` e o mapper converte para `bigint` em centavos. Testado com valor acima de `Number.MAX_SAFE_INTEGER`, sem perda.
Alternativa descartada: decorators do ORM nas classes de domínio. O enunciado exige domínio encapsulado e independente do ORM; os mappers custam mais código, mas são explícitos.

##### SQL gerado pelo `LockMode` do MikroORM 7.2.11 (PostgreSQL)

Capturado com `debug: ['query']` em `lock-mode.test.ts`:

| `LockMode`                  | SQL                                                                           |
| --------------------------- | ----------------------------------------------------------------------------- |
| `PESSIMISTIC_WRITE`         | `select "w0".* from "wallets" as "w0" where "w0"."id" = ? limit ? for update` |
| `PESSIMISTIC_READ`          | `... for share`                                                               |
| `PESSIMISTIC_PARTIAL_WRITE` | `... for update skip locked`                                                  |
| `PESSIMISTIC_WRITE_OR_FAIL` | `... for update nowait`                                                       |

**Conclusão: o MikroORM não gera `FOR NO KEY UPDATE`.** Confirmado também no código instalado (o `NativeQueryBuilder` só emite `for update`/`for share`).
Dentro de `em.transactional`, o `begin` é seguido imediatamente do `select ... for update`: a wallet é a primeira instrução da transação.
`FOR UPDATE` seria aceitável **desde que fosse a primeira instrução** a tocar a wallet (ver "Estratégia transacional e de locks").

Também verificado: `em.execute('select ... for no key update', [id])` dentro de `em.transactional` usa a mesma transação, e o modo é o esperado:
outra conexão não obtém `FOR NO KEY UPDATE` (nowait) mas **obtém** `FOR KEY SHARE`. Já o `FOR UPDATE` do ORM bloqueia até o `KEY SHARE`.
Os dois lados estão em testes.

**Escolha para a Fase 2:** SQL `FOR NO KEY UPDATE` via `em.execute`, como primeira instrução da transação (decisão e alternativas na seção "Fase 2").
Observação medida (3 rodadas de 30 apostas): com a ordem errada, `FOR UPDATE` deu **86–87 deadlocks**; com a ordem errada e
`FOR NO KEY UPDATE`, **0** nesta máquina. Ou seja, o modo ameniza, mas **a ordem continua sendo a regra**: não dependemos do modo para ser correto.

##### Limitações da Fase 0

- `.env` é local e ignorado pelo git; copie `.env.example`, que tem só as chaves, e preencha com valores de desenvolvimento compatíveis com o `docker-compose.yml`. `requireEnv` falha cedo se faltar variável.
- A migration roda em transação única; `down` apaga todos os dados do schema (esperado em dev; **nunca** rodar contra dados reais).
- O banco de testes acumula linhas entre execuções (UUIDs aleatórios, sem colisão). Isolamento por banco/schema fica para quando a suíte crescer.

---

#### Fase 1 — Domínio e wallet

**Objetivo.** Modelar o núcleo de domínio (`Money`, `Wallet`, `LedgerEntry`, `WagerTransaction`) sem dependência de framework ou ORM,
montar as camadas descritas abaixo e entregar `POST /wallets`, `GET /wallets/:walletId` e `GET /wallets/:walletId/ledger`
com o crédito de abertura (`OPENING` + `CREDIT`) gravado de forma atômica com a wallet.

##### Estrutura

```
src/domain/          Money · Wallet · LedgerEntry · WagerTransaction · FailureCode · erros   (TypeScript puro)
src/application/     CreateWallet · GetWallet · ListLedger · portas (repositórios, UnitOfWork) · cursor · hash de payload
src/infrastructure/  entidades MikroORM · mappers · repositórios · MikroOrmUnitOfWork · retry transitório
src/interface/http/  controller · DTOs (zod) · mapeamento de erros · filtro global
```

As dependências apontam para dentro. Os casos de uso são classes comuns que recebem as portas no construtor; só `app.module.ts`
conhece o Nest e faz a composição. O domínio não importa Nest, MikroORM, zod nem `node:crypto`.

##### Decisões

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

**3. `WagerTransaction` e a máquina de estados** (tabela completa em "Máquina de estados de WagerTransaction").

```
PENDING ──> PROCESSED                                          (terminal)
        ├─> REJECTED (failureCode)                             (terminal)
        ├─> PENDING_REFERENCE ──> PROCESSED | REJECTED | FAILED   (reagendar mantém o estado)
        └─> FAILED (failureCode)                               (terminal)
```

A transação nasce `PENDING` no domínio e é gravada já no estado em que a decisão a deixou; o trigger `wager_transactions_guard` repete no banco a imutabilidade dos terminais. As transições são `markProcessed`, `markPendingReference`,
`reject`, `fail`. `PROCESSED`, `REJECTED` e `FAILED` são terminais e qualquer transição a partir deles lança
`InvalidTransactionStateError` (erro de programação, não caminho de negócio). `PENDING_REFERENCE` aceita reagendamento (soma
`attempts`) e nunca volta a `PENDING`. Todas as transições recebem o instante `at` como argumento, o que mantém o domínio
determinístico e testável. `reject` só aceita códigos de rejeição e `fail` só `INTERNAL_PERMANENT_ERROR`, espelhando o CHECK
`wt_failure_code_iff_failed`. `create` valida a exigência de referência por tipo (mesma regra do CHECK `wt_reference_by_kind`) e
`markProcessed` de uma reversão exige `referenceTransactionId` (CHECK `wt_reversal_has_reference`). `ledgerDirectionFor` encapsula
a direção: BET debita; WIN e OPENING creditam; reverter BET credita; reverter WIN ou REFUND debita; LOSS não move saldo.
Nesta fase só o caminho `OPENING` é exercitado de ponta a ponta; o restante é coberto por testes de unidade e passou a ser usado na Fase 2.

**4. Unit-of-work e ordem de escrita.** `UnitOfWork.run` abre uma transação SQL sobre um fork novo do `EntityManager` e entrega
repositórios ligados a ela; `read` faz o mesmo sem transação. Cada `add` faz `flush` imediato, de modo que os `INSERT` saem na ordem
em que o caso de uso os chama (**wallet → transação → ledger**, a ordem global do projeto) e não na ordem que o ORM escolheria
num flush final. `persistence.test.ts` registra o SQL emitido e afirma essa ordem. Na criação não há `SELECT ... FOR UPDATE` a fazer:
a linha da wallet é nova e invisível para os demais até o commit, e a duplicidade é decidida pelo `UNIQUE (player_id, currency)`.
Alternativa descartada: persistir tudo e deixar um único `flush` no fim (ordem de INSERT delegada ao ORM, o que fere a regra de locks).

**5. `POST /wallets` atômico.** Wallet, transação `OPENING` (`provider_id = 'internal'`, `external_transaction_id = idempotency_key =
opening:{walletId}`, já `PROCESSED` com `observed_balance`) e lançamento `CREDIT` entram na mesma transação SQL. O `payload_hash`
usa o mesmo JSON canônico (chaves ordenadas recursivamente + SHA-256) usado nas transações de apostas. O banco confere a
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
Ids são `z.uuid()`, normalizados para minúsculas (interpretação 19): id malformado devolve `400` e nunca chega ao Postgres (que responderia `22P02` e viraria 500).
Alternativa descartada: `class-validator` (decorators e segunda definição das regras de dinheiro).

**8. Mapeamento HTTP.** Um único `toHttpError` puro, aplicado por um filtro global; o provedor decide reenviar (`503`), corrigir (`400`/`409`) ou desistir (`422`) pelo status e pelo `code`, sem interpretar mensagem.
A tabela é a atual (os status de transação entraram nas fases 2 e 3):

| Situação | HTTP | `code` ou corpo |
| --- | --- | --- |
| Transação processada (1ª vez e replay) | `201` | `{ transactionId, status, balance, idempotentReplay }` |
| Rejeição de negócio (1ª vez e replay) | `422` | idem, com `failureCode` |
| Aguardando referência | `202` | idem, `status: PENDING_REFERENCE` |
| Entrada inválida | `400` | `VALIDATION_ERROR`, `INVALID_CURSOR`, `BAD_REQUEST` |
| Recurso inexistente | `404` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `NOT_FOUND` |
| Conflito | `409` | `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| Falha transitória de infraestrutura | `503` + `Retry-After` | `SERVICE_UNAVAILABLE` (pode reenviar) |
| Erro nosso | `500` | `INTERNAL_ERROR` genérico, sem vazar mensagem, stack ou string de conexão |

Corpo de erro sempre `{ code, message, details? }`. Erros de domínio inesperados (por exemplo, `InvalidMoneyError` fora do DTO) são tratados como bug: `500`.

**9. Erros transitórios.** `MikroOrmUnitOfWork` reexecuta o trabalho em `40P01`, `40001` e falhas de conexão (3 tentativas, backoff
exponencial com jitter total, base 20 ms). Esgotado, lança `TransientInfrastructureError` → `503`. Erros permanentes passam intactos.
Contrato: o callback de `run` não pode ter efeito fora do banco, pois pode ser reexecutado.

**10. Regra de lint contra `number` para dinheiro (falha eliminatória no enunciado).** Em `src/**`, `no-restricted-syntax` bloqueia `parseFloat`,
`Number.parseFloat`, `Number(...)`, `+x` unário, `Math.round` e `.toFixed`, além de qualquer propriedade, parâmetro ou variável
cujo nome contenha `amount`, `balance`, `cents` ou `money` anotada como `number`. `test/unit/money-lint.test.ts` executa o ESLint
sobre trechos de código e prova que a regra barra e que não barra usos legítimos (contagens, `parseInt` de paginação).
Limitação: a regra é sintática e baseada em nomes, não em tipos; um valor monetário em variável de nome neutro anotada como `number`
não seria pego. A defesa de fundo é estrutural: o único tipo de dinheiro do domínio é `Money`, e as bordas só trocam strings decimais.

##### Verificação

| Camada | Arquivos | Prova |
| --- | --- | --- |
| Unidade | `test/unit/*` | `Money` (escala, >2 casas, entradas inválidas, moedas, limites de `NUMERIC(19,2)`), `Wallet` (saldo nunca negativo, `version`, cadeia dos lançamentos), `LedgerEntry` (aritmética, imutabilidade), `WagerTransaction` (todas as transições e terminais), cursor, hash, mappers, retry, mapeamento HTTP, regra de lint |
| Integração (Postgres real) | `persistence`, `wallets-http`, `create-wallet-atomicity`, `lock-mode` | `OPENING` atômico; falha injetada no ledger não deixa wallet nem transação; ordem dos INSERTs; status HTTP e matriz de validação; paginação sem repetição nem omissão; comportamento de `LockMode` do ORM |
| Concorrência | `test/concurrency/create-wallet.test.ts` | 50 criações da mesma wallet; 50 wallets distintas em paralelo; em ambos `wallet.balance == saldo reconstruído pelo ledger` |

Nenhum teste de integração ou de concorrência mocka PostgreSQL. A falha do teste de atomicidade é injetada trocando o método `add`
do repositório do ledger; o banco continua real.

##### Limitações e pontos em aberto

- `POST /wallets` não é idempotente por chave: repetir a mesma requisição devolve `409`, não a wallet original (o enunciado trata a wallet duplicada como conflito).
- Os ids de wallet são UUID v4 gerados no servidor; o exemplo do enunciado usa v7. Sem impacto funcional.
- `limit` acima do teto é reduzido silenciosamente em vez de rejeitado.
- O log de erros 5xx era mínimo nesta fase (tipo, mensagem e stack, nunca o corpo). **Superado na Fase 6**: JSON único com `correlationId` e sem a mensagem de erros do driver (ver "Logs").
- Leituras (`GET`) não travam a wallet: devolvem o último estado commitado, o que é o esperado para consulta.
- O banco de testes acumula linhas entre execuções (UUIDs aleatórios; sem colisão).
- Lock da wallet (`FOR UPDATE` do ORM ou `FOR NO KEY UPDATE` em SQL): decidido na Fase 2.

---

#### Fase 2 — BET/WIN/LOSS por HTTP, idempotência e lock

**Objetivo.** Processar `BET`, `WIN` e `LOSS` por `POST /wagering/transactions`, com idempotência decidida pelo banco e exclusão mútua por wallet,
e expor as consultas `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
Um único `ProcessWagerTransactionUseCase` concentra a regra; o controller só traduz entrada e saída (a Fase 4 reutiliza o mesmo caso de uso para SQS).

##### Fluxo

```
0. Validação na borda (zod + Money): Idempotency-Key obrigatória; kind em {BET, WIN, LOSS}; amount > 0, no máximo 2 casas
1. payloadHash = SHA-256 do JSON canônico dos campos de negócio
2. Fast-path SEM lock: SELECT por idempotency_key
     existe: mesmo hash -> REPLAY (mesmo status HTTP e corpo, idempotentReplay=true) | hash diferente -> 409 IDEMPOTENCY_CONFLICT
     (entrada SQS: o replay ainda passa pelo inbox numa transação curta, ver "Fase 4")
3. BEGIN
4. lockWallet:  SELECT id FROM wallets WHERE id = ? FOR NO KEY UPDATE     <- primeira instrução que toca a wallet
     inexistente -> ROLLBACK, 404 WALLET_NOT_FOUND, nada gravado
5. Decisão em memória (domínio, settleWager): a transação nasce PENDING e termina PROCESSED ou REJECTED(code), com observed_balance
6. INSERT wager_transactions ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id        <- gravada UMA vez, já no estado final
     sem linha retornada: a chave já existia -> relê o vencedor: mesmo hash -> REPLAY | diferente -> 409
     violação de wt_external_id_uq (mesmo provedor+id externo, outra chave) -> 23505 -> 409
7. Se o saldo mudou (BET/WIN processadas): UPDATE wallets (balance, version+1) -> INSERT wallet_ledger_entries
8. COMMIT; só então responde
```

Ordem global de locks e escritas: **wallet → transação → ledger → outbox** (o outbox entra na Fase 5, como último passo). `test/integration/process-wager-lock-order.test.ts`
lê o SQL emitido ao Postgres real e afirma: `begin`, depois o lock da wallet como 1ª instrução, depois `insert` da transação (um só, nenhum `update` de `wager_transactions`),
`update wallets`, `insert` do ledger e `commit`; em rejeição e em `LOSS` não há `update` de wallet nem ledger.

##### Decisões

**1. Lock: `FOR NO KEY UPDATE` em SQL, isolado em `WalletRepository.lockWallet`.**
É o único ponto do código que trava wallet. O método trava com `select id ... for no key update` e, em seguida, relê a wallet pelo ORM: em `READ COMMITTED`
a leitura seguinte já enxerga o commit de quem segurava o lock, e ninguém altera a linha até o fim da transação. (A leitura crua do driver devolve `timestamptz` como
string; reler pelo ORM reaproveita o mapper e as conversões de tipo.) `saveBalance` só é chamado depois, na mesma transação.

| Alternativa | Por que não |
| --- | --- |
| `LockMode.PESSIMISTIC_WRITE` do MikroORM (`FOR UPDATE`) | Funciona se for a 1ª instrução (provado na Fase 0), mas `FOR UPDATE` conflita com `FOR KEY SHARE`, o lock que o Postgres toma na linha referenciada por FK quando outra transação insere em `wager_transactions` ou no ledger. `FOR NO KEY UPDATE` serializa os escritores da wallet do mesmo jeito e deixa passar essas checagens de FK. É também o modo que o trigger do ledger usa, então não há promoção de lock dentro da transação. |
| Otimista (`version` + retry) | Sob 50 requisições na mesma wallet vira tempestade de retries; as regras multi-passo da Fase 3 (achar a referência, checar reversão, checar saldo) pedem um estado estável. |
| `UPDATE wallets SET balance = balance - x WHERE balance >= x` atômico | Resolve só o caso de um passo; BET/WIN/LOSS e as reversões da Fase 3 usariam mecanismos diferentes. Um único padrão de lock mantém o raciocínio uniforme. |

Custo assumido: escritas na **mesma wallet** são serializadas, então uma wallet muito quente tem o throughput limitado pelo tempo de uma transação (lock, 1 insert, 1 update, 1 insert, commit, sem I/O de rede externa dentro dela).
Wallets distintas não se bloqueiam (cenário #3). O modo do lock reduz deadlocks se alguém errar a ordem (Fase 0: com a ordem errada, `FOR UPDATE` deu 86–87 deadlocks e `FOR NO KEY UPDATE` 0 nesta máquina),
mas a **ordem** é a regra: a corretude não depende do modo. A vantagem prática de `FOR NO KEY UPDATE` sobre `FOR UPDATE` neste fluxo **não foi medida**; a escolha se apoia na compatibilidade de modos descrita acima.

**SQL "parametrizado" no MikroORM.** `em.execute(sql, params)` com marcadores `?` **não** envia parâmetros ao servidor: o MikroORM interpola e escapa os valores no cliente
(`AbstractSqlConnection.prepareQuery` chamando `platform.formatQuery`, verificado no código instalado). É seguro contra injeção enquanto os valores passam por `params` (nunca concatenados),
e isso é testado: um id malicioso é recusado pelo banco como uuid inválido e textos com aspas, barra invertida, `?` e `$1` são gravados literalmente (`wager-repositories.test.ts`).
Bind real (`$1`) exigiria o `sql` do Kysely, hoje dependência transitiva do MikroORM; não adotamos para não declarar uma dependência nova só para isso.

**2. Idempotência só no banco.** Três camadas, nenhuma depende de memória do processo:
(a) fast-path por `idempotency_key` sem lock, só para não disputar a wallet em replays; (b) `UNIQUE (idempotency_key)` decide a corrida via `ON CONFLICT DO NOTHING`;
(c) `UNIQUE (provider_id, external_transaction_id)` barra a mesma identidade do provedor com outra chave (`23505` vira `IdempotencyConflictError` e 409).
Replay e conflito são separados por `payloadHash`.

`payloadHash` = SHA-256 (hex) do **JSON canônico** (chaves ordenadas recursivamente, sem espaços) de
`{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money: {amount, currency}}`.
`amount` já vem normalizado com 2 casas por `Money.toProps()`. A `Idempotency-Key` e metadados de transporte ficam fora. O algoritmo tem teste com vetor fixo calculado fora do código (`payload-hash.test.ts`).
`referenceExternalTransactionId` não entrava no hash na Fase 2, porque era rejeitado; a Fase 3 o inclui quando presente (ver "Fase 3").

Corridas da mesma chave: na **mesma wallet**, o lock as serializa e a 2ª encontra a chave já commitada (replay). Em **wallets diferentes**, o índice único faz a 2ª inserção esperar o commit da 1ª,
retornar sem linha e reler: o hash difere (a wallet está no hash), então 409; coberto em `process-wager-transaction.test.ts`. Não há deadlock: quem espera no índice só segura a própria wallet, e quem o segura não precisa dela.

**3. Transação gravada uma vez, no estado final.** A decisão (`settleWager`, domínio puro) acontece em memória, com a wallet travada; o `INSERT` já leva `status`, `failure_code`, `observed_balance` e `processed_at`.
Nunca existe linha `PENDING` visível, não há `UPDATE` posterior (o trigger `wager_transactions_guard` já tornaria terminais imutáveis) e o replay devolve o saldo da época sem recalcular.
Rejeições de negócio (`INSUFFICIENT_BALANCE`, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`) são gravadas, portanto auditáveis, e não geram ledger nem mudam `version`.
Wallet inexistente é a única entrada sem registro: não há wallet para ancorar a FK, então 404 e nada persistido.

**4. Erros transitórios.** `40P01`, `40001` e falhas de conexão reexecutam o trabalho (3 tentativas, backoff com jitter, `MikroOrmUnitOfWork`); esgotado, 503 com `Retry-After`.
O callback de `uow.run` é reexecutável porque não tem efeito fora do banco (os ids são gerados a cada tentativa).

##### Interpretações adotadas nesta fase

- `amount > 0` sempre (o enunciado proíbe negativos; recusar zero é decisão nossa): zero e negativo são 400 na borda. Mais de 2 casas é 400 antes de tocar o banco.
- Precedência das rejeições: `PLAYER_MISMATCH`, depois `CURRENCY_MISMATCH`, depois `INSUFFICIENT_BALANCE`. `LOSS` não é rejeitada por saldo (não debita).
- `balance` na resposta é o `observed_balance`: saldo após a operação em `PROCESSED`, saldo visto na decisão em `REJECTED`. Replay devolve o mesmo valor, o saldo observado na época, mesmo que a wallet já tenha mudado.
- Replay de `REJECTED` devolve 422 e o mesmo `failureCode`; replay de `PROCESSED`, 201. Mapeamento HTTP: 201 processada, 422 rejeitada (e `FAILED`, ainda inalcançável), 202 aguardando referência (Fase 3).
- A `Idempotency-Key` é obrigatória (1 a 255 caracteres). O formato `{providerId}:{externalTransactionId}` é a recomendação do enunciado, não uma exigência: o valor enviado é a fonte da verdade.
- **Na Fase 2, 400:** `kind` `OPENING` (interno), `REFUND` e `ROLLBACK`, e qualquer `referenceExternalTransactionId`, para não aceitar o campo sem resolvê-lo. **Superado na Fase 3**: `REFUND`, `ROLLBACK` e a referência são aceitos e resolvidos; `OPENING` continua `400`.
- O cabeçalho é validado no controller porque o Nest não aplica pipes a `@Headers`; o corpo e os parâmetros usam `ZodValidationPipe`.

##### Verificação

| Camada | Arquivos | O que prova |
| --- | --- | --- |
| Unidade | `wager-settlement`, `wagering-dto`, `payload-hash`, `error-mapper` | Regras por operação (BET, WIN, LOSS; insuficiente, moeda, player, precedência; REFUND/ROLLBACK/OPENING não liquidam); borda HTTP; hash |
| Integração (Postgres real) | `wager-repositories`, `process-wager-transaction`, `process-wager-lock-order`, `process-wager-atomicity`, `wagering-http` | Regras com o banco, replay e conflitos, lock como 1ª instrução e ordem dos `INSERT`, atomicidade com falha injetada em 3 pontos (nada persiste e o mesmo comando depois funciona), status e corpos HTTP |
| Concorrência (Postgres real) | `wager-transactions`, `wager-multiprocess` | #1 mesma BET x50: 1 débito e 49 replays com o mesmo corpo. #2 duas BETs de 80,00 em 100,00 (10 rodadas): 1 `PROCESSED`, 1 `REJECTED`, saldo 20,00. 30 BETs de 10,00 em 100,00: 10 processadas, saldo 0,00. #3 50 wallets x (BET+WIN+LOSS) em paralelo, todas 201. #4 três processos reais, cada um com instância e pool próprios |

Invariante final em todos: `wallet.balance == saldo reconstruído pelo ledger`. Nenhum teste mocka PostgreSQL; a falha do teste de atomicidade é injetada trocando um método de repositório, com o banco real.
Controle negativo: trocando `lockWallet` por uma leitura sem lock, 4 dos 5 testes de concorrência e 4 dos 6 de ordem de lock falham (o #1 continua passando, porque a duplicidade é barrada pelo `UNIQUE`; o lock protege o saldo, não a chave).

##### Limitações e pontos em aberto

- Wallet muito quente serializa, e requisições aguardando o lock seguram uma conexão do pool do driver. Sob carga muito maior que o pool, o limite efetivo é o pool; medir e dimensionar fica para o teste de carga (bônus). **A Fase 3 acrescentou `lock_timeout`** (espera por lock vencida vira `503`); `statement_timeout` continua sem configuração.
- `em.execute` interpola no cliente (ver acima). Na Fase 2, um `WIN` que levaria o saldo acima do limite de `NUMERIC(19,2)` virava `500`. **Corrigido na Fase 3**: `REJECTED/BALANCE_LIMIT_EXCEEDED` (422).
- O `providerId` `internal` não é reservado; só colidiria com identidades `opening:{walletId}`, e o `UNIQUE` já barra a colisão.
- **Resolvido na Fase 5**: os eventos entram no outbox como último passo da mesma transação e um publisher separado os envia depois do commit (ver "Fase 5").
- Métricas de conflito de lock e de duração (`wager_lock_conflicts_total`, `wager_wallet_lock_wait_seconds`) e logs estruturados com `correlationId` **entraram na Fase 6** (ver "Métricas" e "Logs").

---

#### Fase 3 — REFUND, ROLLBACK, PENDING_REFERENCE e worker

**Objetivo.** Aceitar `REFUND` e `ROLLBACK` em `POST /wagering/transactions`, resolver a referência a transações anteriores, tratar referência
ausente como `PENDING_REFERENCE` e reprocessá-la por um worker agendado, mantendo a invariante `wallet.balance == saldo do ledger` com N instâncias.
O mesmo `ProcessWagerTransactionUseCase` serve a submissão; o worker usa a **mesma** função de liquidação (`settleLocked` → `settleWager`), então há uma só regra.

##### Fluxo

```
Submissão (HTTP; SQS na Fase 4)                         Worker (runOnce)
1. fast-path por idempotency_key (replay/409)           1. CLAIM (transação curta, sem wallet):
2. BEGIN; set_config('lock_timeout', '3000ms', true)       WITH due AS (SELECT ... WHERE status='PENDING_REFERENCE'
3. LOCK wallet (FOR NO KEY UPDATE)  <- 1ª instrução          AND next_attempt_at <= now ORDER BY next_attempt_at
4. settleLocked: lê a referência por                         LIMIT n FOR UPDATE SKIP LOCKED)
   (providerId, referenceExternalTransactionId)             UPDATE ... SET next_attempt_at = now + lease RETURNING id, wallet_id
   e se já existe reversão efetiva; domínio decide      2. por transação: BEGIN; lock_timeout
5. INSERT da transação, já no estado final              3. LOCK wallet (FOR NO KEY UPDATE)   <- wallet primeiro
   (PROCESSED | REJECTED | PENDING_REFERENCE)           4. relê a transação; se não é PENDING_REFERENCE, pula
6. se mudou saldo: UPDATE wallets -> INSERT ledger      5. settleLocked (mesma regra da submissão)
7. COMMIT; responde 201 | 422 | 202                     6. UPDATE da transação -> UPDATE wallets -> INSERT ledger; COMMIT
```

Ordem global de locks mantida: **wallet → transação → ledger → outbox**. O claim não toca a wallet e termina antes do reprocesso, então não participa da ordem.
`pending-reference-lock-order.test.ts` lê o SQL emitido e afirma: o reprocesso é `begin`, `set_config`, **lock da wallet**, `update` da transação, `update` da wallet, `insert` do ledger, `commit`;
a transação só é relida **depois** do lock; o claim usa `FOR UPDATE SKIP LOCKED` e não menciona wallet nem ledger.

##### Regras de reversão e códigos de falha

A primeira violação decide, nesta ordem (testada em `wager-settlement-reversal.test.ts`):

| # | Verificação | Falha | Teste de ponta a ponta |
| --- | --- | --- | --- |
| 1 | `playerId` ≠ dono da wallet; moeda ≠ moeda da wallet | `PLAYER_MISMATCH`, `CURRENCY_MISMATCH` | `reversals-http` (regra 2) |
| 2 | Referência ausente **ou ela própria `PENDING_REFERENCE`** | espera (`202`); esgotado, `REFERENCE_NOT_FOUND` | regra 8; `pending-reference-worker` |
| 3 | Referência de outro player, wallet, rodada ou moeda | `REFERENCE_MISMATCH` | regra 2 |
| 4 | Tipo não referenciável: `REFUND` só `BET`; `ROLLBACK` `BET`/`WIN`/`REFUND` (inclui `ROLLBACK` de `ROLLBACK`) | `INVALID_REFERENCE_KIND` | regra 3 |
| 5 | Referência `REJECTED` ou `FAILED` | `REFERENCE_NOT_PROCESSED` | regra 3 |
| 6 | Valor ≠ valor da referência (sem reversão parcial) | `AMOUNT_MISMATCH` | regra 5 |
| 7 | Já existe reversão **efetiva** da referência | `ALREADY_REVERSED` | regra 4 |
| 8 | Débito sem saldo (`ROLLBACK` de `WIN`/`REFUND`) | `REVERSAL_WOULD_OVERDRAW` (≠ `INSUFFICIENT_BALANCE`) | regra 9 |
| 9 | Crédito acima de `NUMERIC(19,2)` | `BALANCE_LIMIT_EXCEEDED` | regra 9 |

A referência é resolvida por `(providerId, referenceExternalTransactionId)`: o mesmo id externo em **outro** provedor não é a referência (a reversão fica `PENDING_REFERENCE`).
`ROLLBACK` é o inverso da referência: reverter `BET` credita; reverter `WIN` ou `REFUND` debita (`ledgerDirectionFor`).
Toda rejeição é gravada (auditável), não altera saldo nem `version` e não gera ledger; replay devolve o mesmo 422 e o mesmo `failureCode`.
HTTP: `201` processada, `202` `PENDING_REFERENCE`, `422` rejeição, tanto na 1ª vez quanto no replay (que acrescenta `idempotentReplay: true`).

A taxonomia completa, com HTTP e ação do provedor, está em [Códigos de falha](#códigos-de-falha).

##### Interpretação: "uma reversão efetiva por transação referenciada"

O enunciado (regra de reversão única) diz que uma referência não pode ser revertida duas vezes "pelo mesmo tipo de operação". Lida ao pé da letra, permitiria `REFUND` **e** `ROLLBACK` da mesma `BET`,
creditando o valor em dobro. Adotamos a leitura que preserva a invariante financeira: **no máximo uma reversão efetiva (`REFUND` ou `ROLLBACK` `PROCESSED`) por transação referenciada**.
Uma reversão `REJECTED` não conta (o provedor pode corrigir e reenviar). Consequência assumida: se uma `BET` foi revertida por um `REFUND` e esse `REFUND` foi depois desfeito por um `ROLLBACK`,
a `BET` continua tendo uma reversão efetiva e **não pode** ser revertida de novo; a operação corretiva é de suporte, não do fluxo normal.

A garantia tem duas camadas independentes: a verificação sob o lock da wallet (`hasEffectiveReversal`, que devolve `ALREADY_REVERSED` limpo) e o **índice único parcial**
`wt_one_effective_reversal_uq` no schema, que barra o crédito duplicado mesmo que a aplicação erre.

##### Outras interpretações desta fase

- `WIN`/`LOSS` com `referenceExternalTransactionId` opcional: a referência só pode ser uma `BET` (`INVALID_REFERENCE_KIND` caso contrário), `PROCESSED` e da mesma identidade; o valor **não** precisa coincidir (um prêmio não é igual à aposta). O campo entra no `payloadHash` quando presente; ausente, a chave some do JSON canônico e os hashes gravados antes continuam válidos (há vetor fixo de teste para os dois casos).
- Referência que existe mas ainda está `PENDING_REFERENCE` (por exemplo `ROLLBACK` de uma `WIN` que espera a `BET`): a reversão espera também. Rejeitar aí puniria o provedor por uma desordem que o próprio worker vai resolver.
- `referenceExternalTransactionId` igual ao próprio `externalTransactionId`: `400` na borda (espelha o CHECK `wt_not_self_reference`); em `BET`, `400`; em `REFUND`/`ROLLBACK`, ausente, `400`.
- Replay de uma transação que estava `PENDING_REFERENCE` devolve o **estado atual** da transação: `202` enquanto pendente; depois de resolvida, `201`/`422` com o `balance` observado na resolução (o enunciado não fixa esse caso).
- Reversão cuja referência está em **outra wallet** do mesmo provedor é `REFERENCE_MISMATCH`: lemos a referência sem lock, o que é seguro porque só importam campos imutáveis para decidir o mismatch.
- A referência da **mesma** wallet é lida sem `FOR UPDATE` porque só muda sob o lock desta wallet, que já seguramos.
- **`BALANCE_LIMIT_EXCEEDED` cobre o crédito acima do máximo de `NUMERIC(19,2)`.** Antes, `WIN`/`REFUND`/`ROLLBACK` nesse caso viravam `500`, e um provedor não deve provocar `500` com valor válido. Agora é `REJECTED`/`422`, sem ledger, auditável, e o replay devolve o mesmo resultado. Ação do provedor: não reenviar; a operação escala. Não exige mudança de schema (`failure_code` é `text`). `MoneyOverflowError` distingue o estouro de um valor inválido.

##### PENDING_REFERENCE e o worker

**Estado.** Referência ausente grava a transação como `PENDING_REFERENCE` (sem tocar saldo nem ledger), `attempts = 1`, `next_attempt_at = agora + 1s (+ jitter)`, e responde `202`.
`attempts` conta as avaliações sem sucesso, incluindo a da submissão. A transição `PENDING_REFERENCE → PENDING` é impossível em duas camadas: o trigger `wager_transactions_guard` e o domínio
(`PENDING` só existe em `WagerTransaction.create`; não há método que o reponha; `wager-transaction.test.ts` percorre todas as transições a partir de `PENDING_REFERENCE`).

**Claim por lease.** `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n) RETURNING` empurra `next_attempt_at` para `agora + 30s`. Dois workers recebem lotes disjuntos
(`SKIP LOCKED`); a transação reivindicada some do filtro até o lease vencer, então ninguém a pega em dobro. Se o worker morrer, ela volta a ser elegível quando o lease vencer
(teste `o claim agenda a transação para depois do lease`). O processamento roda **fora** do claim, como transação normal: não segura conexão nem lock durante o trabalho de outro.
Defesa em profundidade se dois workers chegarem à mesma transação: o lock da wallet serializa; se o 1º a resolveu, o 2º relê, vê que não é mais `PENDING_REFERENCE` (`skipped`), e o trigger barra qualquer UPDATE em terminal (se continuou pendente, ver "Limitações").

**Limite e backoff (estimativa).** 1 avaliação inicial + **8 reprocessamentos**; a espera antes do reprocesso `n` é `min(60s, 1s · 2ⁿ⁻¹)` mais jitter uniforme de 0 a +50%:

| Após a avaliação nº | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Espera até a próxima (sem jitter) | 1s | 2s | 4s | 8s | 16s | 32s | 60s (teto) | 60s |

A 9ª avaliação, se ainda sem referência, grava `REJECTED/REFERENCE_NOT_FOUND` (com o saldo observado). Total sem jitter: **183 s**; com jitter, de 3 a ~4,5 min.
Justificativa (premissa não medida): supomos que a desordem entre `BET` e reversão seja de milissegundos a poucos segundos (reenvio do provedor, atraso de fila), caso em que as primeiras esperas curtas resolvem quase de imediato;
o teto de 60 s limita a carga do polling a no máximo uma reavaliação por minuto por transação parada; o jitter espalha reprocessos que nasceram juntos (uma rajada pós-incidente) para não voltarem todos no mesmo instante;
alguns minutos cobrem atraso de fila e um ciclo de retry do provedor sem manter uma transação indefinidamente em aberto. Os números são estimativas, não medições: constantes em `src/domain/reference-retry-policy.ts` (não são configuráveis em runtime).
Custo assumido: uma referência que chegue depois desse prazo leva à rejeição e o provedor precisa enviar a referência e uma **nova** reversão (a antiga é terminal e não é retomada).
A referência que aparece na última tentativa ainda resolve: o limite só rejeita quando a avaliação continua sem referência.

**Execução.** `ReprocessPendingReferencesUseCase.runOnce()` é uma passada testável (devolve `{claimed, processed, rejected, rescheduled, skipped, failed}`); um `PollingWorker` (classe compartilhada com o publisher desde a Fase 5) agenda passadas
(1 s entre passadas, lote de 20, repete sem esperar se o lote veio cheio) e **nunca sobrepõe** passadas na mesma instância. Sobe no `main.ts` (todas as instâncias rodam o loop; o claim divide o trabalho sem coordenação)
e para no shutdown: `AppModule.beforeApplicationShutdown` chama `stop()`, que espera a passada em andamento terminar antes de o ORM fechar. Os testes sobem o módulo **sem** o loop, para controlarem o tempo com um relógio injetado.
Uma falha em uma transação não derruba o lote: vai para `onError` (log JSON com ids e nome/mensagem do erro, sem payload), conta em `failed` e a transação fica `PENDING_REFERENCE`, elegível de novo quando o lease vencer.
`onError` é parâmetro obrigatório do caso de uso e do loop, para que nenhuma falha seja engolida por omissão.

##### Ajustes da Fase 2 incorporados

**`lock_timeout` (substitui a limitação da Fase 2).** Cada transação do `UnitOfWork.run` começa com `select set_config('lock_timeout', '3000ms', true)`, o equivalente parametrizável de `SET LOCAL`:
vale só naquela transação e não vaza para a conexão devolvida ao pool (teste com pool de 1 conexão). Roda **antes** do lock da wallet e não toca tabela, então a ordem de locks é a mesma.
Estourar o prazo é o SQLSTATE `55P03`, tratado como transitório: o `UnitOfWork` reexecuta (3 tentativas, jitter) e, esgotado, responde `503` + `Retry-After: 1`; o provedor pode reenviar a mesma chave.
**Por que 3 s:** o lock da wallet dura uma transação curta (lock, 1 insert, 1 update, 1 insert, commit: dezenas de milissegundos, sem I/O de rede dentro dela), então 3 s é ~100 vezes a espera normal:
se estourou, há transação travada, não fila. Com 3 tentativas o pior caso é ~9 s, abaixo de um timeout típico de gateway (10 s), de modo que o provedor recebe um `503` em vez de uma conexão pendurada ocupando o pool.
É uma estimativa, não uma medição; ajustável por `LOCK_TIMEOUT_MS`. Uma wallet muito quente com fila maior que 3 s de trabalho veria `503`s, comportamento desejado (contrapressão), mas o dimensionamento fica para o teste de carga.
Teste: outra conexão segura o lock da wallet; a submissão falha com `TransientInfrastructureError` (causa `55P03`) em ≥ `lock_timeout` e < 5 s, nada persiste, e o reenvio depois de liberado dá `201`; pela API, `503` com `Retry-After`.

**`walletId` validado antes de chegar ao lock.** O corpo usa `uuidSchema` (`z.uuid()` em minúsculas) para `walletId` e `playerId` e o controller só chama o caso de uso com o corpo já validado. `walletId` malformado
(`nao-e-uuid`, truncado, com SQL anexado) é `400 VALIDATION_ERROR` e nada é gravado: o Postgres nunca vê o valor (sem `22P02` virando `500`). Teste: `wagering-http.test.ts`.
A mensagem do SQS é validada com os mesmos campos e regras (Fase 4).

##### Verificação

| Camada | Arquivos | O que prova |
| --- | --- | --- |
| Unidade | `reference-retry-policy`, `wager-settlement-reversal`, `wager-settlement`, `wager-transaction`, `wagering-dto`, `payload-hash`, `polling-worker` | Cada regra e cada código, a precedência, os efeitos no saldo, o backoff e o limite, a máquina de estados, o DTO, o hash com e sem referência, o loop (start/stop, erro, lote cheio) |
| Integração (Postgres real) | `reversals-http`, `pending-reference-worker`, `pending-reference-lock-order`, `pending-reference-claim`, `wager-repositories`, `lock-timeout`, `wagering-http` | Regras de reversão 1 a 9 do enunciado pela API; cenário #7; limite esgotado; replay de pendente e de rejeitada; lease e recuperação; falha isolada por transação; ordem de locks; `lock_timeout`; claim disjunto |
| Concorrência (Postgres real, processos reais) | `test/concurrency/reversals.test.ts` | `REFUND` e `ROLLBACK` da mesma `BET` (20 rodadas): 1 efetiva e 1 `ALREADY_REVERSED`; 25+25 reversões da mesma `BET`: 1 efetiva e 49 `ALREADY_REVERSED`; mesmo `REFUND` x50: 1 crédito, 49 replays; 3 **processos** disputando 30 pendências: 30 reivindicadas uma única vez, 30 créditos; worker e HTTP na mesma wallet |

Invariante final (`wallet.balance == saldo reconstruído pelo ledger`) em todos os cenários que mexem em saldo. Nenhum teste mocka PostgreSQL; a falha por transação do worker é injetada trocando `lockWallet` num `UnitOfWork` que ainda usa o banco real.

**Controle negativo** (em um banco descartável, para não alterar o schema compartilhado):

| Alteração | Resultado |
| --- | --- |
| `lockWallet` sem `FOR NO KEY UPDATE` | 5 dos 6 testes de `reversals.test.ts` falham. A reversão concorrente devolve `[201, 500]` em vez de `[201, 422]`: o banco impede o crédito duplicado (trigger de cadeia do ledger e índice), mas como erro, não como `ALREADY_REVERSED`. O lock é o que transforma a corrida em resultado de negócio. |
| Sem o índice `wt_one_effective_reversal_uq` (lock intacto) | `schema.test.ts` falha em "REFUND + ROLLBACK efetivos na mesma BET (crédito duplicado)"; os testes de concorrência **passam**, porque a verificação sob o lock da aplicação também segura. Por isso o índice só aparece nos testes do schema: prova que a 2ª camada existe. |
| Sem o índice **e** sem o lock | 3 dos 4 testes de reversões concorrentes falham. |

##### Limitações e pontos em aberto

- **Resolvido na Fase 5**: `PendingReference`, `Rejected`, `Processed` e `BalanceChanged` são gravados no mesmo `uow.run`, como último passo, tanto na submissão quanto no reprocesso do worker.
- O limite do worker é constante no domínio, não configurável. Medir o atraso real de referências (histograma) permitiria ajustá-lo com dados; **a Fase 6 não incluiu esse histograma** (só conta as transações resolvidas pelo worker em `wager_transactions_total`), então o ajuste continua por estimativa.
- O claim das pendências não confere posse no reprocessamento: um worker que passe do lease sem a referência ter chegado reavalia depois de outro e consome uma tentativa a mais (o limite chega antes). Não afeta saldo, que é decidido sob o lock da wallet. Visto na leitura do código; não há teste para este caso.
- O worker processa o lote em sequência. Uma wallet travada atrasa o lote por até ~9 s (3 tentativas de `lock_timeout`); a transação afetada volta após o lease, e as demais seguem. Paralelizar por wallet é possível e não foi necessário.
- Sem ordem garantida entre pendências da mesma wallet: duas reversões pendentes da mesma `BET` são avaliadas na ordem do claim (`next_attempt_at`); qualquer uma pode ser a efetiva, e a outra é `ALREADY_REVERSED`. A regra "no máximo uma" vale; qual delas vence não é especificado.
- Agendamento e lease usam o relógio da aplicação. Entre instâncias, um desvio de relógio desloca os vencimentos em segundos, o que não afeta correção (a exclusão mútua é do lock e do claim, não do relógio).
- `GET` de uma transação `PENDING_REFERENCE` devolve `balance: null` (não há saldo observado ainda).
- O log do worker (`pending_reference_settled`, com `transactionId`, `walletId`, `providerId`, `status`) e a contagem por status entraram na Fase 6; não há métrica própria do tempo de espera por referência.
- Se a referência nunca chegar, a linha vira `REJECTED` após cerca de 3 a 4,5 min (desde que os reprocessos concluam, ver "Limite do PENDING_REFERENCE"): em operação normal a tabela não acumula pendências eternas, mas o provedor precisa reagir ao `REFERENCE_NOT_FOUND`.

---

#### Fase 4 — Consumidor SQS, inbox, DLQ e shutdown

**Objetivo.** Processar `WagerTransactionRequested` vindo de `wager-transactions.fifo` com o **mesmo** `ProcessWagerTransactionUseCase` do HTTP,
correto sob duplicação, redelivery, queda de worker e várias instâncias (requisitos de processamento por SQS do enunciado).

##### Fluxo de uma mensagem

```
ReceiveMessage (long polling 20 s, lote <= 10, VisibilityTimeout configurável)
  └─ despacho por MessageGroupId (= walletId): grupos diferentes em paralelo (limite SQS_CONSUMER_CONCURRENCY); o mesmo grupo encadeado,
     e a seguinte só começa se a anterior saiu da fila (senão volta com ChangeMessageVisibility(0), sem ser processada)
       └─ WagerMessageHandler.handle(body, ApproximateReceiveCount)
            1. parseWagerMessage (zod): envelope + data. type desconhecido ou payload inválido => erro PERMANENTE
            2. ProcessWagerTransactionUseCase.execute(command, { consumerName, messageId })
                 fast-path por idempotencyKey (sem lock): a chave já existe?
                 BEGIN
                   INSERT inbox (consumer_name, message_id, payload_hash) ON CONFLICT DO NOTHING   <- mesma transação do efeito
                     já existe, mesmo hash  => COMMIT, resultado `duplicateMessage`
                     já existe, hash outro  => InboxPayloadConflictError (permanente)
                   chave já existia  => replay (hash diferente => IdempotencyConflictError e ROLLBACK). NÃO trava a wallet
                   chave nova        => lock da wallet -> transação -> saldo -> ledger -> outbox   (ordem de locks da Fase 2)
                   UPDATE inbox.processed_at
                 COMMIT
            3. devolve uma Disposition: ack | retry(delaySeconds) | dead-letter(reason)
  └─ QueueConsumer executa a Disposition:
       ack          -> DeleteMessage
       retry        -> ChangeMessageVisibility(delaySeconds); sem ack
       dead-letter  -> SendMessage à DLQ (MessageGroupId, MessageDeduplicationId, atributo FailureReason) e SÓ ENTÃO DeleteMessage
```

O `ack` acontece depois de `handle` resolver, e `handle` só resolve depois do commit. O inbox entra **antes** do lock da wallet: não toca a wallet,
então não altera a ordem `wallet → transação → ledger`, e duas entregas concorrentes da mesma mensagem se serializam no índice único do inbox.

##### Classificação de erros

| Classe | O que é | O que o consumidor faz |
| --- | --- | --- |
| **Negócio** | `PROCESSED`, `REJECTED` (ex.: `INSUFFICIENT_BALANCE`), `PENDING_REFERENCE`, replay por idempotência, duplicata do inbox | O commit já gravou o resultado: **ack**. Não vai à DLQ. |
| **Transitório** | `TransientInfrastructureError`: Postgres fora, `40P01`, `40001`, `55P03`, retry interno esgotado | **Sem ack.** `ChangeMessageVisibility` com `min(teto, base · 2^(n-1))` e jitter "equal" (entre metade e o valor inteiro), `n = ApproximateReceiveCount`. No 5º recebimento sem sucesso o **SQS** move a mensagem para a DLQ (`maxReceiveCount = 5`, redrive da fila). |
| **Permanente** | Corpo que não é JSON, envelope/`data` inválido, `type` desconhecido, `messageId` reutilizado com outro conteúdo, conflito de idempotência, wallet inexistente, erro inesperado (bug) | Envia **explicitamente** à DLQ (mesmo `MessageGroupId`, `MessageDeduplicationId` = MessageId do SQS, atributo `FailureReason`) e **depois** dá ack. |

Códigos de `FailureReason`: `MALFORMED_MESSAGE`, `UNKNOWN_MESSAGE_TYPE`, `INBOX_PAYLOAD_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `WALLET_NOT_FOUND`, `UNEXPECTED_ERROR`.

**Decisões que divergem de uma leitura literal do enunciado (e por quê):**

- **Interpretação nossa: `409` (conflito de idempotência) e wallet inexistente (`404`) são permanentes, não "negócio".** O enunciado pede ack para erros de **negócio** (terminais) vindos da fila, e um mapeamento direto dos status HTTP (`422` e também `409`) os poria nessa classe. Divergimos para a entrada SQS por uma razão objetiva: `REJECTED` é um resultado **gravado** (transação com `failureCode`, auditável e
  devolvido no replay), então o ack não perde nada; já o `409` e o `404` **não gravam nada** (nem transação, nem linha de inbox). Dar ack apagaria a mensagem sem deixar rastro, e no SQS não existe
  resposta HTTP para avisar o produtor. Por isso vão à DLQ (`IDEMPOTENCY_CONFLICT`, `WALLET_NOT_FOUND`) e só então recebem ack. Pelo HTTP o comportamento continua `409`/`404`.
  Para adotar a leitura literal, basta mover essas duas classes para `ack` em `deadLetterReasonFor`.
- **Decisão: `FAILED / INTERNAL_PERMANENT_ERROR` não é gravado no caminho SQS.** Exigiria uma wallet existente (FK) e uma segunda transação SQL dentro do tratamento de erro (que pode falhar pelo mesmo motivo que
  originou o erro). Pior, `FAILED` é terminal (trigger `wager_transactions_guard`) e ocuparia a `idempotencyKey` para sempre: corrigido o bug, o reenvio do provedor devolveria `FAILED` em vez de
  processar. Payload malformado nem tem wallet nem chave confiáveis para gravar. A trilha de auditoria desses casos é a DLQ com `FailureReason`, que permite reprocessar depois da correção.
- **Mesmo `messageId` com `payload_hash` diferente é permanente.** Uma reentrega do SQS nunca muda o corpo; se mudou, o produtor reutilizou o id e não há como saber qual conteúdo vale.
  Processar de novo seria arriscado e descartar em silêncio esconderia o erro. O `payload_hash` do inbox é o mesmo hash de negócio do `WagerTransaction` (sem a chave de idempotência, que é metadado).
- **Erro inesperado é permanente na primeira ocorrência.** Retentar um bug só repete o bug; a DLQ preserva a mensagem para reprocesso manual depois da correção.
  Custo assumido: uma falha transitória que o código não reconhece como tal vai à DLQ em vez de ser retentada. `isTransient` (`transient-retry.ts`) reconhece:
  `40P01`, `40001`, `55P03`, `57P01`, `57P02`, `57P03`, as **classes inteiras 08 (conexão) e 53 (recursos insuficientes)**, `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`EPIPE` como `code` **ou só na mensagem**,
  as mensagens do `pg-pool` sem código ("Connection terminated unexpectedly", "timeout exceeded when trying to connect") e procura tudo isso também na cadeia de `cause` (o ORM embrulha o erro do driver).

##### Inbox e idempotência são camadas diferentes

A idempotência decide **o que acontece com o dinheiro** (uma transação por chave); o inbox decide **o que significa uma `messageId`** (um único conteúdo por consumidor).
Toda mensagem confirmada por resultado do caso de uso (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay ou duplicata) tem a sua linha `(consumerName, messageId, payload_hash)` no inbox,
**inclusive quando a chave já era conhecida** (por exemplo, a mesma aposta aceita antes pelo HTTP). Consequências:

| Entrega | Resultado |
| --- | --- |
| Mesma `messageId`, mesmo conteúdo (redelivery depois do commit) | duplicata do inbox: ack |
| `messageId` nova, chave conhecida, mesmo conteúdo | replay: ack, e a nova `messageId` passa a constar no inbox |
| `messageId` já registrada, outro conteúdo (chave nova **ou** conhecida) | `INBOX_PAYLOAD_CONFLICT`: DLQ, nada é debitado |
| `messageId` nova, chave conhecida, outro conteúdo | `IDEMPOTENCY_CONFLICT`: DLQ, nada gravado (nem a linha do inbox) |

**Correção após revisão independente.** O fast-path devolvia o replay **antes** de registrar a mensagem. Um `messageId` visto só em replay ficava fora do inbox e podia voltar com outra chave e outra transação,
que era processada (reproduzido em teste: um segundo débito sob a mesma `messageId`). Agora o replay por mensagem abre uma transação curta só com `INSERT` e `UPDATE` do inbox: **sem lock de wallet**
(há teste com o lock da wallet preso por outra conexão), e a ordem de locks não muda. O custo é uma transação a mais por replay vindo do SQS; o replay HTTP continua sem escrever nada.
`processed_at` é gravado por `UPDATE` no fim da mesma transação. Entregas simultâneas da mesma mensagem se serializam no índice único (`ON CONFLICT` espera o commit da primeira).

##### Concorrência dentro do processo

`QueueConsumer` mantém `concurrency` mensagens em voo. Mensagens de **grupos diferentes** correm em paralelo; as do **mesmo grupo** são encadeadas (uma cadeia de `Promise` por `MessageGroupId`), inclusive quando o SQS
devolve várias do mesmo grupo no mesmo lote (o MiniStack devolve).

**Precedência dentro do grupo (correção após revisão independente).** Antes, a cadeia só esperava a anterior **terminar**, não **dar certo**: com saldo 0, um `WIN 100.00` que falhava de forma transitória era adiado
e a `BET 80.00` do mesmo lote era processada e **rejeitada** por saldo; o crédito chegava depois (reproduzido em teste). A regra agora é: **a seguinte só começa se a anterior saiu da fila**.

| Fim da mensagem da frente | As seguintes do grupo já recebidas |
| --- | --- |
| ack (qualquer resultado de negócio) | processadas, na ordem |
| falha permanente copiada para a DLQ **e** confirmada | processadas: a da frente não será mais aplicada |
| falha transitória (adiada) | não começam: `ChangeMessageVisibility(0)`, na ordem do lote |
| falha no ack, no `ChangeMessageVisibility` ou no envio à DLQ; handler que lança | idem |

As devolvidas continuam bloqueadas pela própria FIFO enquanto a da frente está invisível (ela é de um grupo com mensagem em voo) e são reentregues depois dela. A parada vale só para o que já estava em memória: uma entrega
posterior do grupo começa uma cadeia nova (que ainda espera a antiga terminar de devolver). Outros grupos não são afetados. A parada é local ao processo; entre processos a precedência é a do SQS FIFO.
**Não é isso que protege o dinheiro**: saldo, idempotência e `messageId` são garantidos pelo lock da wallet e pelos índices únicos no banco. Esta regra preserva a **ordem de aplicação** das mensagens, que muda o resultado de negócio.

##### Shutdown (`SIGTERM`)

`main.ts` chama `enableShutdownHooks()`; `AppModule.beforeApplicationShutdown` executa `Promise.all([consumer.stop(), worker.stop()])` e só depois `onApplicationShutdown` fecha o ORM.
`QueueConsumer.stop()`: (1) aborta o long polling e para de buscar; (2) devolve **na hora**, com `ChangeMessageVisibility(0)`, as mensagens que ainda esperavam a vez do grupo;
(3) espera as em andamento até `SHUTDOWN_TIMEOUT_MS` (25 s); (4) as que não terminaram voltam com `ChangeMessageVisibility(0)`. Mensagem devolvida que ainda termina em segundo plano não é confirmada:
se commitar, a reentrega será duplicata do inbox. `stop()` é idempotente.

##### Configuração (sem valor mágico no código)

Variáveis em `.env.example`: `SQS_WAGER_QUEUE_NAME` e `SQS_WAGER_DLQ_NAME` (obrigatórias; a URL é resolvida por `GetQueueUrl` na primeira chamada, então o HTTP sobe mesmo com o SQS fora),
`SQS_CONSUMER_CONCURRENCY` (5), `SQS_BATCH_SIZE` (10), `SQS_WAIT_TIME_SECONDS` (20), `SQS_VISIBILITY_TIMEOUT_SECONDS` (30), `SQS_RETRY_BASE_SECONDS` (5), `SQS_RETRY_MAX_SECONDS` (120), `SHUTDOWN_TIMEOUT_MS` (25000).
Os padrões são constantes nomeadas com a justificativa em `consumer-config.ts` e são validados no boot (lote > 10, espera > 20 s, teto < base derrubam o start). São estimativas, não medições:
com `maxReceiveCount = 5` o backoff soma ~1 min (5 + 10 + 20 + 40 s, sem jitter) antes da DLQ, tempo para cobrir um reinício de Postgres.

##### Teste sem hook de produção

O código de produção não tem ponto de falha injetável. O consumidor recebe a fila pela porta `MessageQueue` (adaptador `SqsMessageQueue`); os testes embrulham o **adaptador real** num decorador
(`InterceptingQueue`) que observa ou intercepta uma chamada, por exemplo fazer o `acknowledge` lançar para simular "o worker morreu depois do commit". Postgres e SQS são sempre reais.
Além disso, o cenário "morre antes do commit" usa um **processo filho real** morto com `SIGKILL` dentro da transação (esperando um lock segurado pelo teste).

##### Verificação

| Camada | Arquivos | O que prova |
| --- | --- | --- |
| Unidade | `inbox-message`, `wager-message` (zod), `visibility-backoff`, `wager-message-handler`, `consumer-config`, `app-shutdown` | Domínio do inbox; cada caso de payload malformado; backoff e teto; classificação ack/retry/DLQ; validação da config; ordem do encerramento |
| Integração (Postgres + MiniStack reais) | `process-wager-inbox`, `sqs-replay-inbox`, `sqs-group-order` (precedência no grupo: adiamento com 0 e 2 s, três mensagens, outro grupo em paralelo, falha de ack, de visibilidade, de DLQ e handler que lança, DLQ bem-sucedida que não segura o grupo, esgotamento dos 5 recebimentos), `sqs-consumer`, `sqs-app`, `send-wager-message-cli` | Inbox na mesma transação (atomicidade com falha injetada em 4 pontos, 20 entregas simultâneas); replay por mensagem registra o inbox sem travar a wallet; HTTP, depois replay por SQS, depois a mesma `messageId` com outro conteúdo vai à DLQ sem debitar; ack só após o commit; `REJECTED` com ack; duplicata, redelivery com `messageId` novo, ordem por wallet; Postgres fora (sem ack, backoff 1 s, 2 s) e 5 recebimentos até a DLQ com `MessageGroupId`; payloads inválidos, conflito e wallet inexistente na DLQ com `FailureReason`; paralelismo entre grupos com limite e serialização do grupo; shutdown devolvendo em andamento e não iniciadas; `AppModule` real; CLI produtor |
| Concorrência | `test/concurrency/sqs-consumer.test.ts` | **#5** (ack falha depois do commit: a reentrega é duplicata do inbox, 1 débito, 1 inbox, ledger íntegro; também com 4 wallets); **#5b** (processo morto por `SIGKILL` antes do commit: 0 efeitos, reentrega processa 1 vez); 2 consumidores com pools próprios disputando 144 mensagens (48 fatos, duplicatas e reenvios): exatamente 48 processamentos; wallet quente com 2 consumidores: 5 `PROCESSED` e 3 `REJECTED` na ordem de envio |

Invariante final (`wallet.balance == saldo reconstruído pelo ledger`) em todos os testes que movem saldo.

**Controles negativos** (mutação temporária no código, revertida):

| Mutação | Resultado |
| --- | --- |
| `acknowledge` antes de `handle` (ack antes do commit) | Falham `ack SOMENTE depois do commit` (a transação ainda não existia no instante do ack) e **#5b** (a mensagem é apagada, o processo morre antes do commit e nada é reprocessado); falham também os testes que dependem da mensagem permanecer na fila até o commit |
| Consumidor sem a regra de precedência (a seguinte só espera a anterior terminar) | Falham 9 dos 10 testes de `sqs-group-order`; no cenário principal a `BET` termina `REJECTED` e sobra só o crédito de 100,00. O que continua passando é o da DLQ bem-sucedida, em que seguir é o correto |
| Sem inbox (`origin` ignorado no caso de uso) | Falham 23 testes de integração e concorrência: inbox gravado, duplicata pelo inbox, `messageId` reutilizado, atomicidade do inbox, 20 entregas simultâneas, #5. A mesma **chave** continua sem débito duplicado (a idempotência segura sozinha), mas uma `messageId` reutilizada com **outra** transação passa a ser processada |
| Replay volta a retornar antes do inbox (código anterior à correção) | Falham 10 testes: `sqs-replay-inbox` (a `messageId` reutilizada debita de novo), registro do inbox no replay e a redelivery reconhecida como duplicata (#5) |

##### Limitações e o que o MiniStack não garante frente ao SQS real

- **As seguintes gastam recebimentos junto com a da frente.** Devolvidas sem processar, elas têm o `ApproximateReceiveCount` incrementado a cada lote. Se a da frente falhar nos 5 recebimentos, as que vieram no mesmo lote vão **junto** à DLQ, na ordem, sem nunca terem sido executadas (testado no MiniStack). A ordem é preservada, mas o reprocesso da DLQ precisa incluí-las. `wager_retries_total{source="queue"}` conta só a adiada, e o redrive do SQS não é contado.
- **A DLQ quebra a ordem.** Depois de uma falha permanente as seguintes são aplicadas; reenviar a mensagem da DLQ mais tarde a aplica fora da ordem original. O mesmo vale para uma da frente movida pelo redrive quando as seguintes ainda têm recebimentos sobrando.
- **Ordem não cobre `PENDING_REFERENCE` nem o HTTP.** Uma mensagem que fica pendente é confirmada, então as seguintes são aplicadas antes de ela se resolver; requisições HTTP não têm ordem em relação à fila.
- **Visibilidade vencida na espera.** Não há heartbeat: se um grupo demorar mais que o `VisibilityTimeout` para chegar numa mensagem já recebida, o SQS pode reentregá-la a outro consumidor. O saldo segue correto (banco); a ordem, nesse caso, não é garantida.
- **A precedência depende da FIFO bloquear o grupo** enquanto há mensagem em voo. Verificado só no MiniStack, não na AWS.
- **Mensagem que vai à DLQ não fica no inbox.** O inbox é gravado na transação do processamento, e a falha permanente (wallet inexistente, conflito de idempotência) faz `ROLLBACK`. A mesma `messageId` enviada depois com conteúdo válido é processada; o rastro da primeira é a DLQ, não o inbox.
- **Sem retenção do inbox**: `inbox_messages` só cresce.
- **Long polling abortado ainda vive no servidor.** No shutdown abortamos o `ReceiveMessage` no cliente, mas a espera continua do lado do servidor (observado no MiniStack; é plausível que o SQS real se comporte igual, mas isso não foi verificado): uma mensagem que chegue nesses segundos pode ficar invisível até `VisibilityTimeout` vencer e depois é reentregue. Não se perde nem se duplica efeito; só atrasa.
- **Contadores de fila.** Os testes esperam "fila vazia" por `ApproximateNumberOfMessages` / `NotVisible`. No SQS real esses contadores são aproximados e atrasados; o MiniStack os atualiza de forma imediata. Os testes não valem como estão contra a AWS.
- **Não verificado no MiniStack:** janela de 5 minutos da deduplicação FIFO (a DLQ confia nela para não duplicar o envio quando o worker morre entre o `SendMessage` e o ack); invalidação de `ReceiptHandle` antigo depois de nova entrega (por isso uma mensagem devolvida no shutdown não é confirmada depois); cotas de mensagens em voo (120 mil em FIFO); throughput por grupo; semântica de `ChangeMessageVisibility` acima do `VisibilityTimeout` restante. O redrive para a DLQ no 6º `ReceiveMessage` (5 recebimentos sem `DeleteMessage`) foi observado.
- **`VisibilityTimeout` de 30 s (padrão) por recebimento.** Um processamento mais longo que isso seria reentregue enquanto roda; o `lock_timeout` de 3 s × 3 tentativas mantém o pior caso em ~9 s. Não há heartbeat que estenda a visibilidade.
- **Mensagem devolvida no shutdown que ainda executa** pode terminar depois de `stop()` e depois do ORM fechar (se o processo continuar vivo); o resultado é seguro (commit válido ou rollback), mas gera erro nos logs. O orquestrador mata o processo logo depois.
- **Métricas e logs com ids da transação** entraram na Fase 6: `wager_dlq_messages_total` e `wager_retries_total{source="queue"}` existem; o `redrive` feito pelo próprio SQS (`maxReceiveCount`) não passa pelo consumidor e **não** é contado.
- **Wallet criada depois da primeira mensagem** é tratada como erro permanente (`WALLET_NOT_FOUND`): a wallet só nasce por HTTP, e uma mensagem que a antecede indica problema do produtor. Se a operação quiser tolerar essa corrida, basta reprocessar a DLQ.

---

#### Fase 5 — Outbox transacional, publishers e eventos de integração

**Objetivo.** Publicar os fatos do processamento (transação aplicada, rejeitada, saldo alterado, referência pendente) sem jamais publicar algo que não foi
commitado e sem perder algo que foi (requisitos de transactional outbox do enunciado). Vários publishers concorrentes dividem o trabalho sem coordenação e uma publicação duplicada é segura para o consumidor.

##### Fluxo

```
Processamento (HTTP, SQS e reprocesso do worker)        Publisher (PublishOutboxUseCase.runOnce, em todas as instâncias)
BEGIN; set_config('lock_timeout', ...)                  1. CLAIM (transação curta, sem wallet, sem I/O de rede):
  lock da wallet (FOR NO KEY UPDATE)                       WITH due AS (SELECT id FROM outbox_messages
  INSERT/UPDATE da transação                                 WHERE published_at IS NULL AND next_attempt_at <= now
  UPDATE wallet + INSERT ledger  (se o saldo mudou)          ORDER BY next_attempt_at LIMIT n FOR UPDATE SKIP LOCKED)
  INSERT outbox_messages  (1 ou 2 eventos)  <- ÚLTIMO      UPDATE outbox_messages SET next_attempt_at = now + lease
COMMIT; só então responde / dá ack                         FROM due ...                                   COMMIT
                                                        2. SendMessage na fila padrão `wager-events`  (fora de qualquer transação)
                                                        3a. sucesso: UPDATE published_at = now WHERE published_at IS NULL   (transação curta)
                                                        3b. falha:   UPDATE attempts + 1, next_attempt_at = now + backoff   (transação curta)
                                                             WHERE published_at IS NULL AND next_attempt_at = o lease deste claim
```

Ordem global de locks e escritas: **wallet → transação → ledger → outbox**. O claim do publisher não toca wallet nem ledger, então não participa dessa ordem
(`outbox-lock-order.test.ts` lê o SQL emitido: o `INSERT` do outbox vem depois do ledger e antes do `COMMIT`; o claim contém `FOR UPDATE SKIP LOCKED` e nenhuma tabela de negócio).

##### Eventos

Envelope: classe abstrata `IntegrationEvent<T>` com **uma subclasse por evento**. `eventType` e `version` são propriedades do tipo; `data` só tem tipos JSON (dinheiro como `MoneyProps`, strings decimais); `toJSON()` produz o envelope
com `occurredAt` em ISO-8601, que é exatamente o `payload` gravado e o corpo da mensagem publicada. `outbox_messages.id = eventId`.

| Evento | Quando | `aggregateId` | `data` (além da identificação da transação) |
| --- | --- | --- | --- |
| `WagerTransactionProcessed` | Qualquer transação aplicada, inclusive `LOSS` | transação | `balance` (saldo depois) |
| `WagerTransactionRejected` | Rejeição de negócio, inclusive o limite do worker esgotado | transação | `failureCode`, `balance` (saldo visto) |
| `WalletBalanceChanged` | **Somente** se houve lançamento (nunca em `LOSS`, nunca em rejeição) | wallet | `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` |
| `WagerTransactionPendingReference` | Na **1ª** vez que fica pendente; reagendar não gera evento | transação | `referenceExternalTransactionId` |

Quais eventos nascem de cada liquidação é uma função pura (`integrationEventsFor`), testada isoladamente: `Processed` (+ `BalanceChanged` se houve lançamento), `Rejected`, ou `PendingReference` só se o estado anterior não era `PENDING_REFERENCE`.
Replay de idempotência, wallet inexistente (404) e transação que falha no meio não geram evento.

Interpretações desta fase:

- **`correlationId`**: header `x-correlation-id` no HTTP (opcional, até 128 caracteres), `messageId` no SQS; sem origem (HTTP sem o header, reprocesso do worker) é o **id da transação**. Consequência: os eventos de uma transação que passou pelo worker
  podem ter `correlationId`s diferentes (o da submissão e o do reprocesso); o `aggregateId` é o que os liga. Guardar o `correlationId` na transação exigiria uma coluna nova (migration); não foi feito.
- **`causationId`** só existe onde há uma causa a apontar: o `WalletBalanceChanged` aponta o `eventId` do `WagerTransactionProcessed` do mesmo processamento.
- **`OPENING` (criação de wallet) gera os mesmos eventos de qualquer transação aplicada** (`WagerTransactionProcessed` e `WalletBalanceChanged`). A decisão original desta fase (não gerar) foi revertida na Fase 6: ver "Ajuste da Fase 5" abaixo.
  A invariante verificada é "todo `BalanceChanged` tem o lançamento correspondente e todo lançamento, inclusive o de abertura, tem o seu `BalanceChanged`".
- `OutboxMessage` não expõe `isDue`: o vencimento é decidido pelo claim em SQL; um método de domínio sem uso seria código morto.

##### Decisões e alternativas

**1. Evento na mesma transação do fato (transactional outbox).** O `INSERT` do evento é o último passo do `uow.run`: ou fato e evento são confirmados juntos, ou nenhum. A publicação é um passo separado, depois do commit.

| Alternativa | Por que não |
| --- | --- |
| Publicar dentro da transação | Viola a regra 4: com `ROLLBACK` depois do envio, o consumidor recebe um evento de algo que não aconteceu. Não existe commit distribuído entre Postgres e SQS. |
| Publicar logo depois do commit, sem outbox | Crash entre o commit e o envio perde o evento para sempre. |
| `LISTEN/NOTIFY` no lugar do polling | A notificação some se ninguém estiver ouvindo no instante do commit; ainda seria preciso varrer a tabela. Seria só otimização de latência sobre o mesmo polling. |
| CDC (Debezium/WAL) | Infraestrutura extra (conector, Kafka ou similar) fora do que o desafio pede. |

**2. Claim por lease com `FOR UPDATE SKIP LOCKED`, publicação fora da transação.** O claim empurra `next_attempt_at` para `agora + lease`; a linha some do filtro até o lease vencer.
Publishers concorrentes recebem lotes **disjuntos**, ninguém espera por linha alheia e nenhuma conexão ou lock fica preso durante I/O de rede. Se o publisher morrer depois do claim, o evento volta a ser elegível quando o lease vencer.
Alternativa descartada: segurar o `SKIP LOCKED` durante o `SendMessage`: prende uma conexão por lote e, se o SQS ficar lento, o pool do serviço esgota.
`markPublished` e `scheduleRetry` atualizam `WHERE published_at IS NULL`: um publisher lento, cujo lease já venceu, não atropela o resultado de quem publicou antes.

**Posse do lease (correção após revisão independente).** `published_at IS NULL` não bastava para o retry: um publisher antigo que **falhasse** depois de outro reivindicar a linha reagendava por cima do lease do segundo (um terceiro podia pegar o evento enquanto o segundo o enviava) e regredia `attempts` e o backoff (reproduzido em teste).
Agora `scheduleRetry` só grava se `next_attempt_at` ainda é o `leaseUntil` do próprio claim. Não precisou de coluna nova: um novo claim exige `next_attempt_at <= now` e grava `now + lease`, sempre maior que o anterior, então o valor funciona como token de posse. Sem ninguém ter reivindicado, a falha tardia agenda o retry normalmente.
`markPublished` continua sem a condição de propósito: se o envio atrasado deu certo, o evento **foi** publicado e deve ser marcado. Alternativa descartada: coluna `claim_token` (migration sem ganho sobre o valor que já existe). Limite: a monotonicidade supõe que o relógio de uma instância não ande para trás.

**3. Destino: fila SQS padrão `wager-events`.** O enunciado não define o destino. Fila padrão basta porque a correção do consumidor não depende de ordem nem de deduplicação do SQS: ele deduplica por `eventId` e ordena por `walletVersion`.
A mensagem leva os atributos `eventId` e `eventType` e o corpo é o envelope. Alternativas: fila FIFO (a deduplicação do SQS dura 5 minutos e não cobre uma republicação depois de um lease longo, então o consumidor teria de deduplicar mesmo assim) e SNS (um salto a mais sem necessidade aqui).

**4. Backoff da falha de publicação.** `attempts + 1` e `next_attempt_at = agora + min(60 s, 1 s · 2^(attempts-1))` com jitter de 0 a +50%
(1 s, 2 s, 4 s, 8 s, 16 s, 32 s, 60 s, 60 s...). O cálculo é compartilhado com a política de `PENDING_REFERENCE` (`src/domain/backoff.ts`).
Justificativa: uma falha isolada costuma passar na tentativa seguinte (base curta); o teto de 60 s impede martelar o SQS durante uma queda longa e limita o atraso depois da recuperação a ~1,5 min; o jitter espalha eventos que falharam juntos.
**Não há limite de tentativas nem DLQ do outbox**: um evento é um fato já commitado e nunca é descartado; `attempts` só cresce e fica observável no banco e nos logs (`outbox_publish_failed`). Estimativas, não medições.

**5. Lote, lease e intervalo (estimativas a ajustar com medição; todos por env).**

| Parâmetro | Padrão | Por quê |
| --- | --- | --- |
| Lote (`OUTBOX_BATCH_SIZE`) | 50 | Um `SendMessage` leva dezenas de ms, então o lote cabe em ~1–2 s, muito abaixo do lease; e é pequeno o bastante para dois publishers dividirem um backlog em vários claims. |
| Lease (`OUTBOX_LEASE_MS`) | 30 s | ~15x o tempo normal de um lote: cobre uma passada lenta sem que outro publisher reivindique (duplicata). É também o atraso máximo para outro publicar quando o publisher que reivindicou morre. |
| Intervalo (`OUTBOX_POLL_INTERVAL_MS`) | 1 s | Atraso típico commit→publicação ≈ 1 s + envio; uma passada ociosa custa uma consulta indexada por segundo por instância (índice parcial `outbox_due_idx`). A passada que enche o lote repete sem esperar. |

A publicação do lote é sequencial (preserva a ordem do lote, do `occurredAt` mais antigo ao mais novo, e não abre rajada de conexões). **Se o lease vence no meio da passada, o publisher para**: os eventos restantes podem já ter sido reivindicados por outro,
então publicá-los geraria duplicatas desnecessárias; eles saem na passada seguinte (`abandoned` no resumo da passada).

**6. Loop e shutdown.** O loop periódico dos dois workers por lease é a mesma classe, `PollingWorker` (generalizada a partir do worker de `PENDING_REFERENCE`, sem copiar código). `main.ts` o inicia em todas as instâncias; os testes sobem o módulo sem loop e chamam `runOnce()`.
No `SIGTERM`, `beforeApplicationShutdown` executa `Promise.all([consumer.stop(), worker.stop(), publisher.stop()])` e só depois `onApplicationShutdown` fecha o ORM e o cliente SQS. `stop()` espera a passada em andamento terminar.
Uma passada interrompida por `SIGKILL` deixa eventos reivindicados e/ou enviados e não marcados: voltam depois do lease (ver garantias).

**7. Configuração (validada no boot).** `SQS_EVENTS_QUEUE_NAME` (obrigatória), `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_LEASE_MS` (inteiros positivos; valor inválido derruba a subida). `.env.example` está atualizado. A URL da fila é resolvida na 1ª publicação, então o HTTP sobe mesmo com o SQS fora.

##### O que é e o que não é garantido ao consumidor dos eventos

**Garantido**

- **Nenhum evento sem commit.** O evento só existe no outbox se a transação do fato foi confirmada, e o publisher só enxerga linhas commitadas. Rollback não deixa evento (nem o que já tinha sido inserido).
- **Nenhum evento perdido.** Todo fato commitado tem o seu evento no outbox, e o evento é reivindicado e republicado até ser marcado. Crash do processo depois do commit, crash do publisher depois do claim e SQS fora do ar não o perdem.
- **Entrega *at-least-once*.** Cada evento chega à fila **uma ou mais vezes**. O `eventId` é estável (= `outbox_messages.id`, o mesmo em todas as cópias e em todas as tentativas): o consumidor **deve** deduplicar por ele.
- **Ordem do saldo por wallet reconstruível.** `WalletBalanceChanged.walletVersion` sobe 1 a cada alteração de saldo da wallet; o consumidor ordena por ela e detecta lacunas.

**Não garantido**

- **Exatamente uma vez.** Duplicatas acontecem quando o publisher envia e morre (ou falha) antes de gravar `published_at`, ou quando um lease vence com um publisher ainda lento; o próprio SQS padrão também pode entregar uma mensagem mais de uma vez. Não existe entrega exatamente-uma-vez entre dois sistemas sem um protocolo de deduplicação no destino.
- **Ordem entre eventos.** A fila é padrão, lotes concorrentes e retries se intercalam, e o backoff atrasa um evento enquanto outro passa. Dentro de **uma transação**, `Processed` e `BalanceChanged` são gravados juntos e o segundo traz `causationId` apontando o primeiro; mas podem chegar em qualquer ordem.
  Entre transações diferentes (mesmo da mesma wallet) não há ordem de entrega: use `walletVersion` (saldo) ou `occurredAt`/`aggregateId` (demais). `PendingReference` pode chegar depois do `Processed` da mesma transação.
- **Latência limitada.** Típica ≈ 1 s. Depois da morte de um publisher, até o lease (30 s) mais o intervalo. Com o SQS fora, o atraso cresce com o backoff (teto de 60 s + jitter) e termina ~1,5 min depois da recuperação.
- **Correlação entre eventos de uma transação que passou pelo worker** (ver interpretação do `correlationId`).

##### Verificação

Postgres e MiniStack **reais** em todos os testes de integração e concorrência; o tempo (lease e backoff) é um relógio injetado, nunca um `sleep`.

| Camada | Arquivos | O que prova |
| --- | --- | --- |
| Unidade | `integration-events`, `integration-events-for`, `outbox-message`, `outbox-config`, `mappers`, `polling-worker`, `app-shutdown`, `wagering-dto`, `wager-message-handler` | Envelope e payload dos 4 eventos (`eventType`/`version` no tipo, strings, `toJSON`); quais eventos nascem de cada resultado (LOSS sem `BalanceChanged`, reagendamento sem evento novo, limite esgotado = `Rejected`); estados de `OutboxMessage` e backoff; config por env; shutdown na ordem certa; `correlationId` |
| Integração | `outbox-events`, `outbox-atomicity`, `outbox-lock-order`, `outbox-repository`, `outbox-publisher` | Os 4 eventos pelo HTTP, SQS e worker, com payload e `correlationId`; falha em 5 pontos (inclusive no 2º evento) não deixa nada; ordem de escrita e claim sem wallet; claims disjuntos, linha travada pulada, lease; publicação na fila real, `published_at`, lote; SQS fora do ar com backoff 1 s→60 s sem perder o evento; recuperação por lease; lote lento; falha tardia de um publisher com lease vencido; duplicata contada; **nenhuma mensagem antes do commit nem após rollback** |
| Concorrência (processos reais) | `test/concurrency/outbox.test.ts` | **#6** dois publishers (processos) com uma linha travada por outra transação: 99 publicados, nenhum perdido, 0 duplicatas, e o último sai depois; publisher morto por `SIGKILL` depois de enviar e antes de marcar: outro republica, 0 perdidos, exatamente 1 duplicata contada. **#8** o serviço real (`bun run src/main.ts`) morre por `SIGKILL` depois do commit e antes de publicar; um novo serviço sobe e publica; `wallet == ledger == eventos`; o replay devolve o mesmo resultado (a idempotência sobreviveu ao reinício) e não gera evento |

Invariante final (`wallet.balance == saldo reconstruído pelo ledger`, mais "todo `BalanceChanged` tem o lançamento correspondente e `walletVersion` fecha com a wallet") conferida em todos os cenários que mexem em saldo.

**Controles negativos** (mutação temporária no código de produção, revertida):

| Mutação | Resultado |
| --- | --- |
| `outbox.add` também publica no SQS, **dentro** da transação (antes do commit) | Falham os dois testes "nunca antes do commit" (mensagens na fila com a transação aberta e depois do rollback) e 6 outros testes do publisher (a fila passa a ter cópias a mais) |
| `scheduleRetry` sem a condição do lease (código anterior à correção) | Falham os 2 testes do publisher atrasado em `outbox-publisher` (lease do segundo sobrescrito; `attempts` regride de 2 para 1) |
| Claim sem `SKIP LOCKED` (`FOR UPDATE` puro) | Falham o teste de linha travada do repositório (o claim espera o `lock_timeout` e dá erro), o teste de ordem de locks (que exige `skip locked` no SQL) e o **#6**. **Achado:** o #6 original **não** pegava a mutação, porque sem `SKIP LOCKED` o claim concorrente continua disjunto (espera e relê a linha já agendada); só perde vazão. Por isso o #6 segura uma linha travada durante a publicação: os publishers precisam pulá-la. |

##### Limitações e pontos em aberto

- **Evento que o SQS nunca aceita** (por exemplo, acima de 256 KB) é retentado para sempre a cada ~60 s. Os eventos têm ~1 KB; não há DLQ do outbox. A observabilidade (log `outbox_publish_failed` com `eventId` e `attempts`, e o gauge `wager_outbox_lag_seconds`) entrou na Fase 6; não há alerta, só a métrica.
- **Sem retenção**: `outbox_messages` só cresce. O índice parcial `outbox_due_idx` mantém o claim barato, mas uma rotina de purga dos publicados (por `published_at`) é trabalho futuro.
- **Relógio da aplicação** em lease, backoff e `published_at`. Um desvio entre instâncias desloca vencimentos em segundos; não afeta a correção (a exclusão mútua é do claim, não do relógio), só pode causar uma duplicata a mais.
- **Vazão por instância** ≈ 1/latência do `SendMessage` (publicação sequencial); escala com mais instâncias. `SendMessageBatch` foi descartado (resposta parcial por item complica o tratamento de falha sem necessidade medida).
- **Contadores do MiniStack.** Os testes leem a fila com `ReceiveMessage`/`DeleteMessage` (não com `ApproximateNumberOfMessages`). A duplicata do SQS padrão por conta própria não foi observada no MiniStack; as duplicatas testadas são provocadas (crash entre envio e marcação, lease vencido).
- **Evento de `FAILED`** não existe: `FAILED` não é gravado no caminho SQS (Fase 4) e o enunciado não lista evento para ele.
- **Isolamento dos testes.** O banco de testes acumula eventos entre execuções; os testes que rodam um publisher chamam `parkOutbox` (marca como publicados os pendentes de outros testes), do mesmo modo que `parkPendingReferences`. Os testes assumem execução sequencial dos arquivos (padrão do `bun test`).

---

#### Fase 6 — Reconciliação, health, métricas e logs

**Objetivo.** Tornar o serviço operável e auditável sem tocar nas garantias de correção: provar por API que saldo e ledger conferem (e **sinalizar** quando não conferem, sem corrigir), dizer se o processo e suas dependências estão de pé,
expor métricas e emitir logs que permitam seguir uma transação de ponta a ponta sem vazar payload (API e observabilidade pedidas pelo enunciado). A fase abre com um ajuste da Fase 5 (eventos da abertura da wallet).

##### Ajuste da Fase 5: eventos da abertura da wallet (`OPENING`)

**Problema.** Na Fase 5 a criação de wallet com `initialBalance > 0` alterava o saldo (grava `OPENING` + `CREDIT`) e não gerava evento. Um consumidor que reconstrói o saldo por `WalletBalanceChanged`
(`balanceBefore`/`balanceAfter`/`walletVersion`) via a wallet nascer já com saldo e uma lacuna entre a `version` 1 e o saldo do primeiro evento. Era uma exceção à regra "todo fato que muda saldo tem evento".

**Decisão.** `CreateWalletUseCase` grava `WagerTransactionProcessed` (kind `OPENING`, `providerId = 'internal'`) e `WalletBalanceChanged` (`CREDIT`, `balanceBefore = 0.00`, `walletVersion = 1`) no outbox, **na mesma transação SQL da criação**,
reaproveitando `integrationEventsFor` (a mesma função pura do HTTP, SQS e worker). Ordem de escrita: wallet → transação → ledger → outbox.

- **Atomicidade.** Wallet duplicada falha no primeiro `INSERT` (`wallets_player_currency_uq`, 409) e nada mais é gravado, nem evento. Falha ao gravar o ledger ou o próprio evento desfaz tudo (testes de atomicidade).
- **`initialBalance = 0.00`** continua sem `OPENING`, sem lançamento e sem evento: o saldo não muda.
- **`correlationId`** é o id da transação `OPENING` (a criação não recebe `x-correlation-id`); `causationId` do `WalletBalanceChanged` aponta o `Processed`.
- **Alternativa descartada: um evento próprio `WalletOpened`.** Criaria um tipo novo fora da lista de eventos do enunciado e obrigaria o consumidor a tratar dois caminhos para o mesmo conceito (saldo mudou). Reaproveitar os eventos existentes mantém o contrato.
- **Compatibilidade.** O consumidor que já deduplica por `eventId` e ordena por `walletVersion` não muda; ele passa a ver a `version` 1.
- A invariante dos testes (`expectEventsConsistentWithLedger`) deixou de excluir a abertura: todo lançamento, inclusive o `OPENING`, tem o seu `WalletBalanceChanged`.

##### Visão geral: como a observabilidade se liga ao código

O domínio e os casos de uso **não conhecem** log nem métrica. Cada ponto que produz um dado chama uma **porta de observação** pequena, sempre **depois do commit** e sem poder alterar o fluxo;
a camada de infraestrutura implementa a porta com `prom-client` e `logJson`. Nenhuma garantia de correção (idempotência, lock, outbox) depende dessas portas.

| Porta | Quem chama | Implementação | Alimenta |
| --- | --- | --- | --- |
| `ProcessingObserver.completed(report)` | `ProcessWagerTransactionUseCase` (HTTP e SQS), depois do commit | `ObservedProcessing` | `wager_transactions_total`, `wager_duplicates_total`, `wager_processing_duration_seconds` e o log do resultado |
| `ReprocessOptions.onSettled(transaction)` | worker de `PENDING_REFERENCE`, depois do commit, só quando passa a `PROCESSED`/`REJECTED` | `app.module.ts` | `wager_transactions_total` e o log `pending_reference_settled` |
| `PersistenceObserver` (`transientFailure`, `walletLockWaited`) | `MikroOrmUnitOfWork` (retry transitório) e `lockWallet` | `Metrics` | `wager_retries_total{source="database"}`, `wager_lock_conflicts_total`, `wager_wallet_lock_wait_seconds` |
| `QueueObserver` (`deadLettered`, `retried`) | `QueueConsumer`, depois de copiar para a DLQ / devolver à fila | `Metrics` | `wager_dlq_messages_total`, `wager_retries_total{source="queue"}` |
| `ReconciliationObserver.checked(result)` | `ReconcileWalletUseCase` | `ObservedReconciliation` | `wager_reconciliation_divergence_total` e o log da reconciliação |
| gauge com `collect()` assíncrono | o scrape de `GET /metrics` | `Metrics.trackOutboxLag` | `wager_outbox_lag_seconds` |

##### Logs

**Um único ponto de saída.** `logJson(level, message, fields)` (`src/infrastructure/observability/json-log.ts`) escreve **uma linha JSON** por chamada: `info` e `warn` em stdout, `error` em stderr, com `level`, `time` (ISO-8601) e `message`.
O código da aplicação não escreve em stdout/stderr por outro caminho: o logger do Nest (`JsonLogger`, passado em `NestFactory.create`) e o filtro de exceção usam o mesmo `logJson`, e o ESLint tem `no-console: error` em `src/` e `scripts/` (`bun run check` falha se alguém usar `console.*`). O que bibliotecas e o runtime escrevem por conta própria está em "Limitações".
`main.ts` também registra falha de boot pelo `logJson` (`bootstrap_failed`) em vez de deixar o runtime imprimir texto.

**Campos pedidos pelo enunciado.** `correlationId` (header `x-correlation-id` no HTTP, até 128 caracteres; `messageId` no SQS; na falta, o id da transação), `messageId`, `transactionId`, `walletId`, `providerId`, mais o resultado (`kind`, `status`, `failureCode`).

| `message` | Nível | Quando | Campos além de `level`/`time` |
| --- | --- | --- | --- |
| `wager_transaction_processed` | info | transação decidida agora (PROCESSED, REJECTED ou PENDING_REFERENCE), HTTP ou SQS | `correlationId`, `messageId`*, `transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode`* |
| `wager_transaction_replayed` | info | replay de idempotência | idem |
| `wager_message_duplicate` | info | o inbox já tinha a mensagem | `correlationId`, `messageId`, `walletId`, `providerId` |
| `pending_reference_settled` | info | o worker resolveu uma pendência | idem da 1ª linha, sem `messageId` |
| `wallet_reconciled` / `wallet_reconciliation_diverged` | info / **error** | reconciliação | `correlationId`*, `walletId`, `checkedEntries`, e `difference` na divergência |
| `wager_message_transient_failure` / `wager_message_permanent_failure` | error | falha ao processar uma mensagem | `correlationId`, `messageId`, `receiveCount`, `errorName`..., `reason`/`delaySeconds` |
| `request_failed` | error | resposta 5xx | `status`, `correlationId`*, `errorName`... |
| `readiness_check_failed` | warn | uma dependência não respondeu no readiness | `dependency`, `errorName`... |
| `outbox_publish_failed`, `outbox_lag_unavailable`, `sqs_*`, `pending_reference_*_failed` | error | falhas dos workers e do consumidor | ids do item e `errorName`... |

\* só quando existe.

**O que os campos do serviço nunca levam.** Corpo da requisição ou da mensagem, `playerId`, valores (`amount`, saldos), `roundId`, `gameId`, `Idempotency-Key`, `externalTransactionId`. O log carrega identificadores e o resultado; a divergência de reconciliação loga a **diferença**, não os saldos.
`correlationId`, `messageId` e `providerId` são texto escolhido por quem chama e são registrados como chegam (são campos de log que o enunciado pede).
Os testes de `test/integration/logs.test.ts` inspecionam a saída real (aplicação real em HTTP, 5xx com o Postgres fora do ar, e o handler real do SQS): cada linha é JSON, os campos esperados estão presentes e nenhum dos valores acima aparece.

**Mensagem de exceção só para classes nossas conferidas.** O `message` de um erro do driver, do ORM ou de uma biblioteca pode trazer o SQL com os **valores** interpolados. `describeError` loga `errorName` e, se houver, `errorCode` (SQLSTATE ou código de rede);
`errorMessage` só quando a **classe exata** está na lista permitida de `json-log.ts`: erros de aplicação, os erros de domínio de texto fixo ou só com ids e estados, e `ConfigurationError` (boot: nome da variável, nunca o valor).
Erro embrulhado mostra `causeName`/`causeCode`; valor que não é `Error` loga só o tipo.

**Correção após revisão independente.** A regra anterior omitia a mensagem só de erros com `code` ou do driver, ou seja, **confiava em todo o resto**: uma exceção sem código vinda do ORM ou de uma biblioteca saía inteira no log.
Também havia vazamento real sem exceção de terceiros: um `type` desconhecido no SQS (texto do produtor) era repetido por `UnknownMessageTypeError`. Ficam fora da lista as classes nossas que repetem a entrada
(`InvalidMoneyError`, `CurrencyMismatchError`, `MalformedMessageError`, `UnknownMessageTypeError`). A comparação é por classe exata: subclasse nova não herda a permissão.

Alternativas descartadas: filtrar a mensagem por regex (qualquer formato novo vaza); `instanceof DomainError || ApplicationError` (qualquer classe futura passaria sem conferência).
Custo assumido: um `Error` genérico (inclusive os de invariante interna e o prazo estourado do readiness) e as mensagens malformadas perdem o texto no log; restam nome, código, `reason` e os ids. A mensagem inválida continua inteira na DLQ para diagnóstico.

##### Métricas (`GET /metrics`, formato texto do Prometheus)

Biblioteca: **`prom-client` 15.1.3** (Apache-2.0; dependências transitivas `@opentelemetry/api` e `tdigest`/`bintrees`). Única dependência nova da fase. **Verificada no Bun 1.4.4** (counter, gauge com `collect()` assíncrono, histograma e escape de labels, via os testes de integração).
Alternativa descartada: escrever o formato de exposição à mão (buckets cumulativos, escape de labels e `+Inf` são fáceis de errar e não valem o risco); OpenTelemetry é opcional no enunciado e fica fora do escopo.

| Métrica | Tipo | Labels | O que mede |
| --- | --- | --- | --- |
| `wager_transactions_total` | counter | `status`, `kind` | Transações **decididas**: nova (HTTP/SQS) ou resolvida pelo worker. Replay e conflito (409) não contam. |
| `wager_duplicates_total` | counter | — | Replay de idempotência + mensagem repetida no inbox. |
| `wager_retries_total` | counter | `source` = `database` \| `queue` | `database`: retry interno de falha transitória (40P01, 40001, 55P03, conexão). `queue`: mensagem devolvida ao SQS com backoff. |
| `wager_dlq_messages_total` | counter | — | Mensagens que o consumidor copiou para a DLQ (falha permanente). |
| `wager_lock_conflicts_total` | counter | — | Deadlock (40P01), serialização (40001) e `lock_timeout` (55P03). |
| `wager_wallet_lock_wait_seconds` | histogram | — | Espera do `SELECT ... FOR NO KEY UPDATE` da wallet, **inclusive quando estoura o `lock_timeout`**. |
| `wager_processing_duration_seconds` | histogram | — | Duração de uma execução do caso de uso que **terminou com resultado** (nova, replay ou mensagem duplicada). |
| `wager_outbox_lag_seconds` | gauge | — | Idade do evento não publicado mais antigo; 0 se não há pendente. |
| `wager_reconciliation_divergence_total` | counter | — | Reconciliações que acharam divergência. |

Os nomes são nossos: o enunciado lista o que medir, não os nomes. Os buckets (5 ms a 10 s) cobrem uma transação curta (dezenas de ms) e o pior caso do `lock_timeout` (3 s x 3 tentativas). Sem métricas do processo (`process_*`, `nodejs_*`): só as acima, para o `/metrics` ser exatamente o contrato descrito aqui.

Decisões:

1. **`Registry` por aplicação, não o global.** Vários módulos no mesmo processo (testes de integração) não colidem nem somam valores; cada `startApi()` começa do zero e os testes asseguram valores absolutos.
2. **Labels de cardinalidade fixa** (`status`, `kind`, `source`): nunca `walletId`, `providerId` ou `transactionId` (explodiria a série temporal). Os ids ficam no log.
3. **`wager_retries_total` com `source`.** O enunciado pede "retries", mas há duas camadas (retry em processo e redelivery do SQS) com custos diferentes. Um rótulo evita somar duas coisas distintas; `sum()` dá o total.
4. **`wager_lock_conflicts_total` inclui `lock_timeout` (55P03)**, além de deadlock e serialização: é o sintoma de uma wallet quente e é transitório da mesma forma. Está no texto do `HELP`.
5. **Lag do outbox é lido no scrape, não guardado.** Um gauge atualizado pelo publisher seria por instância e ficaria velho se o publisher morresse; a consulta (`min(occurred_at)` entre os não publicados, no relógio do banco) vale para o conjunto das instâncias. Se a leitura falhar, a amostra **some** do scrape e `outbox_lag_unavailable` é logado: ausência é honesta, `0` seria mentira.
6. **Duração só de execuções com resultado.** Erro (404, 409, 503) sobe como exceção e não entra no histograma; a latência de falha é observável pelo status HTTP.
7. **Transação resolvida pelo worker conta em `wager_transactions_total`** (`PROCESSED`/`REJECTED`, não o reagendamento). Sem isso, toda reversão que esperou a referência ficaria invisível.
8. **Observar nunca altera o fluxo**: as portas rodam depois do commit; uma falha de métrica não desfaz uma aposta.

##### Reconciliação (`POST /wallets/:walletId/reconciliation`)

```
{ walletId, storedBalance, calculatedBalance, difference, consistent, checkedEntries }     (dinheiro como { amount, currency })
```

- **O que faz.** Uma única instrução SQL lê `wallets.balance` e `SUM(CREDIT) - SUM(DEBIT)` do ledger daquela wallet, a diferença (`stored - calculated`, **com sinal**) e a contagem de lançamentos. `consistent` é `balance = soma`.
- **Uma instrução, um snapshot, sem lock.** Wallet e ledger são gravados na mesma transação; um snapshot só enxerga os dois ou nenhum. Duas consultas separadas (ou um lock) seriam erradas ou caras: em `READ COMMITTED` a segunda poderia ver um commit que a primeira não viu e **fabricar uma divergência**.
  O teste de concorrência reconcilia sem parar durante 40 apostas na mesma wallet e exige 100% de leituras consistentes; trocar a instrução única por duas consultas (mutação, abaixo) faz esse teste falhar nas 3 execuções.
- **Não corrige.** Divergência vira: resposta `200` com `consistent: false` e a diferença; log `wallet_reconciliation_diverged` (nível `error`, com `walletId`, `correlationId`, `checkedEntries`, `difference`); incremento de `wager_reconciliation_divergence_total`. Nada é escrito.
  Por quê: o ledger é imutável (triggers) e uma "correção" automática do saldo esconderia a causa (bug, SQL manual, trigger desligado) e quebraria a trilha de auditoria. Corrigir é decisão humana, com lançamento de ajuste próprio, fora do escopo.
- **Status.** `200` mesmo com divergência (a divergência é o resultado da consulta, não erro da requisição); `404 WALLET_NOT_FOUND` se a wallet não existe; `400 VALIDATION_ERROR` se `walletId` não é UUID; `x-correlation-id` opcional, igual ao das apostas. É `POST` (como pede o enunciado), mas **só lê**; não é idempotente no sentido de contagem: cada chamada que acha divergência incrementa a métrica (conta detecções, não wallets distintas).
- **Teste da divergência.** `inflateBalance` e `creditLedgerOnly` (`test/support/db.ts`) alteram saldo e ledger por SQL direto. O trigger deferido (`wallets_match_ledger_trg` / `ledger_match_wallet_trg`) é **desligado só dentro de uma transação do teste** (`ALTER TABLE ... DISABLE TRIGGER`, transacional no Postgres)
  e religado antes do `COMMIT`; um evento que não foi enfileirado com o trigger desligado não dispara depois. Os dois sentidos são provados: saldo maior que o ledger (`+5.00`) e ledger maior que o saldo (`-7.50`, diferença negativa). Depois da reconciliação o teste confere por SQL que **saldo e ledger continuam como estavam** (não corrigiu), que uma 2ª chamada vê a mesma divergência e que a métrica e o log foram emitidos.
  Ao final, `healFromLedger` realinha o saldo por um `UPDATE` legítimo (triggers ligados) para o banco compartilhado não ficar com lixo. O `ALTER TABLE ... DISABLE TRIGGER` exige ser dono da tabela e trava escritas na tabela até o commit; é recurso **exclusivo dos testes**.

##### Health (`GET /health/live`, `GET /health/ready`)

- **`live`** responde `200 {"status":"ok"}` sem olhar dependência: reiniciar o processo não conserta um Postgres fora do ar, então liveness não pode depender dele (evitaria reinício em cascata).
- **`ready`** verifica **Postgres** (`select 1` pelo mesmo pool das requisições: um pool esgotado também reprova) e **SQS** (`GetQueueUrl` das filas de entrada e de eventos: falha com endpoint fora do ar **e** com fila inexistente), **em paralelo**, cada uma com prazo de `HEALTH_CHECK_TIMEOUT_MS` (padrão 2 s).
  Resposta `200 {"status":"ok","checks":{"postgres":"up","sqs":"up"}}` ou `503 {"status":"unavailable","checks":{...}}` apontando qual caiu. A causa vai para o log (`readiness_check_failed`, `warn`); a resposta não expõe endereço nem mensagem do driver.
- **Prazo de verdade.** `ReadinessChecker` corre cada verificação contra um timeout (`AbortController` + `Promise.race`): uma verificação que ignora o sinal de cancelamento e nunca resolve também vira `down` no prazo.
- **Sem estado.** Cada chamada verifica de novo, então a recuperação aparece na chamada seguinte. Sem autenticação (o enunciado exige health aberto).
- **Testes sem derrubar a infraestrutura compartilhada.** A aplicação real sobe com `DATABASE_URL` ou `AWS_ENDPOINT_URL` apontando para `127.0.0.1:9` (recusa de conexão de verdade) e o teste confere o `503`, qual dependência está `down`, que `live` segue `200` e que a resposta volta em menos de 4 s. Nenhum mock de Postgres ou SQS.

##### Verificação

Postgres e MiniStack **reais**; nenhum teste de integração ou concorrência mocka banco ou fila. A divergência é provocada por SQL direto; o SQS "fora do ar" é um endereço morto.

| Camada | Arquivos | O que prova |
| --- | --- | --- |
| Unidade | `observed-processing`, `json-log`, `readiness-checker`, `transient-retry` | O relatório do caso de uso vira métrica + log certos (nova, replay, mensagem duplicada); `logJson` (stdout/stderr, uma linha, `undefined` omitido) e a política do `describeError` (lista permitida, classe exata, marcador sensível); timeout e paralelismo do readiness; `isLockConflict` e o callback `onTransientFailure` (willRetry falso na última tentativa) |
| Integração | `reconciliation`, `health`, `metrics`, `metrics-lock-conflicts`, `metrics-sqs`, `logs`, `wallet-opening-events` | Reconciliação consistente e divergente (nos dois sentidos), 404/400; readiness com Postgres e/ou SQS mortos; formato Prometheus (HELP/TYPE das 9 métricas, cumulatividade dos buckets) e **valores** depois de aposta processada, duplicata, rejeição, pendência e conflito 409; **deadlock real** (40P01) e **lock_timeout real** (55P03) contados; DLQ, retry e duplicata pelo consumidor SQS real; inspeção da saída do logger, inclusive exceções com marcador sensível (HTTP 500, SQS e logger do Nest); eventos da abertura |
| Concorrência | `test/concurrency/reconciliation.test.ts` | 40 apostas paralelas na mesma wallet com reconciliações em laço: nenhuma divergência falsa; no fim `consistent`, `checkedEntries = 41` e `wallet == ledger` |

Invariante final (`wallet.balance == saldo reconstruído pelo ledger`) conferida nos testes que mexem em saldo; a reconciliação é, ela própria, essa conta exposta por API.

**Controles negativos** (mutação temporária no código de produção, revertida):

| Mutação | Resultado |
| --- | --- |
| `consistent` sempre `true` na consulta da reconciliação | Falham os 3 testes de divergência (a divergência passaria despercebida) |
| Reconciliação em **duas** consultas (saldo e depois a soma) em vez de uma | Falha o teste de concorrência nas 3 execuções: a segunda consulta vê commits que a primeira não viu e fabrica divergência |
| Replay não conta duplicata | Falham 1 teste de unidade e 1 de integração (`wager_duplicates_total`) |
| Readiness sem a verificação do SQS | Falham 2 testes de health (SQS fora do ar; os dois fora do ar) |
| `describeError` volta à regra anterior (omite só erros com `code` ou do driver) | Falham 7 testes: os 4 de marcador sensível na saída real e 3 de unidade |
| Lista permitida trocada por "qualquer classe que não seja `Error`" | Falham 3 testes de unidade (classes que repetem a entrada, subclasse, `TypeError`) |
| Lag do outbox fixo em 0 | Falha o teste do gauge com evento pendente |

##### Limitações e pontos em aberto

- **Custo da reconciliação é O(lançamentos da wallet)** por chamada: uma soma sobre todo o ledger dela (índice `le_wallet_seq_idx`). Para uma wallet com milhões de lançamentos seria preciso um checkpoint (soma acumulada até um `seq`, verificada por job) ou executar fora do horário; não há varredura em lote de todas as wallets (o enunciado pede só o endpoint por wallet).
- **Reconciliar não é periódico.** Nada chama o endpoint sozinho; quem opera decide quando. Um job que reconcilie wallets recentes e alerte pela métrica seria o passo seguinte.
- **`wager_dlq_messages_total` não vê o redrive do próprio SQS.** Uma mensagem que estoura `maxReceiveCount` é movida pela fila sem passar pelo consumidor. Ver o total na DLQ exigiria `ApproximateNumberOfMessages` (e o MiniStack não é fiel a esse contador, ver Fase 4).
- **`wager_outbox_lag_seconds` custa uma consulta por scrape** (varre os pendentes; poucos, se o publisher acompanha). Com um backlog enorme, o próprio scrape fica caro. Usa o relógio do banco, enquanto `occurred_at` vem do relógio da aplicação: um desvio entre os dois desloca o valor em segundos.
- **As métricas são por instância** (cada processo tem o seu registry; contadores zeram no restart). O Prometheus agrega e trata o reset; `wager_outbox_lag_seconds` é global (lê o banco), então toda instância reporta o mesmo valor: não some entre instâncias.
- **`GET /metrics` e `/health/*` sem autenticação** (exigência do enunciado para o health; o `/metrics` segue o mesmo critério; no código, `@OpenRoute()`, ver "Autenticação"): devem ficar na rede interna. `wager_transactions_total` não expõe id algum.
- **Fora do `logJson`.** Não há tratador de `uncaughtException`/`unhandledRejection`: uma exceção que escape até o runtime é impressa pelo Bun em texto, com a mensagem. O logger do MikroORM escreve direto no console e está sem `debug` (avisos de depreciação ainda sairiam como texto; ligar `debug` imprimiria SQL com valores). Textos que o próprio Nest envia ao logger como `string` são registrados como chegam.
- **`errorName`, `errorCode` e os nomes de causa vêm da exceção** e são logados sem filtro.
- **Sem log de acesso HTTP.** Só o resultado de negócio (uma linha por transação decidida ou replay) e as falhas 5xx são logados; 4xx de validação não geram linha (a resposta já diz o motivo e não vale ruído nem risco de eco do payload).
- **Readiness não olha o consumidor, o worker nem o lag.** Ele diz que as dependências respondem; um consumidor travado por bug não derruba o readiness (a métrica de lag e os logs de erro é que sinalizam). `GetQueueUrl` prova alcance e existência da fila, não a permissão de enviar/receber.
- **`correlationId` não é guardado na transação** (já registrado na Fase 5): o do reprocesso do worker é o id da transação.
- **Sem dashboard, alertas nem OpenTelemetry** (opcionais no enunciado, fora do escopo).

---

### Revisão independente: correções e limitações restantes

Uma revisão por leitura estática (sem execução) apontou quatro pontos. Cada um foi primeiro reproduzido por um teste contra Postgres e MiniStack reais, depois corrigido, e o teste voltou a falhar com a correção desfeita.
Os detalhes, as alternativas e os controles negativos estão na seção de cada fase.

| Ponto | Reproduzido | Correção | Teste |
| --- | --- | --- | --- |
| O replay por idempotência contornava o inbox: a `messageId` podia voltar com outra transação e debitar | Sim | O replay por mensagem registra o inbox numa transação curta, sem lock de wallet (Fase 4) | `sqs-replay-inbox`, `process-wager-inbox` |
| Uma mensagem adiada não segurava as seguintes do grupo: uma `BET` era rejeitada antes de o `WIN` anterior ser aplicado | Sim | A seguinte só começa se a anterior saiu da fila (Fase 4) | `sqs-group-order` |
| Mensagem de exceção sem código ia para o log, inclusive com texto do produtor | Sim | Mensagem só para classes nossas de uma lista permitida (Fase 6, "Logs") | `logs`, `json-log` |
| Publisher com lease vencido sobrescrevia o agendamento de quem reivindicou depois | Sim | `scheduleRetry` condicionado ao lease do próprio claim, sem migration (Fase 5) | `outbox-publisher` |

Limitações que continuam, relacionadas a esses pontos:

- **Inbox:** mensagem que vai à DLQ não fica registrada (a transação faz `ROLLBACK`); a tabela não tem retenção.
- **Ordem por wallet:** vale para o que o consumidor já recebeu e depende de a FIFO bloquear o grupo com mensagem em voo (verificado só no MiniStack). Não sobrevive à DLQ (as seguintes podem ser aplicadas antes de um reprocesso), as devolvidas gastam recebimentos e podem ir à DLQ junto com a da frente, `PENDING_REFERENCE` não segura o grupo, o HTTP não tem ordem em relação à fila e não há heartbeat de visibilidade.
- **Logs:** exceção que escape até o runtime e texto escrito por bibliotecas não passam pelo `logJson`; `correlationId`, `messageId` e `providerId` são registrados como o chamador os envia; erros genéricos ficam sem mensagem no log.
- **Leases:** o worker de `PENDING_REFERENCE` não confere posse e pode consumir uma tentativa a mais; o publisher atrasado ainda pode gerar publicação duplicada (entrega at-least-once, deduplicada por `eventId`).

As demais limitações (reconciliação, métricas, health, retenção do outbox, escala) estão listadas em cada fase.
