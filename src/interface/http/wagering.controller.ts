import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { z } from 'zod';
import { GetWagerTransactionUseCase } from '../../application/get-wager-transaction.use-case';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import {
  httpStatusFor, IdempotencyKeyHeader, ProviderTransactionParams, SubmitTransactionBody, type SubmitResponse, toSubmitResponse,
  toTransactionResponse, TransactionIdParam, type TransactionResponse,
} from './wagering.dto';
import { ZodValidationPipe } from './wallets.dto';

interface StatusSetter {
  status(code: number): unknown;
}

/** Só traduz entrada e saída; a regra está em `ProcessWagerTransactionUseCase` (o mesmo que a Fase 4 usará para SQS). */
@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(SubmitTransactionBody)) body: z.output<typeof SubmitTransactionBody>,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<SubmitResponse> {
    // O Nest não aplica pipes a @Headers (só a body, query e param): o cabeçalho é validado aqui.
    const idempotencyKey = IdempotencyKeyHeader.parse(rawIdempotencyKey);
    const result = await this.processWager.execute({
      idempotencyKey, providerId: body.providerId, externalTransactionId: body.externalTransactionId, playerId: body.playerId,
      walletId: body.walletId, roundId: body.roundId, gameId: body.gameId, kind: body.kind, money: body.money,
      ...(body.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: body.referenceExternalTransactionId }),
    });
    response.status(httpStatusFor(result.transaction.status));
    return toSubmitResponse(result);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId', new ZodValidationPipe(TransactionIdParam)) transactionId: string): Promise<TransactionResponse> {
    return toTransactionResponse(await this.getTransaction.byId(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProviderExternalId(
    @Param(new ZodValidationPipe(ProviderTransactionParams)) params: z.output<typeof ProviderTransactionParams>,
  ): Promise<TransactionResponse> {
    return toTransactionResponse(await this.getTransaction.byProviderExternalId(params.providerId, params.externalTransactionId));
  }
}
