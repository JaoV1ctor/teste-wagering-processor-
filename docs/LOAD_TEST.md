# Teste de carga

Experimento para observar o comportamento do serviço sob carga **numa única máquina de desenvolvimento**. Não há meta de requisições por segundo, e os números não valem como capacidade de produção: o que eles mostram são os limites relativos entre os caminhos e se as invariantes se mantêm. Ver [Limitações](#limitações).

## Como rodar

```bash
docker compose up -d
bun run test:load            # execução completa: cerca de 3 min 15 s na máquina descrita abaixo
bun run test:load --smoke    # verificação rápida (cerca de 25 s); os números não servem para análise
```

O comando usa o `.env`, recusa `DATABASE_URL` e `AWS_ENDPOINT_URL` que não sejam locais, cria um banco e filas próprios por cenário e os apaga no fim. Grava `report.md`, `results.json` e o stderr das instâncias em `load-results/<execução>/` (ignorado pelo git) e sai com código 1 se alguma invariante falhar.

| Variável | Padrão | `--smoke` | Significado |
| --- | --- | --- | --- |
| `LOAD_PROFILE` | `default` | `smoke` | Perfil base (`--smoke` equivale a `smoke`) |
| `LOAD_SCENARIOS` | `A,B,C,D` | `A,B,C,D` | Cenários a executar |
| `LOAD_WALLETS` | 100 | 5 | Wallets de A, C e D (B usa uma por repetição) |
| `LOAD_REQUESTS` | 1000 | 60 | Requisições ou mensagens medidas por repetição |
| `LOAD_WARMUP_REQUESTS` | 500 | 10 | Aquecimento, descartado |
| `LOAD_CONCURRENCY` | 32 | 8 | Requisições HTTP em voo |
| `LOAD_REPLAY_PERCENT` | 30 | 30 | Cenário D: porcentagem de reenvios |
| `LOAD_REPETITIONS` | 3 | 1 | Repetições medidas |
| `LOAD_INSTANCES` | 2 | 1 | Processos da aplicação |
| `LOAD_SEED` | 1 | 1 | Semente do plano de envios |

Variáveis da aplicação (`LOCK_TIMEOUT_MS`, `SQS_*`, `OUTBOX_*`) são herdadas pelas instâncias e aparecem no relatório quando definidas.

## Metodologia

- **Alvo:** processos reais (`bun run src/main.ts`), cada um com HTTP, consumidor SQS, worker de `PENDING_REFERENCE` e publisher do outbox, sobre o PostgreSQL e o MiniStack do `docker-compose.yml`. Nada é mockado.
- **Gerador:** um processo Bun (`scripts/load/`), sem dependências novas. HTTP em **laço fechado**: há sempre `LOAD_CONCURRENCY` requisições em voo, distribuídas em rodízio entre as instâncias.
- **Latência:** `Bun.nanoseconds()`, do envio até o corpo lido. Percentis por posto mais próximo (*nearest-rank*) sobre **todas** as amostras da repetição.
- **Repetições:** um aquecimento descartado e três repetições por cenário. As tabelas mostram cada uma, a mediana, o mínimo, o máximo e a amplitude em porcentagem da mediana. Entre repetições o publisher esvazia o outbox.
- **Cenários:**
  - **A, distribuído:** 100 wallets; `BET` 55%, `WIN` 25%, `LOSS` 10%, `REFUND` 10% (o `REFUND` reverte uma `BET` já confirmada; sem nenhuma disponível, vira `BET`).
  - **B, hot wallet:** a mesma mistura, com todas as requisições na mesma wallet.
  - **C, mensageria:** a fila é enchida **sem consumidor** (`SendMessageBatch`, `MessageGroupId` = `walletId` em minúsculas); depois as instâncias sobem. A vazão é `(n - 1) / (último processed_at - primeiro processed_at)`. Cada repetição usa filas de entrada novas e, por isso, processos recém-iniciados. Não há latência por requisição neste cenário.
  - **D, duplicatas:** 30% dos envios repetem uma operação (mesma `Idempotency-Key` e corpo), pouco depois do original: parte com ele ainda em voo.
- **Outbox:** lag é `published_at - occurred_at` de cada evento criado na repetição. "Publicados por segundo" vai da primeira à última publicação, somadas as instâncias.
- **Concorrência:** contadores de `/metrics` de todas as instâncias (diferença entre antes e depois) e `deadlocks` de `pg_stat_database`. A métrica de conflitos soma `40P01`, `40001` e `55P03`; não os separa.
- **Invariantes (ao fim de cada cenário, sobre todas as wallets dele):** reconciliação pela API e por SQL; nenhum saldo negativo; nenhuma chave ou identidade repetida; um lançamento por movimento processado; toda chave aceita gravada; todo evento do outbox recebido na fila; e, **depois de deduplicar por `eventId`** como um consumidor faria, nenhum fato repetido (mesmo tipo e transação, ou mesma `walletVersion`). A taxa de duplicatas brutas é informada à parte: acima de zero é permitido (entrega *at-least-once*).

**As invariantes detectam violação?** Em uma execução à parte, com um saldo inflado por SQL e um evento republicado com outro `eventId`, quatro verificações falharam e o comando saiu com código 1. A alteração foi desfeita em seguida e não está no repositório. Essa execução foi feita numa versão anterior e não foi repetida junto com os resultados abaixo.

## Resultados da execução de referência

Copiado do `report.md` gerado, sem edição.

Execução iniciada em 2026-11-25T18:40:11.463Z, duração total 194.47 s.

### Ambiente

| Item | Valor |
| --- | --- |
| Sistema operacional | Windows 11 Pro (10.0.26300), x64 |
| CPU | AMD Ryzen 7 5700X 8-Core Processor, 16 processadores lógicos |
| RAM da máquina | 31.93 GiB |
| VM do Docker (CPUs, memória em bytes) | 2 CPUs, 4107382784 bytes, Docker Desktop 29.9.2 |
| Bun | 1.4.4 |
| PostgreSQL | PostgreSQL 16.16 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit |
| Configuração do PostgreSQL | fsync=on, max_connections=300, shared_buffers=128MB, synchronous_commit=on, work_mem=4MB |
| Imagens do docker-compose.yml (sem limite de CPU ou memória por container) | postgres:16-alpine, ministackorg/ministack:1.5.44 |
| Configuração da aplicação sobrescrita por variável de ambiente | nenhuma: padrões do código |
| Commit medido | cb549d5 |

### Parâmetros

| Parâmetro | Valor |
| --- | --- |
| `profile` | default |
| `scenarios` | A, B, C, D |
| `wallets` | 100 |
| `requests` | 1000 |
| `warmupRequests` | 500 |
| `concurrency` | 32 |
| `replayPercent` | 30 |
| `repetitions` | 3 |
| `instances` | 2 |
| `seed` | 1 |

### Cenário A. Distribuído: muitas wallets, BET/WIN/LOSS/REFUND por HTTP

#### Vazão e latência

| Repetição | Requisições | Duração (s) | req/s | Latência p50 (ms) | Latência p95 (ms) | Latência p99 (ms) | Latência max (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1000 | 1.87 | 535.38 | 58.59 | 87.56 | 101.68 | 133.06 |
| 2 | 1000 | 1.79 | 557.39 | 55.33 | 83.55 | 98.67 | 131.28 |
| 3 | 1000 | 2.16 | 462.88 | 63.20 | 131.46 | 179.77 | 224.04 |
| **mediana** | 1000 | 1.87 | 535.38 | 58.59 | 87.56 | 101.68 | 133.06 |
| mínimo | 1000 | 1.79 | 462.88 | 55.33 | 83.55 | 98.67 | 131.28 |
| máximo | 1000 | 2.16 | 557.39 | 63.20 | 131.46 | 179.77 | 224.04 |
| amplitude / mediana (%) | 0.00 | 19.61 | 17.65 | 13.43 | 54.72 | 79.76 | 69.72 |

#### Respostas por status

| Repetição | 201 | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 543, LOSS 88, REFUND 95, WIN 274 |
| 2 | 1000 | 0.00% | BET 567, LOSS 94, REFUND 97, WIN 242 |
| 3 | 1000 | 0.00% | BET 565, LOSS 100, REFUND 101, WIN 234 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 4.08 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 4.11 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 4.94 |
| **mediana** | 0 | 0 | 0 | 0 | 0 | 0 | 4.11 |
| mínimo | 0 | 0 | 0 | 0 | 0 | 0 | 4.08 |
| máximo | 0 | 0 | 0 | 0 | 0 | 0 | 4.94 |
| amplitude / mediana (%) | — | — | — | — | — | — | 20.95 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1912 | 3910.00 | 6047.00 | 6288.00 | 256.68 | 6.36 |
| 2 | 1906 | 3841.00 | 5768.00 | 6001.00 | 276.73 | 6.06 |
| 3 | 1900 | 3825.00 | 5781.00 | 6054.00 | 261.53 | 6.09 |
| **mediana** | 1906 | 3841.00 | 5781.00 | 6054.00 | 261.53 | 6.09 |
| mínimo | 1900 | 3825.00 | 5768.00 | 6001.00 | 256.68 | 6.06 |
| máximo | 1912 | 3910.00 | 6047.00 | 6288.00 | 276.73 | 6.36 |
| amplitude / mediana (%) | 0.63 | 2.21 | 4.83 | 4.74 | 7.66 | 4.90 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 100 | 100 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação no mesmo provedor | 0 | 0 |
| identidades (provedor, id externo) repetidas | 0 | 0 |
| transações com mais de um lançamento | 0 | 0 |
| movimentos PROCESSED sem lançamento | 0 | 0 |
| lançamentos de transação não processada ou de LOSS | 0 | 0 |
| chaves aceitas que não estão gravadas | 0 | 0 |
| eventos do outbox que não chegaram à fila | 0 | 0 |
| eventos recebidos que não estão no outbox | 0 | 0 |
| fatos repetidos depois de deduplicar por eventId | 0 | 0 |

Eventos: 6873 no outbox; 6873 entregas recebidas da fila; 6873 eventIds distintos; duplicatas brutas: 0 (0.00% das entregas).

### Cenário B. Hot wallet: todas as requisições na mesma wallet

#### Vazão e latência

| Repetição | Requisições | Duração (s) | req/s | Latência p50 (ms) | Latência p95 (ms) | Latência p99 (ms) | Latência max (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1000 | 8.30 | 120.52 | 267.96 | 518.03 | 551.92 | 618.27 |
| 2 | 1000 | 8.09 | 123.59 | 256.88 | 503.24 | 577.97 | 756.04 |
| 3 | 1000 | 8.07 | 123.94 | 244.99 | 513.14 | 572.06 | 721.93 |
| **mediana** | 1000 | 8.09 | 123.59 | 256.88 | 513.14 | 572.06 | 721.93 |
| mínimo | 1000 | 8.07 | 120.52 | 244.99 | 503.24 | 551.92 | 618.27 |
| máximo | 1000 | 8.30 | 123.94 | 267.96 | 518.03 | 577.97 | 756.04 |
| amplitude / mediana (%) | 0.00 | 2.83 | 2.77 | 8.94 | 2.88 | 4.55 | 19.08 |

#### Respostas por status

| Repetição | 201 | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 543, LOSS 88, REFUND 95, WIN 274 |
| 2 | 1000 | 0.00% | BET 567, LOSS 94, REFUND 97, WIN 242 |
| 3 | 1000 | 0.00% | BET 565, LOSS 100, REFUND 101, WIN 234 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 116.73 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 116.38 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 111.74 |
| **mediana** | 0 | 0 | 0 | 0 | 0 | 0 | 116.38 |
| mínimo | 0 | 0 | 0 | 0 | 0 | 0 | 111.74 |
| máximo | 0 | 0 | 0 | 0 | 0 | 0 | 116.73 |
| amplitude / mediana (%) | — | — | — | — | — | — | 4.29 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1912 | 3586.00 | 4269.00 | 7829.00 | 168.49 | 3.37 |
| 2 | 1906 | 3325.00 | 4090.00 | 7797.00 | 172.09 | 3.09 |
| 3 | 1900 | 3352.00 | 4007.00 | 7690.00 | 173.85 | 3.10 |
| **mediana** | 1906 | 3352.00 | 4090.00 | 7797.00 | 172.09 | 3.10 |
| mínimo | 1900 | 3325.00 | 4007.00 | 7690.00 | 168.49 | 3.09 |
| máximo | 1912 | 3586.00 | 4269.00 | 7829.00 | 173.85 | 3.37 |
| amplitude / mediana (%) | 0.63 | 7.79 | 6.41 | 1.78 | 3.12 | 9.09 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 4 | 4 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação no mesmo provedor | 0 | 0 |
| identidades (provedor, id externo) repetidas | 0 | 0 |
| transações com mais de um lançamento | 0 | 0 |
| movimentos PROCESSED sem lançamento | 0 | 0 |
| lançamentos de transação não processada ou de LOSS | 0 | 0 |
| chaves aceitas que não estão gravadas | 0 | 0 |
| eventos do outbox que não chegaram à fila | 0 | 0 |
| eventos recebidos que não estão no outbox | 0 | 0 |
| fatos repetidos depois de deduplicar por eventId | 0 | 0 |

Eventos: 6681 no outbox; 6681 entregas recebidas da fila; 6681 eventIds distintos; duplicatas brutas: 0 (0.00% das entregas).

### Cenário C. Mensageria: drenagem de um lote de mensagens SQS

#### Vazão e drenagem

| Repetição | Mensagens | Enfileiramento (s) | Drenagem: 1º ao último processamento (s) | Início da subida das instâncias até o fim (s) | msg/s | Processamento médio por mensagem (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1000 | 0.22 | 4.20 | 4.87 | 237.74 | 24.97 |
| 2 | 1000 | 0.13 | 4.71 | 5.57 | 212.15 | 27.90 |
| 3 | 1000 | 0.13 | 4.19 | 4.88 | 238.48 | 25.07 |
| **mediana** | 1000 | 0.13 | 4.20 | 4.88 | 237.74 | 25.07 |
| mínimo | 1000 | 0.13 | 4.19 | 4.87 | 212.15 | 24.97 |
| máximo | 1000 | 0.22 | 4.71 | 5.57 | 238.48 | 27.90 |
| amplitude / mediana (%) | 0.00 | 71.90 | 12.38 | 14.47 | 11.08 | 11.72 |

#### Estado final das transações

| Repetição | PROCESSED | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 611, LOSS 87, WIN 302 |
| 2 | 1000 | 0.00% | BET 585, LOSS 112, WIN 303 |
| 3 | 1000 | 0.00% | BET 610, LOSS 82, WIN 308 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | — | 0 | 0 | 0 | 0 | 0 | 1.19 |
| 2 | — | 0 | 0 | 0 | 0 | 0 | 1.39 |
| 3 | — | 0 | 0 | 0 | 0 | 0 | 1.19 |
| **mediana** | — | 0 | 0 | 0 | 0 | 0 | 1.19 |
| mínimo | — | 0 | 0 | 0 | 0 | 0 | 1.19 |
| máximo | — | 0 | 0 | 0 | 0 | 0 | 1.39 |
| amplitude / mediana (%) | — | — | — | — | — | — | 16.95 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1913 | 3823.00 | 4929.00 | 5154.00 | 229.48 | 5.23 |
| 2 | 1888 | 4051.00 | 4741.00 | 4970.00 | 220.62 | 4.85 |
| 3 | 1918 | 3841.00 | 4982.00 | 5157.00 | 233.72 | 5.09 |
| **mediana** | 1913 | 3841.00 | 4929.00 | 5154.00 | 229.48 | 5.09 |
| mínimo | 1888 | 3823.00 | 4741.00 | 4970.00 | 220.62 | 4.85 |
| máximo | 1918 | 4051.00 | 4982.00 | 5157.00 | 233.72 | 5.23 |
| amplitude / mediana (%) | 1.57 | 5.94 | 4.89 | 3.63 | 5.71 | 7.48 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 100 | 100 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação no mesmo provedor | 0 | 0 |
| identidades (provedor, id externo) repetidas | 0 | 0 |
| transações com mais de um lançamento | 0 | 0 |
| movimentos PROCESSED sem lançamento | 0 | 0 |
| lançamentos de transação não processada ou de LOSS | 0 | 0 |
| chaves aceitas que não estão gravadas | 0 | 0 |
| eventos do outbox que não chegaram à fila | 0 | 0 |
| eventos recebidos que não estão no outbox | 0 | 0 |
| fatos repetidos depois de deduplicar por eventId | 0 | 0 |
| mensagens registradas no inbox (uma por enviada) | 3500 | 3500 |

Eventos: 6857 no outbox; 6857 entregas recebidas da fila; 6857 eventIds distintos; duplicatas brutas: 0 (0.00% das entregas).

### Cenário D. Duplicatas: reenvios com a mesma Idempotency-Key

#### Vazão e latência

| Repetição | Requisições | Duração (s) | req/s | Latência p50 (ms) | Latência p95 (ms) | Latência p99 (ms) | Latência max (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1000 | 1.45 | 691.91 | 46.76 | 85.69 | 106.38 | 129.67 |
| 2 | 1000 | 1.34 | 748.33 | 44.13 | 71.76 | 85.93 | 117.39 |
| 3 | 1000 | 1.35 | 741.24 | 44.21 | 72.78 | 90.56 | 117.21 |
| **mediana** | 1000 | 1.35 | 741.24 | 44.21 | 72.78 | 90.56 | 117.39 |
| mínimo | 1000 | 1.34 | 691.91 | 44.13 | 71.76 | 85.93 | 117.21 |
| máximo | 1000 | 1.45 | 748.33 | 46.76 | 85.69 | 106.38 | 129.67 |
| amplitude / mediana (%) | 0.00 | 8.08 | 7.61 | 5.94 | 19.14 | 22.58 | 10.61 |

#### Respostas por status

| Repetição | 201 | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 621, LOSS 85, WIN 294 |
| 2 | 1000 | 0.00% | BET 580, LOSS 104, WIN 316 |
| 3 | 1000 | 0.00% | BET 622, LOSS 90, WIN 288 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 5.26 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 4.90 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 4.68 |
| **mediana** | 0 | 0 | 0 | 0 | 0 | 0 | 4.90 |
| mínimo | 0 | 0 | 0 | 0 | 0 | 0 | 4.68 |
| máximo | 0 | 0 | 0 | 0 | 0 | 0 | 5.26 |
| amplitude / mediana (%) | — | — | — | — | — | — | 11.91 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1340 | 2887.00 | 4194.00 | 4532.00 | 257.50 | 4.60 |
| 2 | 1326 | 2608.00 | 3832.00 | 3996.00 | 283.85 | 3.99 |
| 3 | 1338 | 2673.00 | 4096.00 | 4283.00 | 286.11 | 4.31 |
| **mediana** | 1338 | 2673.00 | 4096.00 | 4283.00 | 283.85 | 4.31 |
| mínimo | 1326 | 2608.00 | 3832.00 | 3996.00 | 257.50 | 3.99 |
| máximo | 1340 | 2887.00 | 4194.00 | 4532.00 | 286.11 | 4.60 |
| amplitude / mediana (%) | 1.05 | 10.44 | 8.84 | 12.51 | 10.08 | 14.02 |

#### Efeito dos reenvios

| Repetição | Reenvios | Respondidos como replay | Duplicatas contadas pela aplicação | Original p50 (ms) | Original p95 (ms) | Original p99 (ms) | Original max (ms) | Replay p50 (ms) | Replay p95 (ms) | Replay p99 (ms) | Replay max (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 300 | 300 | 300 | 50.67 | 89.50 | 106.41 | 129.67 | 17.30 | 70.53 | 99.20 | 117.98 |
| 2 | 300 | 300 | 300 | 48.43 | 72.11 | 85.55 | 117.39 | 17.16 | 69.63 | 88.21 | 92.68 |
| 3 | 300 | 300 | 300 | 48.92 | 74.08 | 87.77 | 104.79 | 16.93 | 70.26 | 90.56 | 117.21 |
| **mediana** | 300 | 300 | 300 | 48.92 | 74.08 | 87.77 | 117.39 | 17.16 | 70.26 | 90.56 | 117.21 |
| mínimo | 300 | 300 | 300 | 48.43 | 72.11 | 85.55 | 104.79 | 16.93 | 69.63 | 88.21 | 92.68 |
| máximo | 300 | 300 | 300 | 50.67 | 89.50 | 106.41 | 129.67 | 17.30 | 70.53 | 99.20 | 117.98 |
| amplitude / mediana (%) | 0.00 | 0.00 | 0.00 | 4.59 | 23.47 | 23.77 | 21.19 | 2.15 | 1.29 | 12.14 | 21.59 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 100 | 100 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação no mesmo provedor | 0 | 0 |
| identidades (provedor, id externo) repetidas | 0 | 0 |
| transações com mais de um lançamento | 0 | 0 |
| movimentos PROCESSED sem lançamento | 0 | 0 |
| lançamentos de transação não processada ou de LOSS | 0 | 0 |
| chaves aceitas que não estão gravadas | 0 | 0 |
| eventos do outbox que não chegaram à fila | 0 | 0 |
| eventos recebidos que não estão no outbox | 0 | 0 |
| fatos repetidos depois de deduplicar por eventId | 0 | 0 |
| chaves com respostas incoerentes (mais de um original ou transações diferentes) | 0 | 0 |

Eventos: 4860 no outbox; 4860 entregas recebidas da fila; 4860 eventIds distintos; duplicatas brutas: 0 (0.00% das entregas).

## Experimentos adicionais (cenário B)

Mesma máquina e mesmo commit, só o cenário B. Servem para responder: por que não apareceu nenhum conflito nem `503`?

### Extra 1: `LOCK_TIMEOUT_MS=50`

Execução iniciada em 2026-11-25T18:43:30.589Z, duração total 60.87 s.

| Item | Valor |
| --- | --- |
| Configuração da aplicação sobrescrita por variável de ambiente | LOCK_TIMEOUT_MS=50 |
| Commit medido | cb549d5 |
| `requests` | 1000 |
| `concurrency` | 32 |
| `instances` | 2 |

#### Vazão e latência

| Repetição | Requisições | Duração (s) | req/s | Latência p50 (ms) | Latência p95 (ms) | Latência p99 (ms) | Latência max (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1000 | 8.59 | 116.36 | 266.93 | 541.16 | 602.82 | 721.36 |
| 2 | 1000 | 8.30 | 120.42 | 263.07 | 523.74 | 608.44 | 758.03 |
| 3 | 1000 | 8.35 | 119.75 | 278.14 | 506.98 | 575.57 | 650.31 |
| **mediana** | 1000 | 8.35 | 119.75 | 266.93 | 523.74 | 602.82 | 721.36 |
| mínimo | 1000 | 8.30 | 116.36 | 263.07 | 506.98 | 575.57 | 650.31 |
| máximo | 1000 | 8.59 | 120.42 | 278.14 | 541.16 | 608.44 | 758.03 |
| amplitude / mediana (%) | 0.00 | 3.47 | 3.39 | 5.64 | 6.53 | 5.45 | 14.93 |

#### Respostas por status

| Repetição | 201 | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 543, LOSS 88, REFUND 95, WIN 274 |
| 2 | 1000 | 0.00% | BET 567, LOSS 94, REFUND 97, WIN 242 |
| 3 | 1000 | 0.00% | BET 564, LOSS 100, REFUND 102, WIN 234 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 122.05 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 117.58 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 137.29 |
| **mediana** | 0 | 0 | 0 | 0 | 0 | 0 | 122.05 |
| mínimo | 0 | 0 | 0 | 0 | 0 | 0 | 117.58 |
| máximo | 0 | 0 | 0 | 0 | 0 | 0 | 137.29 |
| amplitude / mediana (%) | — | — | — | — | — | — | 16.14 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1912 | 3019.00 | 3833.00 | 8110.00 | 185.93 | 2.77 |
| 2 | 1906 | 3463.00 | 4048.00 | 8009.00 | 167.86 | 3.29 |
| 3 | 1900 | 4623.00 | 5113.00 | 6524.00 | 153.22 | 4.24 |
| **mediana** | 1906 | 3463.00 | 4048.00 | 8009.00 | 167.86 | 3.29 |
| mínimo | 1900 | 3019.00 | 3833.00 | 6524.00 | 153.22 | 2.77 |
| máximo | 1912 | 4623.00 | 5113.00 | 8110.00 | 185.93 | 4.24 |
| amplitude / mediana (%) | 0.63 | 46.32 | 31.62 | 19.80 | 19.49 | 44.78 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 4 | 4 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação no mesmo provedor | 0 | 0 |
| identidades (provedor, id externo) repetidas | 0 | 0 |
| transações com mais de um lançamento | 0 | 0 |
| movimentos PROCESSED sem lançamento | 0 | 0 |
| lançamentos de transação não processada ou de LOSS | 0 | 0 |
| chaves aceitas que não estão gravadas | 0 | 0 |
| eventos do outbox que não chegaram à fila | 0 | 0 |
| eventos recebidos que não estão no outbox | 0 | 0 |
| fatos repetidos depois de deduplicar por eventId | 0 | 0 |

Eventos: 6681 no outbox; 6681 entregas recebidas da fila; 6681 eventIds distintos; duplicatas brutas: 0 (0.00% das entregas).

### Extra 2: concorrência 256

Execução iniciada em 2026-11-25T18:44:32.594Z, duração total 67.60 s.

| Item | Valor |
| --- | --- |
| Configuração da aplicação sobrescrita por variável de ambiente | nenhuma: padrões do código |
| Commit medido | cb549d5 |
| `requests` | 1000 |
| `concurrency` | 256 |
| `instances` | 2 |

#### Vazão e latência

| Repetição | Requisições | Duração (s) | req/s | Latência p50 (ms) | Latência p95 (ms) | Latência p99 (ms) | Latência max (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1000 | 7.71 | 129.63 | 1882.22 | 2185.04 | 2231.11 | 2342.19 |
| 2 | 1000 | 7.85 | 127.41 | 1917.50 | 2060.35 | 2157.24 | 2222.57 |
| 3 | 1000 | 7.82 | 127.81 | 1949.12 | 2109.13 | 2158.90 | 2218.03 |
| **mediana** | 1000 | 7.82 | 127.81 | 1917.50 | 2109.13 | 2158.90 | 2222.57 |
| mínimo | 1000 | 7.71 | 127.41 | 1882.22 | 2060.35 | 2157.24 | 2218.03 |
| máximo | 1000 | 7.85 | 129.63 | 1949.12 | 2185.04 | 2231.11 | 2342.19 |
| amplitude / mediana (%) | 0.00 | 1.71 | 1.73 | 3.49 | 5.91 | 3.42 | 5.59 |

#### Respostas por status

| Repetição | 201 | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 568, LOSS 88, REFUND 70, WIN 274 |
| 2 | 1000 | 0.00% | BET 583, LOSS 94, REFUND 81, WIN 242 |
| 3 | 1000 | 0.00% | BET 596, LOSS 100, REFUND 70, WIN 234 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 142.65 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 143.11 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 143.32 |
| **mediana** | 0 | 0 | 0 | 0 | 0 | 0 | 143.11 |
| mínimo | 0 | 0 | 0 | 0 | 0 | 0 | 142.65 |
| máximo | 0 | 0 | 0 | 0 | 0 | 0 | 143.32 |
| amplitude / mediana (%) | — | — | — | — | — | — | 0.47 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1912 | 6602.00 | 7381.00 | 7609.00 | 141.64 | 6.14 |
| 2 | 1906 | 6784.00 | 7526.00 | 7693.00 | 163.34 | 5.86 |
| 3 | 1900 | 6669.00 | 7495.00 | 7706.00 | 157.49 | 6.20 |
| **mediana** | 1906 | 6669.00 | 7495.00 | 7693.00 | 157.49 | 6.14 |
| mínimo | 1900 | 6602.00 | 7381.00 | 7609.00 | 141.64 | 5.86 |
| máximo | 1912 | 6784.00 | 7526.00 | 7706.00 | 163.34 | 6.20 |
| amplitude / mediana (%) | 0.63 | 2.73 | 1.93 | 1.26 | 13.78 | 5.53 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 4 | 4 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação no mesmo provedor | 0 | 0 |
| identidades (provedor, id externo) repetidas | 0 | 0 |
| transações com mais de um lançamento | 0 | 0 |
| movimentos PROCESSED sem lançamento | 0 | 0 |
| lançamentos de transação não processada ou de LOSS | 0 | 0 |
| chaves aceitas que não estão gravadas | 0 | 0 |
| eventos do outbox que não chegaram à fila | 0 | 0 |
| eventos recebidos que não estão no outbox | 0 | 0 |
| fatos repetidos depois de deduplicar por eventId | 0 | 0 |

Eventos: 6681 no outbox; 6681 entregas recebidas da fila; 6681 eventIds distintos; duplicatas brutas: 0 (0.00% das entregas).

### Sonda no PostgreSQL: o que o `lock_timeout` limita

Script descartável, fora do repositório, em banco próprio: 12 transações disputam uma linha com `FOR NO KEY UPDATE`; cada dona a segura por 100 ms; `lock_timeout` de 300 ms. O resultado se repetiu em quatro execuções (na última delas, abaixo). A sonda depende só do PostgreSQL e não foi repetida junto com as execuções acima.

```
PROBE dono ATUALIZA a linha: 12 transações, cada dono 100 ms, lock_timeout 300 ms => 12 ok (maior espera 1152 ms), 0 falhas 
PROBE dono só trava: 12 transações, cada dono 100 ms, lock_timeout 300 ms => 4 ok (maior espera 317 ms), 8 falhas 55P03
```

## Análise

Os números abaixo são medianas da execução de referência. Onde há uma explicação não medida, está marcada como **hipótese**.

1. **Invariantes:** passaram nos quatro cenários e nos dois extras. Nenhum erro HTTP, nenhuma mensagem na DLQ, nenhum deadlock.
2. **Distribuído x hot wallet:** 535,38 contra 123,59 req/s; p50 de 58,59 contra 256,88 ms. Na wallet única as transações são serializadas pelo lock: a espera média passa de 4,11 para 116,38 ms. A vazão de B equivale a cerca de 8,1 ms por transação em série, e 32 requisições em voo a essa taxa dão cerca de 259 ms, perto do p50 medido.
3. **O `lock_timeout` não é um limite de espera total (achado).** Com 50 ms e espera média de 122,05 ms, o extra 1 não teve um único conflito. A sonda mostra o motivo: quando cada dona **atualiza** a linha, as que esperam passam de 1 s sem erro com um prazo de 300 ms; quando só trava, estouram. O PostgreSQL aplica o `lock_timeout` a cada tentativa de obter um lock, separadamente. Consequência: numa wallet quente com escritas, a fila não vira `503`; a latência é que cresce, sem teto dado por esse parâmetro. O prazo continua cobrindo uma dona travada que não libera. Não há `statement_timeout`. Nada no código foi alterado por este experimento.
4. **Concorrência 256 na hot wallet:** a vazão fica na mesma faixa (127,81 contra 123,59 req/s) e o p50 sobe para 1917,50 ms, enquanto a espera média no lock vai só a 143,11 ms. **Hipótese:** o excedente espera por conexão no pool de cada instância (não configurado; não medimos o tempo de espera pelo pool).
5. **O publisher do outbox não acompanha a entrada.** Em A, cada repetição grava cerca de 1900 eventos em cerca de 1,9 s e o publisher entrega 261,53 por segundo; o lag é de 3,8 s no p50 e 5,8 s no p95, e restam 6,09 s de publicação depois da carga. A publicação é sequencial em cada instância (decisão registrada no documento de arquitetura). **Inferência:** sob carga sustentada acima dessa taxa o atraso cresceria sem parar; o experimento é curto demais para mostrar isso diretamente. Nenhum evento se perdeu.
6. **Mensageria:** 237,74 msg/s com 2 instâncias de concorrência 5, e processamento médio de 25,07 ms. Dez mensagens em voo a esse tempo permitiriam cerca de 400 msg/s. **Hipótese:** as vagas ficam parte do tempo ociosas esperando o `ReceiveMessage` do MiniStack ou a vez do grupo; não foi isolado.
7. **Reenvios:** os 300 reenvios de cada repetição voltaram como replay e a aplicação contou os 300; nenhuma chave gerou segunda transação. O replay tem p50 menor (17,16 contra 48,92 ms), mas p99 equivalente (90,56 contra 87,77 ms). **Hipótese:** a cauda é dos reenvios que chegam com o original em voo e percorrem o caminho com lock.
8. **Variação:** entre repetições, a amplitude da vazão (em relação à mediana) foi de 17,65% em A, 2,77% em B, 11,08% em C e 7,61% em D. Em A a repetição 3 ficou abaixo das outras (462,88 contra 557,39 req/s na melhor), e a causa não foi investigada. Os percentis altos variam mais (até 79,76% no p99 de A). Três repetições curtas não permitem intervalo de confiança.

## Limitações

- **Tudo na mesma máquina:** gerador, aplicação, PostgreSQL e MiniStack disputam CPU. Postgres e MiniStack ficam numa VM do Docker com 2 CPUs e cerca de 3,8 GB, enquanto a máquina tem 16 processadores lógicos. Durante as execuções havia na mesma VM um container de outro projeto, que não foi parado; não medimos o consumo dele durante a carga.
- **MiniStack não é o SQS:** latência, vazão, FIFO e cotas são diferentes. Os números do cenário C e do outbox não se transferem para a AWS.
- **Repetições curtas:** 1,3 a 8,6 s de carga HTTP medida por repetição. Não há teste de longa duração: nada sobre crescimento de tabelas, autovacuum, vazamento de memória ou backlog sustentado.
- **Laço fechado:** quando o serviço fica lento, o gerador envia menos (*coordinated omission*). Os percentis não representam a latência sob uma taxa de chegada fixa.
- **Disco e rede:** loopback e volume do Docker Desktop (WSL2), com `fsync` ligado; nada representativo de um banco gerenciado.
- **Mistura artificial:** saldos altos para não haver rejeições; sem `422`, sem `PENDING_REFERENCE`, sem referências fora de ordem, sem falhas injetadas e sem reinício de instâncias.
- **Cenário C com processos frios:** cada repetição mede instâncias recém-iniciadas; o aquecimento não as aquece. O tempo até o primeiro processamento não entra na vazão.
- **Efeito da própria medição:** o stdout das instâncias (um log por transação) é descartado, mas o custo de gerá-lo entra; o gerador consulta o banco enquanto espera o outbox e a drenagem.
- **Conflitos não provocados:** nenhuma execução produziu `40P01`, `40001` ou `55P03`, então o caminho de retry e `503` não foi exercitado sob carga (é provado por testes de integração).
- **Outra máquina:** só foi executado em Windows 11.
- **Uma execução anterior** com outros parâmetros (1500 requisições, 200 de aquecimento) levou 250 s, acima da meta de 3 minutos, e a primeira repetição de A ficou bem abaixo das outras (425,74 contra 634,08 req/s na terceira). Por isso o aquecimento subiu para 500 e as repetições caíram para 1000. Também passou em todas as invariantes.
