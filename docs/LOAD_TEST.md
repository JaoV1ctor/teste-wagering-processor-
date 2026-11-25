# Teste de carga

Experimento para observar o comportamento do serviço sob carga **numa única máquina de desenvolvimento**. Não há meta de requisições por segundo, e os números não valem como capacidade de produção: o que eles mostram são os limites relativos entre os caminhos e se as invariantes se mantêm. Ver [Limitações](#limitações).

## Como rodar

```bash
docker compose up -d
bun run test:load            # execução completa: cerca de 3 minutos na máquina descrita abaixo
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

**As invariantes detectam violação?** Em uma execução à parte, com um saldo inflado por SQL e um evento republicado com outro `eventId`, quatro verificações falharam e o comando saiu com código 1. A alteração foi desfeita em seguida e não está no repositório.

## Resultados da execução de referência

Copiado do `report.md` gerado, sem edição.

Execução iniciada em 2026-11-25T17:01:01.171Z, duração total 186.84 s.

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
| Commit medido | 787863b |

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
| 1 | 1000 | 1.70 | 588.50 | 52.71 | 84.03 | 98.63 | 121.11 |
| 2 | 1000 | 1.78 | 562.15 | 53.93 | 86.35 | 109.89 | 150.88 |
| 3 | 1000 | 1.70 | 587.54 | 52.68 | 81.89 | 95.18 | 104.13 |
| **mediana** | 1000 | 1.70 | 587.54 | 52.71 | 84.03 | 98.63 | 121.11 |
| mínimo | 1000 | 1.70 | 562.15 | 52.68 | 81.89 | 95.18 | 104.13 |
| máximo | 1000 | 1.78 | 588.50 | 53.93 | 86.35 | 109.89 | 150.88 |
| amplitude / mediana (%) | 0.00 | 4.68 | 4.49 | 2.37 | 5.30 | 14.92 | 38.60 |

#### Respostas por status

| Repetição | 201 | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 543, LOSS 88, REFUND 95, WIN 274 |
| 2 | 1000 | 0.00% | BET 567, LOSS 94, REFUND 97, WIN 242 |
| 3 | 1000 | 0.00% | BET 565, LOSS 100, REFUND 101, WIN 234 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 3.81 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 3.97 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 3.69 |
| **mediana** | 0 | 0 | 0 | 0 | 0 | 0 | 3.81 |
| mínimo | 0 | 0 | 0 | 0 | 0 | 0 | 3.69 |
| máximo | 0 | 0 | 0 | 0 | 0 | 0 | 3.97 |
| amplitude / mediana (%) | — | — | — | — | — | — | 7.36 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1912 | 3914.00 | 5905.00 | 6131.00 | 269.34 | 6.16 |
| 2 | 1906 | 3644.00 | 5698.00 | 5936.00 | 281.64 | 5.93 |
| 3 | 1900 | 3638.00 | 5536.00 | 5919.00 | 286.25 | 5.93 |
| **mediana** | 1906 | 3644.00 | 5698.00 | 5936.00 | 281.64 | 5.93 |
| mínimo | 1900 | 3638.00 | 5536.00 | 5919.00 | 269.34 | 5.93 |
| máximo | 1912 | 3914.00 | 5905.00 | 6131.00 | 286.25 | 6.16 |
| amplitude / mediana (%) | 0.63 | 7.57 | 6.48 | 3.57 | 6.00 | 3.89 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 100 | 100 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação | 0 | 0 |
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
| 1 | 1000 | 8.50 | 117.59 | 276.41 | 515.71 | 607.12 | 763.27 |
| 2 | 1000 | 8.32 | 120.14 | 259.52 | 504.37 | 585.30 | 638.16 |
| 3 | 1000 | 8.36 | 119.57 | 266.05 | 513.13 | 604.91 | 678.71 |
| **mediana** | 1000 | 8.36 | 119.57 | 266.05 | 513.13 | 604.91 | 678.71 |
| mínimo | 1000 | 8.32 | 117.59 | 259.52 | 504.37 | 585.30 | 638.16 |
| máximo | 1000 | 8.50 | 120.14 | 276.41 | 515.71 | 607.12 | 763.27 |
| amplitude / mediana (%) | 0.00 | 2.16 | 2.13 | 6.35 | 2.21 | 3.61 | 18.43 |

#### Respostas por status

| Repetição | 201 | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 543, LOSS 88, REFUND 95, WIN 274 |
| 2 | 1000 | 0.00% | BET 567, LOSS 94, REFUND 97, WIN 242 |
| 3 | 1000 | 0.00% | BET 565, LOSS 100, REFUND 101, WIN 234 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 120.27 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 123.34 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 118.54 |
| **mediana** | 0 | 0 | 0 | 0 | 0 | 0 | 120.27 |
| mínimo | 0 | 0 | 0 | 0 | 0 | 0 | 118.54 |
| máximo | 0 | 0 | 0 | 0 | 0 | 0 | 123.34 |
| amplitude / mediana (%) | — | — | — | — | — | — | 3.99 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1912 | 3357.00 | 4182.00 | 8069.00 | 170.37 | 2.97 |
| 2 | 1906 | 3127.00 | 3807.00 | 8029.00 | 187.81 | 2.88 |
| 3 | 1900 | 2800.00 | 3509.00 | 7906.00 | 189.18 | 2.68 |
| **mediana** | 1906 | 3127.00 | 3807.00 | 8029.00 | 187.81 | 2.88 |
| mínimo | 1900 | 2800.00 | 3509.00 | 7906.00 | 170.37 | 2.68 |
| máximo | 1912 | 3357.00 | 4182.00 | 8069.00 | 189.18 | 2.97 |
| amplitude / mediana (%) | 0.63 | 17.81 | 17.68 | 2.03 | 10.02 | 10.02 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 4 | 4 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação | 0 | 0 |
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
| 1 | 1000 | 0.14 | 3.90 | 4.66 | 256.09 | 24.32 |
| 2 | 1000 | 0.13 | 3.88 | 4.51 | 257.41 | 23.70 |
| 3 | 1000 | 0.13 | 4.05 | 4.85 | 246.73 | 25.36 |
| **mediana** | 1000 | 0.13 | 3.90 | 4.66 | 256.09 | 24.32 |
| mínimo | 1000 | 0.13 | 3.88 | 4.51 | 246.73 | 23.70 |
| máximo | 1000 | 0.14 | 4.05 | 4.85 | 257.41 | 25.36 |
| amplitude / mediana (%) | 0.00 | 5.61 | 4.31 | 7.44 | 4.17 | 6.84 |

#### Estado final das transações

| Repetição | PROCESSED | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 611, LOSS 87, WIN 302 |
| 2 | 1000 | 0.00% | BET 585, LOSS 112, WIN 303 |
| 3 | 1000 | 0.00% | BET 610, LOSS 82, WIN 308 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | — | 0 | 0 | 0 | 0 | 0 | 1.20 |
| 2 | — | 0 | 0 | 0 | 0 | 0 | 1.16 |
| 3 | — | 0 | 0 | 0 | 0 | 0 | 1.30 |
| **mediana** | — | 0 | 0 | 0 | 0 | 0 | 1.20 |
| mínimo | — | 0 | 0 | 0 | 0 | 0 | 1.16 |
| máximo | — | 0 | 0 | 0 | 0 | 0 | 1.30 |
| amplitude / mediana (%) | — | — | — | — | — | — | 11.37 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1913 | 3769.00 | 4919.00 | 5093.00 | 239.93 | 5.03 |
| 2 | 1888 | 3615.00 | 4801.00 | 5019.00 | 242.05 | 5.04 |
| 3 | 1918 | 3658.00 | 4884.00 | 5061.00 | 240.92 | 4.94 |
| **mediana** | 1913 | 3658.00 | 4884.00 | 5061.00 | 240.92 | 5.03 |
| mínimo | 1888 | 3615.00 | 4801.00 | 5019.00 | 239.93 | 4.94 |
| máximo | 1918 | 3769.00 | 4919.00 | 5093.00 | 242.05 | 5.04 |
| amplitude / mediana (%) | 1.57 | 4.21 | 2.42 | 1.46 | 0.88 | 1.89 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 100 | 100 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação | 0 | 0 |
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
| 1 | 1000 | 1.34 | 746.84 | 43.57 | 72.67 | 90.95 | 137.70 |
| 2 | 1000 | 1.44 | 693.90 | 45.03 | 86.02 | 100.39 | 125.41 |
| 3 | 1000 | 1.29 | 776.75 | 42.00 | 69.64 | 80.80 | 105.60 |
| **mediana** | 1000 | 1.34 | 746.84 | 43.57 | 72.67 | 90.95 | 125.41 |
| mínimo | 1000 | 1.29 | 693.90 | 42.00 | 69.64 | 80.80 | 105.60 |
| máximo | 1000 | 1.44 | 776.75 | 45.03 | 86.02 | 100.39 | 137.70 |
| amplitude / mediana (%) | 0.00 | 11.48 | 11.09 | 6.94 | 22.54 | 21.53 | 25.60 |

#### Respostas por status

| Repetição | 201 | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 621, LOSS 85, WIN 294 |
| 2 | 1000 | 0.00% | BET 580, LOSS 104, WIN 316 |
| 3 | 1000 | 0.00% | BET 622, LOSS 90, WIN 288 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 5.17 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 5.21 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 4.75 |
| **mediana** | 0 | 0 | 0 | 0 | 0 | 0 | 5.17 |
| mínimo | 0 | 0 | 0 | 0 | 0 | 0 | 4.75 |
| máximo | 0 | 0 | 0 | 0 | 0 | 0 | 5.21 |
| amplitude / mediana (%) | — | — | — | — | — | — | 8.86 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1340 | 2778.00 | 4105.00 | 4323.00 | 270.72 | 4.39 |
| 2 | 1326 | 2758.00 | 4026.00 | 4201.00 | 272.86 | 4.21 |
| 3 | 1338 | 2715.00 | 3962.00 | 4167.00 | 292.75 | 4.22 |
| **mediana** | 1338 | 2758.00 | 4026.00 | 4201.00 | 272.86 | 4.22 |
| mínimo | 1326 | 2715.00 | 3962.00 | 4167.00 | 270.72 | 4.21 |
| máximo | 1340 | 2778.00 | 4105.00 | 4323.00 | 292.75 | 4.39 |
| amplitude / mediana (%) | 1.05 | 2.28 | 3.55 | 3.71 | 8.07 | 4.23 |

#### Efeito dos reenvios

| Repetição | Reenvios | Respondidos como replay | Duplicatas contadas pela aplicação | Original p50 (ms) | Original p95 (ms) | Original p99 (ms) | Original max (ms) | Replay p50 (ms) | Replay p95 (ms) | Replay p99 (ms) | Replay max (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 300 | 300 | 300 | 49.33 | 72.67 | 88.91 | 116.57 | 16.10 | 72.20 | 90.95 | 137.70 |
| 2 | 300 | 300 | 300 | 52.05 | 89.44 | 104.45 | 125.41 | 19.35 | 74.15 | 89.32 | 109.12 |
| 3 | 300 | 300 | 300 | 45.47 | 69.27 | 76.79 | 88.07 | 17.26 | 70.46 | 83.00 | 105.60 |
| **mediana** | 300 | 300 | 300 | 49.33 | 72.67 | 88.91 | 116.57 | 17.26 | 72.20 | 89.32 | 109.12 |
| mínimo | 300 | 300 | 300 | 45.47 | 69.27 | 76.79 | 88.07 | 16.10 | 70.46 | 83.00 | 105.60 |
| máximo | 300 | 300 | 300 | 52.05 | 89.44 | 104.45 | 125.41 | 19.35 | 74.15 | 90.95 | 137.70 |
| amplitude / mediana (%) | 0.00 | 0.00 | 0.00 | 13.35 | 27.76 | 31.11 | 32.03 | 18.81 | 5.10 | 8.91 | 29.42 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 100 | 100 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação | 0 | 0 |
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

Execução iniciada em 2026-11-25T17:04:15.510Z, duração total 59.38 s.

| Item | Valor |
| --- | --- |
| Configuração da aplicação sobrescrita por variável de ambiente | LOCK_TIMEOUT_MS=50 |
| Commit medido | 787863b |
| `requests` | 1000 |
| `concurrency` | 32 |
| `instances` | 2 |

#### Vazão e latência

| Repetição | Requisições | Duração (s) | req/s | Latência p50 (ms) | Latência p95 (ms) | Latência p99 (ms) | Latência max (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1000 | 8.62 | 115.97 | 276.95 | 528.07 | 606.76 | 848.14 |
| 2 | 1000 | 8.54 | 117.12 | 261.96 | 540.15 | 594.85 | 815.90 |
| 3 | 1000 | 8.51 | 117.52 | 273.99 | 513.97 | 595.20 | 757.76 |
| **mediana** | 1000 | 8.54 | 117.12 | 273.99 | 528.07 | 595.20 | 815.90 |
| mínimo | 1000 | 8.51 | 115.97 | 261.96 | 513.97 | 594.85 | 757.76 |
| máximo | 1000 | 8.62 | 117.52 | 276.95 | 540.15 | 606.76 | 848.14 |
| amplitude / mediana (%) | 0.00 | 1.34 | 1.33 | 5.47 | 4.96 | 2.00 | 11.08 |

#### Respostas por status

| Repetição | 201 | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 544, LOSS 88, REFUND 94, WIN 274 |
| 2 | 1000 | 0.00% | BET 567, LOSS 94, REFUND 97, WIN 242 |
| 3 | 1000 | 0.00% | BET 565, LOSS 100, REFUND 101, WIN 234 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 125.39 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 125.80 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 126.24 |
| **mediana** | 0 | 0 | 0 | 0 | 0 | 0 | 125.80 |
| mínimo | 0 | 0 | 0 | 0 | 0 | 0 | 125.39 |
| máximo | 0 | 0 | 0 | 0 | 0 | 0 | 126.24 |
| amplitude / mediana (%) | — | — | — | — | — | — | 0.67 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1912 | 3223.00 | 4032.00 | 8136.00 | 180.86 | 2.96 |
| 2 | 1906 | 3635.00 | 4357.00 | 8096.00 | 163.02 | 3.30 |
| 3 | 1900 | 2810.00 | 3453.00 | 8064.00 | 185.96 | 2.79 |
| **mediana** | 1906 | 3223.00 | 4032.00 | 8096.00 | 180.86 | 2.96 |
| mínimo | 1900 | 2810.00 | 3453.00 | 8064.00 | 163.02 | 2.79 |
| máximo | 1912 | 3635.00 | 4357.00 | 8136.00 | 185.96 | 3.30 |
| amplitude / mediana (%) | 0.63 | 25.60 | 22.42 | 0.89 | 12.68 | 17.12 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 4 | 4 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação | 0 | 0 |
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

Execução iniciada em 2026-11-25T17:05:15.922Z, duração total 69.56 s.

| Item | Valor |
| --- | --- |
| Configuração da aplicação sobrescrita por variável de ambiente | nenhuma: padrões do código |
| Commit medido | 787863b |
| `requests` | 1000 |
| `concurrency` | 256 |
| `instances` | 2 |

#### Vazão e latência

| Repetição | Requisições | Duração (s) | req/s | Latência p50 (ms) | Latência p95 (ms) | Latência p99 (ms) | Latência max (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1000 | 8.22 | 121.72 | 2034.82 | 2216.95 | 2259.32 | 2352.95 |
| 2 | 1000 | 8.22 | 121.65 | 2071.80 | 2213.20 | 2252.99 | 2299.29 |
| 3 | 1000 | 7.75 | 129.01 | 1931.05 | 2057.32 | 2096.39 | 2158.35 |
| **mediana** | 1000 | 8.22 | 121.72 | 2034.82 | 2213.20 | 2252.99 | 2299.29 |
| mínimo | 1000 | 7.75 | 121.65 | 1931.05 | 2057.32 | 2096.39 | 2158.35 |
| máximo | 1000 | 8.22 | 129.01 | 2071.80 | 2216.95 | 2259.32 | 2352.95 |
| amplitude / mediana (%) | 0.00 | 5.70 | 6.04 | 6.92 | 7.21 | 7.23 | 8.46 |

#### Respostas por status

| Repetição | 201 | Taxa de erro | Operações enviadas |
| --- | --- | --- | --- |
| 1 | 1000 | 0.00% | BET 568, LOSS 88, REFUND 70, WIN 274 |
| 2 | 1000 | 0.00% | BET 583, LOSS 94, REFUND 81, WIN 242 |
| 3 | 1000 | 0.00% | BET 596, LOSS 100, REFUND 70, WIN 234 |

#### Concorrência

| Repetição | HTTP 503 | Conflitos de lock (40P01, 40001, 55P03) | Retries no banco | Retries na fila | Mensagens à DLQ | Deadlocks (pg_stat_database) | Espera média pelo lock da wallet (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 152.17 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 151.25 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 142.24 |
| **mediana** | 0 | 0 | 0 | 0 | 0 | 0 | 151.25 |
| mínimo | 0 | 0 | 0 | 0 | 0 | 0 | 142.24 |
| máximo | 0 | 0 | 0 | 0 | 0 | 0 | 152.17 |
| amplitude / mediana (%) | — | — | — | — | — | — | 6.56 |

#### Outbox

| Repetição | Eventos | Lag p50 (ms) | Lag p95 (ms) | Lag máx (ms) | Publicados por segundo | Publicação restante após a carga (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1912 | 7596.00 | 8211.00 | 8301.00 | 132.35 | 6.75 |
| 2 | 1906 | 7145.00 | 7961.00 | 8100.00 | 152.39 | 6.39 |
| 3 | 1900 | 6674.00 | 7389.00 | 7666.00 | 158.86 | 6.18 |
| **mediana** | 1906 | 7145.00 | 7961.00 | 8100.00 | 152.39 | 6.39 |
| mínimo | 1900 | 6674.00 | 7389.00 | 7666.00 | 132.35 | 6.18 |
| máximo | 1912 | 7596.00 | 8211.00 | 8301.00 | 158.86 | 6.75 |
| amplitude / mediana (%) | 0.63 | 12.90 | 10.33 | 7.84 | 17.40 | 8.99 |

#### Invariantes: TODAS PASSARAM

| Verificação | Observado | Esperado |
| --- | --- | --- |
| wallets reconciliadas pela API | 4 | 4 |
| wallets com saldo diferente do ledger (API) | 0 | 0 |
| wallets com saldo diferente da soma do ledger (SQL) | 0 | 0 |
| saldos negativos (wallet ou lançamento) | 0 | 0 |
| chaves de idempotência com mais de uma transação | 0 | 0 |
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

Script descartável, fora do repositório, em banco próprio: 12 transações disputam uma linha com `FOR NO KEY UPDATE`; cada dona a segura por 100 ms; `lock_timeout` de 300 ms. O resultado se repetiu em quatro execuções (na última, abaixo).

```
PROBE dono ATUALIZA a linha: 12 transações, cada dono 100 ms, lock_timeout 300 ms => 12 ok (maior espera 1152 ms), 0 falhas 
PROBE dono só trava: 12 transações, cada dono 100 ms, lock_timeout 300 ms => 4 ok (maior espera 317 ms), 8 falhas 55P03
```

## Análise

Os números abaixo são medianas da execução de referência. Onde há uma explicação não medida, está marcada como **hipótese**.

1. **Invariantes:** passaram nos quatro cenários e nos dois extras. Nenhum erro HTTP, nenhuma mensagem na DLQ, nenhum deadlock.
2. **Distribuído x hot wallet:** 587,54 contra 119,57 req/s; p50 de 52,71 contra 266,05 ms. Na wallet única as transações são serializadas pelo lock: a espera média passa de 3,81 para 120,27 ms. A vazão de B equivale a cerca de 8,4 ms por transação em série, e 32 requisições em voo a essa taxa dão cerca de 268 ms, perto do p50 medido.
3. **O `lock_timeout` não é um limite de espera total (achado).** Com 50 ms e espera média de 125 ms, o extra 1 não teve um único conflito. A sonda mostra o motivo: quando cada dona **atualiza** a linha, as que esperam passam de 1 s sem erro com um prazo de 300 ms; quando só trava, estouram. O PostgreSQL aplica o `lock_timeout` a cada tentativa de obter um lock, separadamente. Consequência: numa wallet quente com escritas, a fila não vira `503`; a latência é que cresce, sem teto dado por esse parâmetro. O prazo continua cobrindo uma dona travada que não libera. Não há `statement_timeout`. Nada no código foi alterado por este experimento.
4. **Concorrência 256 na hot wallet:** a vazão fica na mesma faixa (121,72 contra 119,57 req/s) e o p50 sobe para 2034,82 ms, enquanto a espera média no lock vai só a 151,25 ms. **Hipótese:** o excedente espera por conexão no pool de cada instância (não configurado; não medimos o tempo de espera pelo pool).
5. **O publisher do outbox não acompanha a entrada.** Em A, cada repetição grava cerca de 1900 eventos em 1,7 s e o publisher entrega 281,64 por segundo; o lag p50 é de 3,6 s e restam 5,93 s de publicação depois da carga. A publicação é sequencial em cada instância (decisão registrada no documento de arquitetura). **Inferência:** sob carga sustentada acima dessa taxa o atraso cresceria sem parar; o experimento é curto demais para mostrar isso diretamente. Nenhum evento se perdeu.
6. **Mensageria:** 256,09 msg/s com 2 instâncias de concorrência 5, e processamento médio de 24,32 ms. Dez mensagens em voo a esse tempo permitiriam cerca de 410 msg/s. **Hipótese:** as vagas ficam parte do tempo ociosas esperando o `ReceiveMessage` do MiniStack ou a vez do grupo; não foi isolado.
7. **Reenvios:** os 300 reenvios de cada repetição voltaram como replay e a aplicação contou os 300; nenhuma chave gerou segunda transação. O replay tem p50 menor (17,26 contra 49,33 ms), mas p99 equivalente (89,32 contra 88,91 ms). **Hipótese:** a cauda é dos reenvios que chegam com o original em voo e percorrem o caminho com lock.
8. **Variação:** a vazão variou menos de 12% entre repetições em todos os cenários; os percentis altos e o máximo variam mais (até 38,60% no máximo de A). Três repetições curtas não permitem intervalo de confiança.

## Limitações

- **Tudo na mesma máquina:** gerador, aplicação, PostgreSQL e MiniStack disputam CPU. Postgres e MiniStack ficam numa VM do Docker com 2 CPUs e cerca de 3,8 GB, enquanto a máquina tem 16 processadores lógicos. Durante as execuções havia na mesma VM um container de outro projeto, que não foi parado; não medimos o consumo dele durante a carga.
- **MiniStack não é o SQS:** latência, vazão, FIFO e cotas são diferentes. Os números do cenário C e do outbox não se transferem para a AWS.
- **Repetições curtas:** 1,3 a 8,5 s de carga HTTP medida por repetição. Não há teste de longa duração: nada sobre crescimento de tabelas, autovacuum, vazamento de memória ou backlog sustentado.
- **Laço fechado:** quando o serviço fica lento, o gerador envia menos (*coordinated omission*). Os percentis não representam a latência sob uma taxa de chegada fixa.
- **Disco e rede:** loopback e volume do Docker Desktop (WSL2), com `fsync` ligado; nada representativo de um banco gerenciado.
- **Mistura artificial:** saldos altos para não haver rejeições; sem `422`, sem `PENDING_REFERENCE`, sem referências fora de ordem, sem falhas injetadas e sem reinício de instâncias.
- **Cenário C com processos frios:** cada repetição mede instâncias recém-iniciadas; o aquecimento não as aquece. O tempo até o primeiro processamento não entra na vazão.
- **Efeito da própria medição:** o stdout das instâncias (um log por transação) é descartado, mas o custo de gerá-lo entra; o gerador consulta o banco enquanto espera o outbox e a drenagem.
- **Conflitos não provocados:** nenhuma execução produziu `40P01`, `40001` ou `55P03`, então o caminho de retry e `503` não foi exercitado sob carga (é provado por testes de integração).
- **Outra máquina:** só foi executado em Windows 11.
- **Uma execução anterior** com outros parâmetros (1500 requisições, 200 de aquecimento) levou 250 s, acima da meta de 3 minutos, e a primeira repetição de A ficou bem abaixo das outras (425,74 contra 634,08 req/s na terceira). Por isso o aquecimento subiu para 500 e as repetições caíram para 1000. Também passou em todas as invariantes.
