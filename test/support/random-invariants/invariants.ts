// As invariantes, conferidas em SQL sobre o banco INTEIRO da execução. Cada consulta devolve as linhas que violam a regra: o esperado é
// sempre nenhuma. Várias repetem constraints do schema de propósito: continuam valendo se uma delas for removida.
import type pg from 'pg';

const EVENT = (type: string) => `(select count(*) from outbox_messages o where o.event_type = '${type}' and o.payload->'data'->>'transactionId' = t.id::text)`;

const VIOLATIONS: [name: string, sql: string][] = [
  ['saldo diferente da soma do ledger',
    `select w.id, w.balance from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id group by w.id
     having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`],
  ['saldo negativo',
    `select id from wallets where balance < 0
     union all select id from wallet_ledger_entries where balance_before < 0 or balance_after < 0`],
  ['mais de uma reversão efetiva da mesma transação',
    `select reference_transaction_id, count(*) from wager_transactions where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'
      group by 1 having count(*) > 1`],
  ['chave de idempotência com mais de uma transação no provedor',
    'select provider_id, idempotency_key from wager_transactions group by 1, 2 having count(*) > 1'],
  ['id externo com mais de uma transação no provedor',
    'select provider_id, external_transaction_id from wager_transactions group by 1, 2 having count(*) > 1'],
  ['lançamento duplicado para a transação na wallet',
    'select transaction_id, wallet_id from wallet_ledger_entries group by 1, 2 having count(*) > 1'],
  ['quantidade de lançamentos incompatível com o estado da transação',
    `select t.id, t.kind, t.status, count(l.id) from wager_transactions t left join wallet_ledger_entries l on l.transaction_id = t.id
      group by t.id having count(l.id) <> case when t.status = 'PROCESSED' and t.kind <> 'LOSS' then 1 else 0 end`],
  ['lançamento com wallet, valor ou direção diferente da transação',
    `select l.id, t.kind, l.direction from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id
       left join wager_transactions r on r.id = t.reference_transaction_id
      where l.wallet_id <> t.wallet_id or l.amount <> t.amount
         or l.direction <> case when t.kind = 'BET' or (t.kind = 'ROLLBACK' and r.kind <> 'BET') then 'DEBIT' else 'CREDIT' end`],
  ['eventos do outbox incompatíveis com o estado da transação',
    `select t.id, t.status, t.attempts from wager_transactions t
      where ${EVENT('WagerTransactionProcessed')} <> (t.status = 'PROCESSED')::int
         or ${EVENT('WagerTransactionRejected')} <> (t.status = 'REJECTED')::int
         or ${EVENT('WagerTransactionPendingReference')} <> (t.attempts > 0)::int`],
  ['WalletBalanceChanged sem correspondência exata com o ledger',
    `select coalesce(l.transaction_id::text, e.payload->'data'->>'transactionId') as transaction_id
       from wallet_ledger_entries l
       full join (select * from outbox_messages where event_type = 'WalletBalanceChanged') e
         on e.payload->'data'->>'transactionId' = l.transaction_id::text
        and e.payload->'data'->>'walletId' = l.wallet_id::text
        and e.payload->'data'->>'direction' = l.direction
        and (e.payload->'data'->'money'->>'amount')::numeric = l.amount
        and (e.payload->'data'->'balanceAfter'->>'amount')::numeric = l.balance_after
      group by 1, l.id having count(*) <> 1 or count(l.id) = 0 or count(e.id) = 0`],
  ['evento de transação que não existe',
    `select o.id, o.event_type from outbox_messages o
      where not exists (select 1 from wager_transactions t where t.id::text = o.payload->'data'->>'transactionId')`],
];

export async function violations(probe: pg.Pool): Promise<string[]> {
  const found: string[] = [];
  for (const [name, sql] of VIOLATIONS) {
    const { rows } = await probe.query(sql);
    if (rows.length > 0) found.push(`${name}: ${rows.length} linha(s), p. ex. ${JSON.stringify(rows[0])}`);
  }
  return found;
}
