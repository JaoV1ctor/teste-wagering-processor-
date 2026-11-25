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
