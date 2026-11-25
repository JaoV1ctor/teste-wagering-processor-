// Produtor de demonstração: o grupo FIFO não pode depender da caixa do walletId. Unidade: o cliente só registra o comando; nada vai ao SQS.
import { describe, expect, test } from 'bun:test';
import type { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { buildWagerMessage, sendWagerMessage } from '../../scripts/send-wager-message';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

async function sentFor(walletId: string) {
  const sent: SendMessageCommand['input'][] = [];
  const client = { send: async (command: SendMessageCommand) => void sent.push(command.input) } as unknown as SQSClient;
  const message = buildWagerMessage({
    providerId: 'provider-a', playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', walletId, roundId: 'r', gameId: 'g', kind: 'BET', amount: '1.00', currency: 'BRL',
  });
  await sendWagerMessage(client, 'http://fila', message);
  return { message, input: sent[0] };
}

describe('sendWagerMessage', () => {
  test('o mesmo walletId em caixas diferentes cai no mesmo MessageGroupId, em minúsculas', async () => {
    const groups = await Promise.all([WALLET, WALLET.toUpperCase(), '0192F291-27dd-7D3F-8071-5f8685DEEF37'].map(async (id) => (await sentFor(id)).input?.MessageGroupId));

    expect(groups).toEqual([WALLET, WALLET, WALLET]);
  });

  test('só o grupo é normalizado: o corpo vai como o produtor montou e a deduplicação é o messageId', async () => {
    const { message, input } = await sentFor(WALLET.toUpperCase());

    expect(JSON.parse(input?.MessageBody ?? '')).toEqual(message);
    expect(message.data.walletId).toBe(WALLET.toUpperCase());
    expect(input?.MessageDeduplicationId).toBe(message.messageId);
  });
});
