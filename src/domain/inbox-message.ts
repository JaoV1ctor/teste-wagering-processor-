import { InvalidInboxMessageError } from './errors';

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  /** SHA-256 dos campos de negócio da mensagem: detecta o mesmo `messageId` reutilizado com outro hash. Metadados não entram. */
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | undefined;
}

export type ReceiveInboxMessageProps = Pick<InboxMessageState, 'consumerName' | 'messageId' | 'payloadHash'> & { now: Date };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Registro de dedup de uma mensagem de entrada. A chave `(consumerName, messageId)` é imposta pelo banco (PK). */
export class InboxMessage {
  private constructor(private state: InboxMessageState) {}

  static receive({ consumerName, messageId, payloadHash, now }: ReceiveInboxMessageProps): InboxMessage {
    if (consumerName === '' || messageId === '') throw new InvalidInboxMessageError('consumerName e messageId são obrigatórios');
    if (!SHA256_HEX.test(payloadHash)) throw new InvalidInboxMessageError('payloadHash deve ser SHA-256 em hexadecimal minúsculo');
    return new InboxMessage({ consumerName, messageId, payloadHash, receivedAt: now, processedAt: undefined });
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...state });
  }

  get consumerName(): string { return this.state.consumerName; }
  get messageId(): string { return this.state.messageId; }
  get payloadHash(): string { return this.state.payloadHash; }
  get receivedAt(): Date { return this.state.receivedAt; }
  get processedAt(): Date | undefined { return this.state.processedAt; }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new InvalidInboxMessageError('Mensagem já marcada como processada');
    this.state = { ...this.state, processedAt: at };
  }

  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }
}
