import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case';
import { GetWalletUseCase } from '../../application/get-wallet.use-case';
import { ListLedgerUseCase } from '../../application/list-ledger.use-case';
import {
  CreateWalletBody, LedgerQuery, type LedgerResponse, toLedgerResponse, toWalletResponse, WalletIdParam,
  type WalletResponse, ZodValidationPipe,
} from './wallets.dto';

/** Só traduz entrada e saída; a regra está nos casos de uso. */
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListLedgerUseCase,
  ) {}

  @Post()
  async create(@Body(new ZodValidationPipe(CreateWalletBody)) body: z.output<typeof CreateWalletBody>): Promise<WalletResponse> {
    return toWalletResponse(await this.createWallet.execute(body));
  }

  @Get(':walletId')
  async get(@Param('walletId', new ZodValidationPipe(WalletIdParam)) walletId: string): Promise<WalletResponse> {
    return toWalletResponse(await this.getWallet.execute(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ZodValidationPipe(WalletIdParam)) walletId: string,
    @Query(new ZodValidationPipe(LedgerQuery)) query: z.output<typeof LedgerQuery>,
  ): Promise<LedgerResponse> {
    return toLedgerResponse(await this.listLedger.execute({ walletId, cursor: query.cursor, limit: query.limit }));
  }
}
