/** Mensagem recebida de uma fila. `id` é o MessageId do SQS (estável entre entregas); o `receiptHandle` muda a cada recebimento. */
export interface QueueMessage {
  id: string;
  receiptHandle: string;
  body: string;
  groupId: string;
  /** `ApproximateReceiveCount`: 1 na primeira entrega. */
  receiveCount: number;
}

export interface ReceiveOptions {
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  /** Aborta o long polling em andamento (shutdown). */
  signal: AbortSignal;
}

/**
 * Porta da fila de entrada. O consumidor só conhece isto; o adaptador real é o SQS. Os testes injetam um decorador sobre o adaptador
 * real (observar ou interceptar uma chamada), nunca um substituto da fila.
 */
export interface MessageQueue {
  receive(options: ReceiveOptions): Promise<QueueMessage[]>;
  /** DeleteMessage. Só depois do commit. */
  acknowledge(message: QueueMessage): Promise<void>;
  /** ChangeMessageVisibility; 0 devolve a mensagem à fila na hora. */
  changeVisibility(message: QueueMessage, seconds: number): Promise<void>;
  /** Copia a mensagem para a DLQ (mesmo MessageGroupId) e NÃO a apaga da fila de origem: quem chama dá o ack depois. */
  deadLetter(message: QueueMessage, reason: string): Promise<void>;
}
