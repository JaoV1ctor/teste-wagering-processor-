import { type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import type { LedgerPage } from '../../application/list-ledger.use-case';
import { InvalidMoneyError } from '../../domain/errors';
import { Money, type MoneyProps } from '../../domain/money';
import type { Wallet } from '../../domain/wallet';

/** Validação de entrada na borda: zod. As regras de dinheiro, porém, são de `Money` (única fonte da verdade). */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    return this.schema.parse(value);
  }
}

export const moneySchema = z
  .strictObject({ amount: z.string(), currency: z.string() })
  .transform((raw, ctx): Money => {
    try {
      return Money.fromString(raw.amount, raw.currency);
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) throw error;
      ctx.issues.push({ code: 'custom', message: error.message, input: raw });
      return z.NEVER;
    }
  });

export const CreateWalletBody = z.strictObject({ playerId: z.uuid(), initialBalance: moneySchema });
export const WalletIdParam = z.uuid();
export const LedgerQuery = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.string().regex(/^[1-9]\d{0,8}$/, 'limit deve ser inteiro positivo').transform((value) => parseInt(value, 10)).optional(),
});

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerResponse {
  items: {
    id: string;
    transactionId: string;
    direction: string;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    createdAt: string;
  }[];
  nextCursor: string | null;
}

export const toWalletResponse = (wallet: Wallet): WalletResponse => ({
  id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toProps(), version: wallet.version,
});

export const toLedgerResponse = (page: LedgerPage): LedgerResponse => ({
  items: page.items.map((entry) => ({
    id: entry.id, transactionId: entry.transactionId, direction: entry.direction, money: entry.money.toProps(),
    balanceBefore: entry.balanceBefore.toProps(), balanceAfter: entry.balanceAfter.toProps(), createdAt: entry.createdAt.toISOString(),
  })),
  nextCursor: page.nextCursor ?? null,
});
