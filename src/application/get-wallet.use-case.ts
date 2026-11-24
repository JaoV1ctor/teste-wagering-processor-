import type { Wallet } from '../domain/wallet';
import { WalletNotFoundError } from './errors';
import type { UnitOfWork } from './ports';

export class GetWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read(({ wallets }) => wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }
}
