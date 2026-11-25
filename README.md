# Distributed Wagering Processor

## O que é

Serviço (NestJS sob Bun, PostgreSQL e SQS) que processa transações de apostas de vários provedores e mantém, por wallet, um saldo materializado e um ledger imutável que conferem entre si, mesmo com mensagens duplicadas, fora de ordem ou simultâneas e com várias instâncias.

Implementado:

- API HTTP: wallets, ledger paginado, submissão e consulta de transações (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), reconciliação, health e métricas Prometheus.
- A mesma submissão por fila SQS FIFO, com inbox persistente e DLQ.
- Idempotência garantida pelo banco, lock pessimista por wallet e `Money` em `bigint` (dinheiro nunca é `number`).
- Transactional outbox: os eventos só são publicados depois do commit (entrega at-least-once).
- Worker para transações que chegam antes da transação referenciada (`PENDING_REFERENCE`).
- **Não há autenticação** (ver [Autenticação](#autenticação)).

Decisões, alternativas, trade-offs e limitações: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Início rápido

O Docker Compose sobe **apenas a infraestrutura** (PostgreSQL 16 e MiniStack, que emula o SQS). A aplicação roda com Bun na máquina local; **não há Dockerfile da aplicação**.

### Pré-requisitos

| Item | Versão testada | Observação |
| --- | --- | --- |
| [Bun](https://bun.sh) | 1.4.4 | Executa a aplicação, os scripts e os testes |
| Docker com Compose | Docker 29.9.2, Compose v5.6.1 | Precisa estar em execução |
| Git | qualquer versão recente | |
| `curl` e um shell bash | | Só para os [exemplos](#exemplos-com-curl); no Windows, use o Git Bash |

Portas que precisam estar livres: **5432** (PostgreSQL), **4566** (MiniStack) e **3000** (aplicação).

### Instalação do zero

```bash
git clone https://github.com/JaoV1ctor/teste-wagering-processor-.git
cd teste-wagering-processor-
bun install
cp .env.example .env
```

Preencha o `.env`. O `.env.example` é versionado com as chaves vazias; estes são os valores do ambiente local do `docker-compose.yml`:

```dotenv
DATABASE_URL=postgres://wager:wager@localhost:5432/wager
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
SQS_WAGER_QUEUE_NAME=wager-transactions.fifo
SQS_WAGER_DLQ_NAME=wager-transactions-dlq.fifo
SQS_EVENTS_QUEUE_NAME=wager-events
```

Depois, nesta ordem:

```bash
docker compose up -d --wait    # PostgreSQL e MiniStack; espera ficarem saudáveis
bun run infra:queues           # cria as três filas no MiniStack
bun run migration:up           # cria o schema
bun run start                  # aplicação em http://localhost:3000 (ocupa o terminal)
```

Em outro terminal, confira:

```bash
curl http://localhost:3000/health/ready
# {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

O MiniStack não guarda as filas: **depois de reiniciar os containers, rode `bun run infra:queues` de novo**.

### Variáveis opcionais

Todas têm padrão no código; não precisam estar no `.env`.

| Variável | Padrão | Significado |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `LOCK_TIMEOUT_MS` | `3000` | Prazo de cada espera por lock no PostgreSQL |
| `SQS_CONSUMER_CONCURRENCY` | `5` | Mensagens em processamento ao mesmo tempo no processo |
| `SQS_BATCH_SIZE` | `10` | Máximo por `ReceiveMessage` |
| `SQS_WAIT_TIME_SECONDS` | `20` | Long polling |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | Tempo em que a mensagem recebida fica invisível |
| `SQS_RETRY_BASE_SECONDS` | `5` | Base do backoff de falha transitória |
| `SQS_RETRY_MAX_SECONDS` | `120` | Teto do backoff |
| `SHUTDOWN_TIMEOUT_MS` | `25000` | Espera do `SIGTERM` pelas mensagens em andamento |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | Intervalo do publisher quando o lote não vem cheio |
| `OUTBOX_BATCH_SIZE` | `50` | Eventos reivindicados por passada |
| `OUTBOX_LEASE_MS` | `30000` | Reserva de um evento reivindicado |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | Prazo de cada dependência no readiness |

## Comandos

Todos na raiz do repositório. As suítes de integração e de concorrência exigem os containers no ar, o `.env` preenchido e as filas criadas (`bun run infra:queues`): sem as filas, os testes de readiness falham.

| Comando | O que faz | Resultado | Tempo medido |
| --- | --- | --- | --- |
| `bun run check` | Tipos (`tsc --noEmit`), lint e testes de unidade; não usa containers | 473 testes em 34 arquivos, 0 falhas | 8 s |
| `bun run test:integration` | Integração com PostgreSQL e MiniStack reais | 443 testes em 41 arquivos, 0 falhas | 2 min 6 s |
| `bun run test:concurrency` | Paralelismo e processos reais | 32 testes em 9 arquivos, 0 falhas | 50 s |
| `bun run test:security` | Casos de abuso contra a API e a fila; relatório em `security-results/` | 92 casos em 10 arquivos: 78 passaram, 14 confirmam limitações, 0 falharam | 28 s |
| `bun run test:load` | Carga completa (4 cenários) com conferência de invariantes; relatório em `load-results/` | Todas as invariantes passaram | 3 min 16 s |
| `bun run test:load --smoke` | Verificação rápida da carga; os números não servem para análise | Todas as invariantes passaram | 25 s |
| `bun run migration:up` | Aplica as migrations pendentes | 2 migrations em um banco vazio | 1 s |
| `bun run migration:down` | Reverte **uma** migration por execução | 1 migration | 1 s |
| `bun run infra:queues` | Cria as filas (pode ser repetido) | 3 filas | 1 s |
| `bun run start` | Sobe a aplicação | | |

Para rodar uma semente do teste de invariantes aleatórias:

```bash
INVARIANT_SEED=202 INVARIANT_OPS=150 bun test test/concurrency/random-invariants.test.ts   # 2 testes, 10 s
```

### Ambiente em que foi testado

Medido em 2026-11-25, uma execução por comando (os tempos variam entre execuções):

| Item | Valor |
| --- | --- |
| Sistema operacional | Windows 11 Pro (10.0.26300), x64 |
| Máquina | AMD Ryzen 7 5700X (16 processadores lógicos), 32 GB de RAM |
| Docker | Docker Desktop 29.9.2, Compose v5.6.1; VM com 2 CPUs e cerca de 3,8 GB |
| Bun | 1.4.4 |
| Imagens | `postgres:16-alpine` (16.16), `ministackorg/ministack:1.5.44` |

**Linux e macOS não foram verificados.**

## Visão do sistema

### Arquitetura

Tudo roda em um único processo, que pode ter várias instâncias. HTTP e fila entram no mesmo `ProcessWagerTransactionUseCase`; o worker e o publisher são laços de fundo que dividem o trabalho entre instâncias por lease com `SKIP LOCKED`. O PostgreSQL é a única fonte de verdade.

```mermaid
flowchart LR
    provider["Provedor"]
    producer["Produtor interno: scripts/send-wager-message.ts"]
    scraper["Orquestrador e coletor de métricas"]
    inqueue[/"SQS FIFO: wager-transactions.fifo"/]

    subgraph app["Aplicação NestJS sob Bun"]
        guard["Guards globais: AuthGuard no-op e JsonOnlyGuard"]
        api["Controllers de wallets e transações"]
        consumer["QueueConsumer e WagerMessageHandler"]
        usecase["ProcessWagerTransactionUseCase"]
        reconcile["ReconcileWalletUseCase"]
        worker["Worker de PENDING_REFERENCE: ReprocessPendingReferencesUseCase"]
        publisher["Publisher do outbox: PublishOutboxUseCase"]
        obs["Metrics e logs JSON no stdout"]
        open["Rotas abertas: /health/live, /health/ready, /metrics (o readiness consulta o PostgreSQL e as filas de entrada e de eventos)"]
    end

    db[("PostgreSQL: wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages")]
    events[/"SQS padrão: wager-events"/]
    dlq[/"DLQ FIFO: wager-transactions-dlq.fifo"/]

    provider -->|"HTTP"| guard
    guard -->|"requisição aceita"| api
    api -->|"POST /wagering/transactions"| usecase
    api -->|"POST /wallets/:walletId/reconciliation"| reconcile
    api -->|"wallets, ledger e consultas"| db
    producer -->|"WagerTransactionRequested"| inqueue
    inqueue -->|"long polling"| consumer
    consumer -->|"mesmo caso de uso, com inbox"| usecase
    consumer -->|"ack, só depois do commit"| inqueue
    consumer -->|"falha permanente, com FailureReason"| dlq
    inqueue -->|"redrive após 5 recebimentos"| dlq
    usecase -->|"uma transação SQL"| db
    reconcile -->|"somente leitura: saldo e soma do ledger"| db
    db -->|"claim das pendências vencidas"| worker
    worker -->|"liquida, travando a wallet primeiro"| db
    db -->|"claim de eventos commitados"| publisher
    publisher -->|"SendMessage"| events
    publisher -->|"grava published_at"| db
    usecase -->|"relatório, depois do commit"| obs
    consumer -->|"DLQ, retries e logs"| obs
    reconcile -->|"resultado e divergência"| obs
    scraper -->|"GET, sem autenticação"| open
    obs -->|"conteúdo de GET /metrics"| open
```

### Fluxo de uma aposta

Uma `BET` por HTTP. O replay de uma chave conhecida responde sem travar a wallet. Em uma chave nova, a primeira instrução que toca a wallet é o `FOR NO KEY UPDATE` (antes dele só há o `lock_timeout` da transação e, na entrada por fila, o `INSERT` no inbox, que não tocam a wallet). Transação, ledger, saldo e outbox entram no mesmo commit, e o publisher só enxerga o que foi commitado.

```mermaid
sequenceDiagram
    autonumber
    participant P as Provedor
    participant API as API HTTP
    participant UC as Caso de uso
    participant DB as PostgreSQL
    participant OB as Tabela outbox_messages
    participant PUB as Publisher
    participant Q as SQS wager-events

    P->>API: POST /wagering/transactions com Idempotency-Key
    API->>API: guards, validação do corpo e cabeçalhos, identidade do provedor
    API->>UC: execute
    UC->>UC: payloadHash, SHA-256 dos campos de negócio
    UC->>DB: busca por provider_id e idempotency_key, sem lock

    alt chave conhecida com o mesmo payloadHash
        UC-->>API: transação gravada, idempotentReplay true
        API-->>P: status HTTP do resultado gravado
    else chave conhecida com outro payloadHash
        UC-->>API: IdempotencyConflictError
        API-->>P: 409 IDEMPOTENCY_CONFLICT
    else chave nova
        UC->>DB: BEGIN e lock_timeout da transação
        UC->>DB: SELECT da wallet FOR NO KEY UPDATE
        DB-->>UC: wallet travada
        UC->>UC: domínio decide com o saldo travado
        alt saldo insuficiente
            UC->>DB: INSERT wager_transactions REJECTED, ON CONFLICT DO NOTHING
            UC->>OB: INSERT WagerTransactionRejected
            UC->>DB: COMMIT
            UC-->>API: REJECTED, INSUFFICIENT_BALANCE
            API-->>P: 422
        else sucesso
            UC->>DB: INSERT wager_transactions PROCESSED, ON CONFLICT DO NOTHING
            UC->>DB: UPDATE wallets, saldo e version
            UC->>DB: INSERT wallet_ledger_entries
            UC->>OB: INSERT WagerTransactionProcessed e WalletBalanceChanged
            UC->>DB: COMMIT
            UC-->>API: PROCESSED
            API-->>P: 201
        end
    end

    Note over UC,DB: Se outro commit levar a mesma chave antes, o INSERT não grava e a resposta vira replay ou 409

    loop laço de fundo, independente da requisição
        PUB->>OB: claim por lease com SKIP LOCKED, só linhas commitadas
        OB-->>PUB: eventos não publicados e vencidos
        PUB->>Q: SendMessage com eventId e eventType
        PUB->>OB: UPDATE published_at
    end
```

### Estados de WagerTransaction

A transação nasce `PENDING` no domínio e é gravada uma única vez, já em `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`: a aplicação não persiste `PENDING`. A transição `fail` existe no domínio, mas nenhum caminho atual a chama. `PROCESSED`, `REJECTED` e `FAILED` são terminais, e o trigger `wager_transactions_guard` recusa qualquer alteração deles.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> PENDING : create
    PENDING --> PROCESSED : markProcessed
    PENDING --> REJECTED : reject
    PENDING --> PENDING_REFERENCE : markPendingReference
    PENDING --> FAILED : fail
    PENDING_REFERENCE --> PENDING_REFERENCE : reagenda
    PENDING_REFERENCE --> PROCESSED : markProcessed
    PENDING_REFERENCE --> REJECTED : reject
    PENDING_REFERENCE --> FAILED : fail
    PROCESSED --> [*]
    REJECTED --> [*]
    FAILED --> [*]
```

## Exemplos com curl

Comandos em bash, executados contra a aplicação local com um banco recém-migrado. As respostas abaixo são as reais; ids e datas serão diferentes na sua execução. Cada resposta HTTP vem seguida do status, impresso pelo `-w`.

### Criar uma wallet

```bash
BASE=http://localhost:3000
PLAYER_ID=3f2b7c1e-8a4d-4b9e-9c21-5d6f0a1b2c3d

curl -s -w '\nHTTP %{http_code}\n' -X POST $BASE/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"'$PLAYER_ID'","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

```
{"id":"949a4d2c-dead-453f-b4c3-36fbbac881bf","playerId":"3f2b7c1e-8a4d-4b9e-9c21-5d6f0a1b2c3d","balance":{"amount":"100.00","currency":"BRL"},"version":1}
HTTP 201
```

Há uma wallet por player e moeda: para repetir o roteiro no mesmo banco, troque o `PLAYER_ID`.

### BET com Idempotency-Key

```bash
WALLET_ID=949a4d2c-dead-453f-b4c3-36fbbac881bf   # use o "id" da sua resposta

BET='{"providerId":"provider-a","externalTransactionId":"bet-001","playerId":"'$PLAYER_ID'","walletId":"'$WALLET_ID'","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
bet() { curl -s -w '\nHTTP %{http_code}\n' -X POST $BASE/wagering/transactions -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:bet-001' -d "$1"; }

bet "$BET"
```

```
{"transactionId":"be935f1f-15ad-4d95-82d4-65734d8d10b5","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}
HTTP 201
```

### Reenvio (replay) e conflito

O mesmo corpo com a mesma chave devolve o resultado gravado, sem debitar de novo:

```bash
bet "$BET"
```

```
{"transactionId":"be935f1f-15ad-4d95-82d4-65734d8d10b5","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":true}
HTTP 201
```

A mesma chave com outro valor é conflito:

```bash
bet "${BET/25.00/30.00}"
```

```
{"code":"IDEMPOTENCY_CONFLICT","message":"Conflito de idempotência: a chave ou a identidade do provedor já pertence a outro payload"}
HTTP 409
```

### Consultar a transação

```bash
TX_ID=be935f1f-15ad-4d95-82d4-65734d8d10b5   # use o "transactionId" da sua resposta

curl -s -w '\nHTTP %{http_code}\n' $BASE/wagering/transactions/$TX_ID
```

```
{"transactionId":"be935f1f-15ad-4d95-82d4-65734d8d10b5","providerId":"provider-a","externalTransactionId":"bet-001","walletId":"949a4d2c-dead-453f-b4c3-36fbbac881bf","playerId":"3f2b7c1e-8a4d-4b9e-9c21-5d6f0a1b2c3d","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"status":"PROCESSED","failureCode":null,"balance":{"amount":"75.00","currency":"BRL"},"createdAt":"2026-11-25T18:54:35.024Z","processedAt":"2026-11-25T18:54:35.024Z"}
HTTP 200
```

Também pela identidade no provedor:

```bash
curl -s -w '\nHTTP %{http_code}\n' $BASE/providers/provider-a/wagering/transactions/bet-001
```

```
{"transactionId":"be935f1f-15ad-4d95-82d4-65734d8d10b5","providerId":"provider-a","externalTransactionId":"bet-001","walletId":"949a4d2c-dead-453f-b4c3-36fbbac881bf","playerId":"3f2b7c1e-8a4d-4b9e-9c21-5d6f0a1b2c3d","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"status":"PROCESSED","failureCode":null,"balance":{"amount":"75.00","currency":"BRL"},"createdAt":"2026-11-25T18:54:35.024Z","processedAt":"2026-11-25T18:54:35.024Z"}
HTTP 200
```

### Ledger

O primeiro lançamento é o crédito de abertura da wallet. A paginação usa `limit` e `cursor` (o `nextCursor` da página anterior).

```bash
curl -s -w '\nHTTP %{http_code}\n' "$BASE/wallets/$WALLET_ID/ledger?limit=10"
```

```
{"items":[{"id":"3f3adf0b-907b-44ae-816e-c72e7f4f6f54","transactionId":"27d21faf-2b62-43df-b1aa-bce362445137","direction":"CREDIT","money":{"amount":"100.00","currency":"BRL"},"balanceBefore":{"amount":"0.00","currency":"BRL"},"balanceAfter":{"amount":"100.00","currency":"BRL"},"createdAt":"2026-11-25T18:54:34.481Z"},{"id":"42dd2c0e-176e-40fe-a588-0853437be2eb","transactionId":"be935f1f-15ad-4d95-82d4-65734d8d10b5","direction":"DEBIT","money":{"amount":"25.00","currency":"BRL"},"balanceBefore":{"amount":"100.00","currency":"BRL"},"balanceAfter":{"amount":"75.00","currency":"BRL"},"createdAt":"2026-11-25T18:54:35.024Z"}],"nextCursor":null}
HTTP 200
```

### Reconciliação

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST $BASE/wallets/$WALLET_ID/reconciliation
```

```
{"walletId":"949a4d2c-dead-453f-b4c3-36fbbac881bf","storedBalance":{"amount":"75.00","currency":"BRL"},"calculatedBalance":{"amount":"75.00","currency":"BRL"},"difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":2}
HTTP 200
```

### Health

```bash
curl -s -w '\nHTTP %{http_code}\n' $BASE/health/live
curl -s -w '\nHTTP %{http_code}\n' $BASE/health/ready
```

```
{"status":"ok"}
HTTP 200
{"status":"ok","checks":{"postgres":"up","sqs":"up"}}
HTTP 200
```

### Enviar pela fila SQS

Um `WIN` que referencia a `BET`, publicado em `wager-transactions.fifo`. Sem `--message-id` e `--idempotency-key`, o script gera o `messageId` e usa `{providerId}:{externalTransactionId}` como chave.

```bash
bun run scripts/send-wager-message.ts --wallet-id $WALLET_ID --player-id $PLAYER_ID --provider-id provider-a \
  --external-transaction-id win-001 --round-id round-1 --game-id game-1 --kind WIN --amount 40.00 --currency BRL --reference bet-001
```

```
{"messageId":"c383e2f7-d984-4a40-a052-780e2643c966","externalTransactionId":"win-001"}
```

O processamento é assíncrono; alguns segundos depois:

```bash
curl -s -w '\nHTTP %{http_code}\n' $BASE/providers/provider-a/wagering/transactions/win-001
curl -s -w '\nHTTP %{http_code}\n' $BASE/wallets/$WALLET_ID
```

```
{"transactionId":"d1a99407-d56b-4367-a512-5ad1981ac858","providerId":"provider-a","externalTransactionId":"win-001","walletId":"949a4d2c-dead-453f-b4c3-36fbbac881bf","playerId":"3f2b7c1e-8a4d-4b9e-9c21-5d6f0a1b2c3d","roundId":"round-1","gameId":"game-1","kind":"WIN","money":{"amount":"40.00","currency":"BRL"},"status":"PROCESSED","failureCode":null,"balance":{"amount":"115.00","currency":"BRL"},"createdAt":"2026-11-25T18:54:36.458Z","processedAt":"2026-11-25T18:54:36.458Z"}
HTTP 200
{"id":"949a4d2c-dead-453f-b4c3-36fbbac881bf","playerId":"3f2b7c1e-8a4d-4b9e-9c21-5d6f0a1b2c3d","balance":{"amount":"115.00","currency":"BRL"},"version":3}
HTTP 200
```

### Métricas

Formato texto do Prometheus. O filtro abaixo omite os comentários e os buckets dos histogramas:

```bash
curl -s $BASE/metrics | grep -E '^(wager_|outbox_)' | grep -v _bucket
```

```
wager_transactions_total{status="PROCESSED",kind="BET"} 1
wager_transactions_total{status="PROCESSED",kind="WIN"} 1
wager_duplicates_total 1
wager_dlq_messages_total 0
wager_lock_conflicts_total 0
wager_wallet_lock_wait_seconds_sum 0.001492899999999736
wager_wallet_lock_wait_seconds_count 2
wager_processing_duration_seconds_sum 0.05496469999999999
wager_processing_duration_seconds_count 3
wager_reconciliation_divergence_total 0
wager_outbox_lag_seconds 0
```

## Autenticação

`/health/live`, `/health/ready` e `/metrics` são rotas abertas. As demais passam por um guard global que **hoje é no-op**: nada é autenticado nem autorizado, e quem alcança a porta HTTP (ou publica na fila de entrada) opera como qualquer provedor. O serviço não deve ser exposto fora de uma rede confiável. A decisão, o desenho que seria adotado e o ponto de extensão no código estão em [Autenticação](docs/ARCHITECTURE.md#autenticação), no documento de arquitetura.

## Mapa de garantias

Cada garantia e a seção de [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) que a explica.

| Garantia | Seção |
| --- | --- |
| Visão de todas as garantias, com o mecanismo e o teste que prova cada uma | [Garantias e como são provadas](docs/ARCHITECTURE.md#garantias-e-como-são-provadas) |
| Dinheiro nunca passa por ponto flutuante | [Mapeamento do Money](docs/ARCHITECTURE.md#mapeamento-do-money) |
| Saldo correto sob concorrência: lock por wallet e ordem global de locks | [Estratégia transacional e de locks](docs/ARCHITECTURE.md#estratégia-transacional-e-de-locks) |
| Idempotência no banco: replay e conflito separados pelo `payloadHash` | [Idempotência e payloadHash](docs/ARCHITECTURE.md#idempotência-e-payloadhash) |
| Estados terminais não mudam | [Máquina de estados de WagerTransaction](docs/ARCHITECTURE.md#máquina-de-estados-de-wagertransaction) |
| Rejeições auditáveis, com código estável | [Códigos de falha](docs/ARCHITECTURE.md#códigos-de-falha) |
| Referência que chega depois, com limite de espera | [Limite do PENDING_REFERENCE](docs/ARCHITECTURE.md#limite-do-pending_reference) |
| Mensagem repetida não reprocessa | [Inbox e idempotência são camadas diferentes](docs/ARCHITECTURE.md#inbox-e-idempotência-são-camadas-diferentes) |
| Falha transitória volta à fila; permanente vai à DLQ | [Classificação de erros](docs/ARCHITECTURE.md#classificação-de-erros) |
| Entrega dos eventos: at-least-once, sem ordem | [O que é e o que não é garantido ao consumidor dos eventos](docs/ARCHITECTURE.md#o-que-é-e-o-que-não-é-garantido-ao-consumidor-dos-eventos) |
| Divergência entre saldo e ledger é reportada, nunca corrigida | [Reconciliação](docs/ARCHITECTURE.md#reconciliação-post-walletswalletidreconciliation) |

## Testes e evidências

Os testes de integração, concorrência, segurança e carga usam PostgreSQL e MiniStack reais, sem mock de nenhum dos dois.

| Suíte | O que prova | Números |
| --- | --- | --- |
| Unidade (`bun run check`) | `Money`, invariantes da `Wallet`, regras de cada tipo de transação, `payloadHash`, classificação de erros; uma regra de lint proíbe `number` para dinheiro | 473 testes, 0 falhas |
| Integração (`bun run test:integration`) | Migrations, constraints e triggers, atomicidade entre wallet, ledger, inbox e outbox, inbox, retry, DLQ e recuperação | 443 testes, 0 falhas |
| Concorrência (`bun run test:concurrency`) | A mesma `BET` 50 vezes em paralelo gera 1 débito; 30 apostas de 10,00 sobre saldo 100,00 processam exatamente 10; 3 processos simultâneos; processo morto entre o commit e o ack | 32 testes, 0 falhas |
| Invariantes aleatórias (dentro da suíte de concorrência) | Sequências geradas por semente (`101`, `202` e `303`, 150 operações em cada execução, sequencial e concorrente), comparadas com um modelo de referência e com consultas sobre o banco inteiro. Na falha, o teste imprime a semente e reduz a sequência | Ver [Invariantes sob operações aleatórias](docs/ARCHITECTURE.md#invariantes-sob-operações-aleatórias) |
| Segurança (`bun run test:security`) | Injeção, abuso de valores e de protocolo, idempotência entre provedores, gasto duplo, vazamento, mensagens venenosas, disponibilidade e segredos. Não é um pentest | 92 casos: 78 passaram, 14 confirmam limitações, 0 falharam |
| Carga (`bun run test:load`) | Latência, vazão e atraso do outbox em uma máquina, com invariantes conferidas ao fim de cada cenário. Não mede capacidade de produção | 535,38 req/s com 100 wallets contra 123,59 req/s em uma única wallet (p50 de 58,59 contra 256,88 ms); invariantes passaram em todos os cenários |

Detalhes:

- [Cobertura dos testes obrigatórios](docs/ARCHITECTURE.md#cobertura-dos-testes-obrigatórios): cada item e o arquivo e teste que o prova.
- [docs/LOAD_TEST.md](docs/LOAD_TEST.md): metodologia, resultados, análise e limitações da carga.
- [docs/SECURITY_TESTS.md](docs/SECURITY_TESTS.md): casos, achados e o que não foi coberto.

## Estrutura de pastas

```
.
├── src/
│   ├── domain/              # TypeScript puro: Money, Wallet, WagerTransaction, ledger, regras e eventos
│   ├── application/         # casos de uso, portas e payloadHash
│   ├── infrastructure/
│   │   ├── persistence/     # entidades MikroORM, mappers, repositórios e unit of work
│   │   ├── messaging/       # cliente e adaptadores SQS, configuração do consumidor e do publisher
│   │   ├── workers/         # laço de fundo dos workers
│   │   ├── observability/   # métricas e logs JSON
│   │   ├── health/          # verificações de readiness
│   │   └── identity/        # adaptador da identidade do provedor (hoje confia no corpo)
│   ├── interface/
│   │   ├── http/            # controllers, DTOs, guards e mapeamento de erros
│   │   └── sqs/             # consumidor e tradução das mensagens
│   ├── app.module.ts        # composição
│   └── main.ts              # sobe o HTTP, o consumidor, o worker e o publisher
├── db/                      # SQL das migrations (up e down) e as classes em db/migrations/
├── scripts/                 # filas, migrations, envio de mensagem, carga e segurança
├── test/
│   ├── unit/
│   ├── integration/
│   ├── concurrency/
│   ├── security/
│   └── support/             # apoio dos testes, inclusive o gerador de invariantes aleatórias
├── docs/                    # arquitetura, teste de carga e testes de segurança
├── docker-compose.yml       # PostgreSQL e MiniStack
└── .env.example
```

## Limitações conhecidas

A lista completa, com justificativas e trade-offs, está em [Limitações conhecidas](docs/ARCHITECTURE.md#limitações-conhecidas).

1. **Sem autenticação nem autorização**, e sem rate limiting; `/metrics` e health são abertos.
2. **Wallet quente:** escritas na mesma wallet são serializadas. O `lock_timeout` limita cada espera por lock, não a espera total na fila, e não há `statement_timeout`.
3. **Pool de conexões:** requisições suficientes contra uma wallet travada ocupam as conexões da instância, atrasam as outras wallets e fazem `/health/ready` responder `503`.
4. **Eventos:** entrega at-least-once e sem ordem (o consumidor deduplica por `eventId` e ordena o saldo por `walletVersion`); no teste de carga, o publisher publicou mais devagar do que os eventos eram gravados.
5. **Fila de entrada:** não é autenticada, e o inbox deduplica por `(consumidor, messageId)`, não por provedor: os produtores precisam de ids únicos entre si.
6. **MiniStack não é o SQS da AWS:** o comportamento de FIFO, DLQ, latência e cotas não foi verificado na AWS.
7. **Reversões:** não há reversão parcial; uma referência que não chega dentro do limite de tentativas vira `REJECTED`.
8. **Execução:** não há Dockerfile da aplicação, e o projeto só foi executado em Windows 11.

## Solução de problemas

### `/health/ready` responde 503 com `"sqs":"down"` depois de reiniciar os containers

O MiniStack perde as filas ao reiniciar. A aplicação registra `"errorName":"QueueDoesNotExist"` no log. Recrie-as; não é preciso reiniciar a aplicação:

```bash
bun run infra:queues
```

Os testes de integração também falham no readiness enquanto as filas não existirem.

### Porta em uso

Com a porta 3000 ocupada, a aplicação encerra com `"Failed to start server. Is port 3000 in use?"` e `"errorCode":"EADDRINUSE"`. Encerre o outro processo ou use outra porta (e ajuste a URL dos exemplos):

```bash
PORT=3001 bun run start
```

As portas 5432 e 4566 são fixas no `docker-compose.yml`: se um PostgreSQL local ou os containers de outra cópia do projeto as estiverem usando, pare-os antes do `docker compose up`.

### Migration já aplicada

Rodar `bun run migration:up` de novo é seguro e não altera nada:

```
up: 0 migration(s) executada(s)
```

### `migration:down` recusa a reversão

A reversão que devolve a unicidade global da `Idempotency-Key` só é possível enquanto nenhuma chave tiver sido usada por mais de um provedor. Depois disso, ela falha e nada muda, porque transações não se apagam nem se reescrevem:

```
UniqueConstraintViolationException: 002 down: 1 idempotency_key(s) usada(s) por mais de um provedor; a unicidade global não pode ser restaurada
```

Em um ambiente descartável, a saída é recriar o banco.

## Como este projeto foi desenvolvido

Este projeto foi desenvolvido pelo autor, que definiu o escopo, tomou as decisões de arquitetura, validou cada etapa e conduziu as revisões. Para isso usou ferramentas de IA: Claude (Anthropic) como apoio ao planejamento, à especificação e à revisão; Claude Code para escrever o código a partir das especificações e critérios de aceite do autor; e Codex (OpenAI) para uma revisão independente, em modo somente leitura. Cada etapa só entrou depois de passar por `bun run check` e pelas suítes de integração e concorrência, e os problemas achados na revisão foram reproduzidos com teste e corrigidos. O autor responde pelas decisões e pelo resultado.
