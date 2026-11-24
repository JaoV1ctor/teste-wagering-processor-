import type { LedgerEntry } from '../domain/ledger-entry';
import { WalletNotFoundError } from './errors';
import { decodeCursor, encodeCursor } from './ledger-cursor';
import type { UnitOfWork } from './ports';

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const MAX_LEDGER_PAGE_SIZE = 100;

export interface ListLedgerInput {
  walletId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface LedgerPage {
  items: LedgerEntry[];
  /** Ausente na última página. */
  nextCursor: string | undefined;
}

export class ListLedgerUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  /** Paginação por keyset sobre `seq`: estável mesmo com lançamentos novos entre as chamadas. */
  async execute(input: ListLedgerInput): Promise<LedgerPage> {
    const afterSeq = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const limit = Math.min(input.limit ?? DEFAULT_LEDGER_PAGE_SIZE, MAX_LEDGER_PAGE_SIZE);

    const records = await this.uow.read(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(input.walletId))) throw new WalletNotFoundError(input.walletId);
      return ledger.listByWallet(input.walletId, { afterSeq, limit: limit + 1 }); // +1 revela se há próxima página
    });

    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((record) => record.entry),
      nextCursor: records.length > limit && last ? encodeCursor(last.seq) : undefined,
    };
  }
}
