import { describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { Cleanup, deleteQueuesWithPrefix, releaseOnFailure } from '../../scripts/cleanup';

describe('Cleanup', () => {
  test('libera na ordem inversa e não repete na segunda chamada', async () => {
    const released: string[] = [];
    const cleanup = new Cleanup();
    cleanup.defer(() => released.push('banco'));
    cleanup.defer(async () => released.push('filas'));
    await cleanup.run();
    await cleanup.run();
    expect(released).toEqual(['filas', 'banco']);
  });

  test('um passo que falha não impede os outros, e a falha é relatada', async () => {
    const released: string[] = [];
    const cleanup = new Cleanup();
    cleanup.defer(() => released.push('banco'));
    cleanup.defer(() => {
      throw new Error('fila presa');
    });
    cleanup.defer(() => released.push('servidor'));
    await expect(cleanup.run()).rejects.toThrow('fila presa');
    expect(released).toEqual(['servidor', 'banco']);
  });

  test('setup que falha libera o já criado e propaga o erro original', async () => {
    const released: string[] = [];
    const cleanup = new Cleanup();
    const original = new Error('fila não subiu');
    const setup = releaseOnFailure(cleanup, async () => {
      cleanup.defer(() => released.push('banco'));
      throw original;
    });
    await expect(setup).rejects.toBe(original);
    expect(released).toEqual(['banco']);
  });

  test('setup e limpeza falhando: nenhum dos dois erros se perde', async () => {
    const cleanup = new Cleanup();
    cleanup.defer(() => {
      throw new Error('drop falhou');
    });
    const setup = releaseOnFailure(cleanup, async () => {
      throw new Error('fila não subiu');
    });
    await expect(setup).rejects.toThrow(/fila não subiu.*drop falhou/);
  });

  test('prefixo vazio é recusado antes de qualquer chamada à fila', async () => {
    await expect(deleteQueuesWithPrefix({} as SQSClient, '')).rejects.toThrow('prefixo vazio');
  });
});
