import { SQSClient } from '@aws-sdk/client-sqs';
import { requireEnv } from '../env';

/** Cliente SQS apontado para o endpoint do ambiente (MiniStack em dev/teste, AWS real em produção). Credenciais só do ambiente. */
export function createSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: requireEnv('AWS_ENDPOINT_URL'),
    region: requireEnv('AWS_REGION'),
    credentials: { accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'), secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY') },
  });
}
