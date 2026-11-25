import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { z } from 'zod';
import { GetWagerTransactionUseCase } from '../../application/get-wager-transaction.use-case';
import type { ProviderIdentityPort } from '../../application/ports';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import {
  CorrelationIdHeader, httpStatusFor, IdempotencyKeyHeader, ProviderTransactionParams, SubmitTransactionBody, type SubmitResponse, toSubmitResponse,
  toTransactionResponse, TransactionIdParam, type TransactionResponse,
} from './wagering.dto';
import { ZodValidationPipe } from './wallets.dto';

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

interface StatusSetter {
  status(code: number): unknown;
}

/** Só traduz entrada e saída; a regra está em `ProcessWagerTransactionUseCase` (o mesmo do consumidor SQS). */
@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
    @Inject(PROVIDER_IDENTITY) private readonly providerIdentity: ProviderIdentityPort,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Headers('x-correlation-id') rawCorrelationId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(SubmitTransactionBody)) body: z.output<typeof SubmitTransactionBody>,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<SubmitResponse> {
    // O Nest não aplica pipes a @Headers (só a body, query e param): o cabeçalho é validado aqui.
    const idempotencyKey = IdempotencyKeyHeader.parse(rawIdempotencyKey);
    const correlationId = CorrelationIdHeader.parse(rawCorrelationId);
    await this.providerIdentity.ensureCanActAs({ declaredProviderId: body.providerId, authorization });
    const result = await this.processWager.execute({
      idempotencyKey, ...(correlationId === undefined ? {} : { correlationId }), providerId: body.providerId, externalTransactionId: body.externalTransactionId, playerId: body.playerId,
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
