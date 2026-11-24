import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { DependencyCheck } from './readiness';

/** `select 1` pelo mesmo pool das requisições: se o pool está esgotado ou o banco não responde, o readiness também não passa. */
export function postgresCheck(orm: MikroORM): DependencyCheck {
  return {
    name: 'postgres',
    check: async () => {
      await orm.em.getConnection().execute('select 1');
    },
  };
}

/**
 * Alcança o SQS E enxerga as filas de que o serviço depende (entrada e eventos): `GetQueueUrl` falha com endpoint fora do ar e com fila inexistente.
 * É só leitura de metadado: não consome nem envia mensagem.
 */
export function sqsCheck(client: SQSClient, queueNames: string[]): DependencyCheck {
  return {
    name: 'sqs',
    check: async (signal) => {
      await Promise.all(queueNames.map((QueueName) => client.send(new GetQueueUrlCommand({ QueueName }), { abortSignal: signal })));
    },
  };
}
