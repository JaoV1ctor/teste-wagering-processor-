import { InboxMessage } from '../../domain/inbox-message';
import { InboxMessageEntity } from './inbox-message.entity';

export const InboxMessageMapper = {
  toDomain(entity: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: entity.consumerName, messageId: entity.messageId, payloadHash: entity.payloadHash,
      receivedAt: entity.receivedAt, processedAt: entity.processedAt ?? undefined,
    });
  },

  toEntity(message: InboxMessage): InboxMessageEntity {
    const entity = new InboxMessageEntity();
    entity.consumerName = message.consumerName;
    entity.messageId = message.messageId;
    entity.payloadHash = message.payloadHash;
    entity.receivedAt = message.receivedAt;
    entity.processedAt = message.processedAt ?? null;
    return entity;
  },
};
