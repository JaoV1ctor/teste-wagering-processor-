import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionNotFoundError } from './errors';
import type { UnitOfWork } from './ports';

/** Consultas: leitura sem lock, devolvem o último estado commitado. */
export class GetWagerTransactionUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    return found(await this.uow.read(({ transactions }) => transactions.findById(transactionId)));
  }

  async byProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return found(await this.uow.read(({ transactions }) => transactions.findByProviderExternalId(providerId, externalTransactionId)));
  }
}

function found(transaction: WagerTransaction | undefined): WagerTransaction {
  if (!transaction) throw new WagerTransactionNotFoundError();
  return transaction;
}
