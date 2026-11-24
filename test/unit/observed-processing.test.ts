import { describe, expect, test } from 'bun:test';
import type { ProcessingReport } from '../../src/application/observers';
import { Money } from '../../src/domain/money';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Metrics } from '../../src/infrastructure/observability/metrics';
import { ObservedProcessing } from '../../src/infrastructure/observability/observed-processing';
import { parseMetrics, total } from '../support/metrics';

const NOW = new Date('2026-01-01T00:00:00Z');

function transaction(kind: WagerTransactionKind = WagerTransactionKind.Bet) {
  const created = WagerTransaction.create({
    id: 'tx-1', providerId: 'provider-a', externalTransactionId: 'ext-1', idempotencyKey: 'provider-a:ext-1', payloadHash: 'h'.repeat(64),
    walletId: 'wallet-1', playerId: 'player-1', roundId: 'r', gameId: 'g', kind, money: Money.fromString('25.00', 'BRL'), now: NOW,
  });
  created.markProcessed({ observedBalance: Money.fromString('75.00', 'BRL'), at: NOW });
  return created;
}

function setup() {
  const metrics = new Metrics();
  const logs: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const observer = new ObservedProcessing(metrics, (level, message, fields = {}) => logs.push({ level, message, fields }));
  const read = async (name: string, labels: Record<string, string> = {}) => total({ text: '', samples: parseMetrics(await metrics.registry.metrics()) }, name, labels);
  return { observer, logs, read };
}

const context = { providerId: 'provider-a', walletId: 'wallet-1', correlationId: 'corr-1', messageId: undefined };

describe('ObservedProcessing', () => {
  test('transação nova: conta por status e kind, observa a duração e loga os ids (sem payload)', async () => {
    const { observer, logs, read } = setup();
    const report: ProcessingReport = { outcome: 'new', transaction: transaction(), context, durationSeconds: 0.02 };
    observer.completed(report);

    expect(await read('wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
    expect(await read('wager_duplicates_total')).toBe(0);
    expect(await read('wager_processing_duration_seconds_count')).toBe(1);
    expect(logs).toEqual([{
      level: 'info', message: 'wager_transaction_processed',
      fields: { correlationId: 'corr-1', transactionId: 'tx-1', walletId: 'wallet-1', providerId: 'provider-a', kind: 'BET', status: 'PROCESSED' },
    }]);
    expect(JSON.stringify(logs)).not.toContain('25.00');
  });

  test('sem correlationId de origem, o id da transação é o correlationId', () => {
    const { observer, logs } = setup();
    observer.completed({ outcome: 'new', transaction: transaction(), context: { ...context, correlationId: undefined }, durationSeconds: 0.01 });
    expect(logs[0]?.fields['correlationId']).toBe('tx-1');
  });

  test('replay: conta duplicata (não conta transação nova) e ainda observa a duração', async () => {
    const { observer, logs, read } = setup();
    observer.completed({ outcome: 'replay', transaction: transaction(), context, durationSeconds: 0.003 });
    expect(await read('wager_transactions_total')).toBe(0);
    expect(await read('wager_duplicates_total')).toBe(1);
    expect(await read('wager_processing_duration_seconds_count')).toBe(1);
    expect(logs[0]).toMatchObject({ message: 'wager_transaction_replayed', fields: { transactionId: 'tx-1', correlationId: 'corr-1' } });
  });

  test('mensagem duplicada do inbox: conta duplicata, loga o messageId como correlationId e não tem transactionId', async () => {
    const { observer, logs, read } = setup();
    observer.completed({ outcome: 'duplicate-message', context: { ...context, correlationId: 'msg-9', messageId: 'msg-9' }, durationSeconds: 0.002 });
    expect(await read('wager_duplicates_total')).toBe(1);
    expect(await read('wager_transactions_total')).toBe(0);
    expect(logs[0]).toEqual({
      level: 'info', message: 'wager_message_duplicate',
      fields: { correlationId: 'msg-9', messageId: 'msg-9', walletId: 'wallet-1', providerId: 'provider-a' },
    });
  });
});
