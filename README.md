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
