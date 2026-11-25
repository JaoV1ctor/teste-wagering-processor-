# Testes de abuso e segurança

**Isto não é um pentest nem uma certificação.** É uma suíte automatizada que ataca a API e a fila com casos conhecidos e registra o que foi testado, o que passou e o que não foi coberto. Passar não significa que o serviço seja seguro; **o serviço não tem autenticação** e não deve ser exposto fora de uma rede confiável.

## Como rodar

```bash
docker compose up -d
bun run test:security
```

Aplicação real sobre o PostgreSQL e o MiniStack do `docker-compose.yml`, sem mocks desses dois. Cada arquivo de `test/security/` cria um banco e filas próprios e os apaga no fim. O relatório vai para `security-results/report.md` (ignorado pelo git) e o comando sai com código diferente de zero se algum caso falhar. Não usa rede externa.

- **passou:** o resultado esperado, que é o comportamento desejado, foi observado.
- **limitação confirmada:** o teste fixa o comportamento **atual**, mais fraco que o desejável. Passar significa que a limitação continua lá.
- Em casos de rejeição, o teste também confere que nada mudou no banco (wallets, saldos, versões, transações, ledger, inbox e outbox) e que a resposta não traz stack trace, SQL, erro do banco, string de conexão ou caminho do servidor.
- Alguns testes injetam falhas ou trocam um adaptador em memória (porta de identidade que nega, exceção no caso de uso); o banco e a fila continuam reais.

## Achados

Severidade: **alta** compromete dinheiro ou dados se o serviço for exposto; **média** permite negar serviço ou atrapalhar outro provedor; **baixa** é endurecimento ou resposta errada sem dano a saldo; **informativa** é comportamento a conhecer. Não foi encontrado vazamento de dados entre provedores, gasto duplo nem saldo negativo.

| # | Achado | Severidade | Decisão |
| --- | --- | --- | --- |
| 1 | Byte nulo em campo de texto virava erro de protocolo do PostgreSQL, tratado como transitório: `503` ("reenvie") no HTTP e, na fila, a mensagem não ia para a DLQ no prazo observado | média | **Corrigido**: `400` no HTTP e DLQ `MALFORMED_MESSAGE` na fila |
| 2 | Surrogate UTF-16 solto em campo de texto produzia `500` | baixa | **Corrigido** pelo mesmo schema de texto |
| 3 | `X-Powered-By: Express` em toda resposta | baixa | **Corrigido** |
| 4 | Corpo de formulário era aceito: `POST /wallets` criava wallet a partir de um formulário, que uma página de outra origem envia sem preflight | baixa | **Corrigido**: `415` |
| 5 | Sem autenticação nem autorização: qualquer chamador lê qualquer wallet e transação pelo id e envia transações em nome de qualquer provedor | alta | **Limitação declarada**; desenho e ponto de extensão em "Autenticação" no documento de arquitetura |
| 6 | A porta de identidade do provedor só é consultada em `POST /wagering/transactions`; as consultas não passam por ela | baixa | Limitação; ligar a porta na consulta por provedor junto com a autenticação |
| 7 | A `Idempotency-Key` era única no serviço inteiro: um provedor podia gravar antes a chave que outro usaria, e o legítimo recebia `409` permanente. Não havia vazamento de dados | média | **Corrigido**: `UNIQUE (provider_id, idempotency_key)`, por migration reversível; toda busca por chave filtra também pelo provedor |
| 8 | Uma wallet travada esgota o pool de conexões de uma instância: requisições de **outras** wallets esperam e `/health/ready` responde `503`, o que poderia levar um orquestrador a agir sobre uma instância saudável | média | **Não corrigido**; caminho de evolução: teto de requisições em voo por wallet dentro da instância, `statement_timeout` para a espera total e uma conexão dedicada ao readiness |
| 9 | Sem rate limiting | média | Limitação; aplicar no gateway, por provedor |
| 10 | A fila de entrada não é autenticada: quem publica nela move qualquer wallet | média | Decisão de projeto (canal interno): a proteção é a política da fila (IAM) |
| 11 | `docker-compose.yml` tem senha de desenvolvimento e publica as portas 5432 e 4566 em todas as interfaces | baixa | Limitação do ambiente local; restringir a `127.0.0.1` antes de usar em rede compartilhada |
| 12 | Sem `Strict-Transport-Security`, `X-Content-Type-Options` e `Cache-Control` | informativa | Responsabilidade do proxy que terminar o TLS |
| 13 | A mensagem de validação de valor ou moeda repete o texto enviado (em JSON, só para quem enviou; o tamanho é limitado pelo do corpo) | informativa | Mantido |
| 14 | Chave repetida no JSON: vale a última ocorrência | informativa | Mantido; comportamento do `JSON.parse` |
| 15 | Na fila, a deduplicação do inbox é por `(consumidor, messageId)`, não por provedor: quem publicar antes um `messageId` faz a mensagem legítima com o mesmo id ir à DLQ | média | **Não corrigido**: a fila é tratada como canal interno; produtores precisam de ids únicos entre si |

Nos achados 1 a 4 o teste foi escrito primeiro, falhou e passou depois da correção (1 e 2 em um commit; 3 e 4 em um commit cada), com as suítes de unidade, integração e concorrência completas depois de cada um. Antes da correção, pela API, o byte nulo respondia `503` e o surrogate solto `500`; pela fila, a mensagem não chegou à DLQ nos 15 s do teste.

O achado 7 foi corrigido depois, também com os testes primeiro: com a chave global falhavam 6 dos 7 testes de `test/integration/idempotency-scope.test.ts` e 2 dos 3 de `test/concurrency/idempotency-scope.test.ts`. Trocar o `providerId` de um payload copiado agora cria uma transação própria em vez de `409`; sem autenticação (achado 5), o mesmo débito já era possível trocando também a chave.

## Resultados

Copiado do relatório gerado pela execução. A única edição está nos casos de segredos: as contagens que mudam a cada commit (linhas e commits varridos, strings de conexão encontradas) ficam só no relatório.

Execução de 2026-11-25T18:40:05.741Z, Bun 1.4.4: 92 casos em 10 categorias; 78 passaram, 14 confirmam limitações e 0 falharam.

### 1. Injeção e entradas malformadas

| Caso | Esperado | Observado | Resultado |
| --- | --- | --- | --- |
| SQL injection em campos de texto livre | aceito como dado (201/202) e gravado literalmente; nada executado; nunca 500 | 40 envios: 201×32, 202×8; valor gravado byte a byte; tabelas intactas | passou |
| SQL injection em campos com formato (UUID, tipo, dinheiro) | 400, sem vazamento, banco inalterado | 48 tentativas: 400×48; banco inalterado | passou |
| Mensagem de validação de valor ou moeda repete o texto enviado | 400; o eco vem só da entrada do próprio chamador, em JSON | 400 em application/json; o valor enviado volta em details[].message | limitação confirmada |
| SQL injection em ids de rota, cursor e limit | 400 ou 404, sem vazamento, banco inalterado | 56 tentativas: 400×48, 404×8; banco inalterado | passou |
| SQL injection na Idempotency-Key e no x-correlation-id | aceitos como dado (201); chave gravada literalmente | 8 envios: 201×8 | passou |
| Unicode incomum válido (emoji, controle de direção, largura zero, combinantes) | aceito como dado e gravado exatamente | 35 envios: 201×28, 202×7; valor gravado byte a byte; tabelas intactas | passou |
| Byte nulo e surrogate solto em campos de texto do corpo | 400 (nunca 500 nem 503, que mandariam reenviar); banco inalterado | 25 tentativas: 400×25; banco inalterado | passou |
| Byte nulo em ids de rota | 400; banco inalterado | 6 tentativas: 400×6; banco inalterado | passou |
| CR e LF dentro de campos do corpo | aceitos como dado; nenhum cabeçalho injetado; logs continuam uma linha JSON por evento | 5 envios: 201×4, 202×1; sem Set-Cookie; nenhuma linha de log forjada | passou |
| CR ou LF soltos em cabeçalhos (bytes crus no socket) | 400 do servidor HTTP; nenhum cabeçalho injetado; banco inalterado | 6 requisições: 400×6; nada gravado | passou |
| Textos muito longos em campos, cabeçalhos e rotas | 400 (ou 431 quando o servidor HTTP recusa o cabeçalho); banco inalterado | 18 tentativas: 400×16, 431×2; banco inalterado | passou |

### 2. Abuso de valores monetários

| Caso | Esperado | Observado | Resultado |
| --- | --- | --- | --- |
| Valores negativos | 400; saldo e banco inalterados | 20 tentativas: 400×20; banco inalterado | passou |
| Zero em aposta (initialBalance zero é válido e tem caso próprio) | 400; saldo e banco inalterados | 12 tentativas: 400×12; banco inalterado | passou |
| NaN, Infinity e notação exponencial ou outras bases | 400; saldo e banco inalterados | 44 tentativas: 400×44; banco inalterado | passou |
| Mais de 2 casas decimais | 400 antes de chegar ao banco (que arredondaria em silêncio) | 20 tentativas: 400×20; banco inalterado | passou |
| Formatos disfarçados (espaços, separadores, sinais, dígitos não ASCII, byte nulo) | 400; saldo e banco inalterados | 64 tentativas: 400×64; banco inalterado | passou |
| Valores enormes e acima de NUMERIC(19,2) | 400; saldo e banco inalterados | 20 tentativas: 400×20; banco inalterado | passou |
| Número, nulo, booleano, objeto ou array no lugar da string | 400; saldo e banco inalterados | 13 tentativas: 400×13; banco inalterado | passou |
| Literais NaN e Infinity sem aspas (JSON inválido) | 400; saldo e banco inalterados | 5 tentativas: 400×5; banco inalterado | passou |
| Moeda fora do formato | 400; saldo e banco inalterados | 19 tentativas: 400×19; banco inalterado | passou |
| Campos extras ou ausentes em money | 400; saldo e banco inalterados | 6 tentativas: 400×6; banco inalterado | passou |
| BET no valor máximo do tipo | 422 INSUFFICIENT_BALANCE; saldo inalterado | 422 INSUFFICIENT_BALANCE | passou |
| WIN que estouraria o saldo máximo | 422 BALANCE_LIMIT_EXCEEDED, nunca 500; saldo inalterado | 422 BALANCE_LIMIT_EXCEEDED | passou |
| Moeda válida, porém diferente da wallet | 422 CURRENCY_MISMATCH; saldo inalterado | 422 CURRENCY_MISMATCH | passou |
| initialBalance zero (valor válido) | 201 sem lançamento no ledger | 201; 0 lançamentos | passou |
| Chave "amount" duplicada no JSON | vale a última ocorrência (regra do JSON.parse); um só movimento | 201×1; debitado o último valor (2.00); chaves duplicadas não são recusadas | limitação confirmada |

### 3. Abuso de corpo e protocolo

| Caso | Esperado | Observado | Resultado |
| --- | --- | --- | --- |
| Corpo gigante (200 KB a 20 MB) | 413; banco inalterado | 6 tentativas: 413×6; banco inalterado | passou |
| Corpo comprimido que expande além do limite (gzip) | 413: o limite vale para o corpo descomprimido | 2 tentativas: 413×2; banco inalterado | passou |
| Codificação ou charset desconhecidos e gzip corrompido | 400 ou 415; banco inalterado | 6 tentativas: 400×2, 415×4; banco inalterado | passou |
| JSON inválido ou truncado | 400; banco inalterado | 24 tentativas: 400×24; banco inalterado | passou |
| Primitivo ou array no lugar do objeto | 400; banco inalterado | 16 tentativas: 400×16; banco inalterado | passou |
| JSON muito aninhado (até o limite de tamanho) | 400 (nunca 500 nem processo derrubado); o serviço segue respondendo | 8 tentativas: 400×8; banco inalterado | passou |
| Content-Type ausente, textual, XML ou multipart | 400 ou 415; banco inalterado | 12 tentativas: 400×12; banco inalterado | passou |
| Corpo de formulário (o que uma página de outra origem consegue enviar sem preflight) | 415; nenhuma wallet criada | 9 tentativas: 415×9; banco inalterado | passou |
| Chaves "__proto__", "constructor" e "prototype" | 400 (campo desconhecido); nenhum protótipo poluído | 15 tentativas: 400×15; banco inalterado; Object.prototype intacto | passou |
| Parâmetros de consulta repetidos ou em forma de objeto | 400; banco inalterado | 9 tentativas: 400×9; banco inalterado | passou |
| Métodos HTTP não previstos (nenhuma rota apaga nem altera) | 404; banco inalterado | 24 tentativas: 404×24; banco inalterado | passou |
| TRACE, CONNECT e métodos inventados (bytes crus) | 400 ou 404, sem eco da requisição; banco inalterado | 400×3, 404×1 | passou |
| Codificação percentual malformada na URL | 400 em JSON, sem stack trace | 5 tentativas: 400×5; banco inalterado | passou |
| Travessia de caminho na URL | 400 ou 404; nenhum arquivo do servidor exposto | 6 tentativas: 400×1, 404×5; banco inalterado | passou |

### 4. Idempotência e separação entre provedores

| Caso | Esperado | Observado | Resultado |
| --- | --- | --- | --- |
| Mesmo provedor, mesma chave, cada campo de negócio diferente | 409 IDEMPOTENCY_CONFLICT; banco inalterado | 8 variações: 409×8; banco inalterado | passou |
| PROVEDOR DIFERENTE usa a chave de outro, com a própria wallet | 201 com transação própria; nada do primeiro na resposta; saldo do primeiro inalterado | 201, transação própria do segundo; saldo do primeiro inalterado e o replay dele continua o original | passou |
| Provedor diferente copia chave e campos, trocando só o providerId | comportamento atual: nunca recebe o original, mas cria transação própria sobre a wallet citada (não há autenticação) | 201 sem o id nem o saldo do original; a wallet foi debitada de novo, em nome do segundo provedor | limitação confirmada |
| Dois provedores usam a mesma chave ao mesmo tempo (20 rodadas) | os dois 201, cada um com a própria transação; nenhum dado cruzado | 201×40 em 20 rodadas; nenhum dado cruzado | passou |
| Consulta por identidade do provedor é separada | 404 ao perguntar pelo id externo de outro sob o próprio providerId | 404 TRANSACTION_NOT_FOUND | passou |
| Outro provedor tenta reverter a transação alheia citando o id externo | 202 pendente: a referência é resolvida dentro do próprio provedor; nada creditado | 202 PENDING_REFERENCE, balance null; saldo do primeiro inalterado | passou |
| Ocupação antecipada da chave: B grava antes a chave que A usaria | A é aceito normalmente: a chave de B não ocupa a de A | B: 201; A: 201 e depois replay do próprio resultado | passou |
| Replay idêntico, por quem conhece a chave e todos os campos | comportamento atual: devolve o resultado, porque nada identifica quem chama | sem autenticação, quem conhece o payload inteiro e a chave recebe o resultado como o próprio provedor | limitação confirmada |

### 5. Autorização

| Caso | Esperado | Observado | Resultado |
| --- | --- | --- | --- |
| Qualquer chamador lê wallet, ledger e transação alheios pelo id | comportamento atual: 200 sem credencial alguma | sem Authorization: 200×5 | limitação confirmada |
| Credenciais forjadas não são verificadas | comportamento atual: ignoradas, 200 | 200×10 | limitação confirmada |
| Qualquer chamador envia transação em nome de qualquer provedor e wallet | comportamento atual: 201 | 201: o providerId do corpo é aceito como declarado | limitação confirmada |
| Porta de identidade que nega: submissão | 403 antes de qualquer efeito; banco inalterado | envio novo e replay: 403×2; banco inalterado | passou |
| Guard que nega: todas as rotas protegidas | 403; banco inalterado; health e metrics continuam abertos | protegidas: 403×7; abertas: 200×3 | passou |
| A porta de identidade não cobre as consultas | comportamento atual: com a porta negando, as consultas respondem 200 | porta negando: consultas 200×5 (só o POST de transação a consulta) | limitação confirmada |

### 6. Gasto duplo

| Caso | Esperado | Observado | Resultado |
| --- | --- | --- | --- |
| 50 apostas paralelas, chaves diferentes, saldo para uma só (uma instância) | exatamente 1 aceita e 49 INSUFFICIENT_BALANCE | 3 rodadas de 50: 201×3, 422×147; saldo 0.00, 1 débito por wallet, nenhum saldo negativo | passou |
| O mesmo distribuído entre duas instâncias | exatamente 1 aceita; a garantia vem do banco | 3 rodadas de 50: 201×3, 422×147; saldo 0.00, 1 débito por wallet, nenhum saldo negativo | passou |
| 50 estornos paralelos da mesma aposta, ids e chaves diferentes | exatamente 1 crédito; 49 ALREADY_REVERSED | 201×1, 422×49; saldo 80.00 com um único crédito | passou |
| Estorno disputando com novas apostas do mesmo dinheiro | o saldo nunca fica negativo e fecha com o ledger | 201×2, 422×29; saldo igual ao ledger, nunca negativo | passou |

### 7. Vazamento de informação

| Caso | Esperado | Observado | Resultado |
| --- | --- | --- | --- |
| Corpos de erro 400, 404, 409, 413, 415 e 422 | só code, message e, na validação, details; sem stack, SQL ou credencial | 400×3, 404×3, 409×2, 413×1, 415×1, 422×1; nenhum detalhe interno | passou |
| Erro interno inesperado com segredos na mensagem da exceção | 500 genérico; nem resposta nem log levam a mensagem | 500 INTERNAL_ERROR; log com a classe do erro, sem a mensagem | passou |
| Banco inacessível, com senha na string de conexão | 503 com Retry-After; sem endereço nem credencial em resposta ou log | 503×3; sem host, porta ou senha | passou |
| Logs durante uma rajada de ataques | uma linha JSON por evento; sem corpo, valores, chave, playerId, rodada, jogo ou segredos | 8 requisições (200×1, 201×3, 400×3, 409×1), 4 linhas de log; nenhuma das 8 marcas | passou |
| /metrics e /health sem dado de cliente | nenhum id, marca, valor ou segredo; rótulos só de status, tipo e origem | rótulos: kind, le, status; health: {"status":"ok"} {"status":"ok","checks":{"postgres":"up","sqs":"up"}} | passou |
| Rota inexistente | 404 em JSON, sem banner nem página do framework | 404×7; corpo fixo | passou |
| Cabeçalho que anuncia o framework | sem X-Powered-By nem Server, em respostas de sucesso, erro e rota inexistente | 200×1, 400×2, 404×2; sem X-Powered-By e sem Server | passou |
| Sem cabeçalho CORS: página de outra origem não lê respostas | nenhum Access-Control-Allow-Origin | sem Access-Control-Allow-Origin (200×1, 404×1) | passou |
| Cabeçalhos de endurecimento ausentes | comportamento atual: sem HSTS, X-Content-Type-Options ou Cache-Control | ausentes: strict-transport-security, x-content-type-options, cache-control | limitação confirmada |

### 8. Mensagens SQS venenosas

| Caso | Esperado | Observado | Resultado |
| --- | --- | --- | --- |
| Corpo que não é um envelope JSON | DLQ MALFORMED_MESSAGE; consumidor segue | 9 veneno(s) na DLQ (MALFORMED_MESSAGE×9), sem escrita; a mensagem válida seguinte foi sempre processada | passou |
| Campos faltando ou com tipo errado | DLQ MALFORMED_MESSAGE; consumidor segue | 16 veneno(s) na DLQ (MALFORMED_MESSAGE×16), sem escrita; a mensagem válida seguinte foi sempre processada | passou |
| Byte nulo e surrogate solto em campos de texto da mensagem | DLQ MALFORMED_MESSAGE, enviada pelo próprio consumidor (com FailureReason); nada gravado | 6 veneno(s) na DLQ (MALFORMED_MESSAGE×6), sem escrita; a mensagem válida seguinte foi sempre processada | passou |
| Dinheiro abusivo na mensagem | DLQ MALFORMED_MESSAGE; saldo inalterado | 8 veneno(s) na DLQ (MALFORMED_MESSAGE×8), sem escrita; a mensagem válida seguinte foi sempre processada | passou |
| Tipo de mensagem desconhecido | DLQ UNKNOWN_MESSAGE_TYPE | 1 veneno(s) na DLQ (UNKNOWN_MESSAGE_TYPE×1), sem escrita; a mensagem válida seguinte foi sempre processada | passou |
| Wallet inexistente | DLQ WALLET_NOT_FOUND, nada gravado | 1 veneno(s) na DLQ (WALLET_NOT_FOUND×1), sem escrita; a mensagem válida seguinte foi sempre processada | passou |
| Mensagem enorme dentro do limite do broker (200 KB) | DLQ MALFORMED_MESSAGE | 1 veneno(s) na DLQ (MALFORMED_MESSAGE×1), sem escrita; a mensagem válida seguinte foi sempre processada | passou |
| Mensagem acima do limite do SQS (2 MB) | recusada pelo broker, ou entregue e enviada à DLQ; consumidor segue | recusada pelo broker no envio; a válida seguinte foi processada | passou |
| messageId repetido com conteúdo diferente | DLQ INBOX_PAYLOAD_CONFLICT; só o primeiro conteúdo é aplicado | 1 veneno(s) na DLQ (INBOX_PAYLOAD_CONFLICT×1), sem escrita; a mensagem válida seguinte foi sempre processada | passou |
| Outro provedor reutiliza pela fila a chave de um primeiro | as duas aplicadas, cada uma no próprio provedor; nada na DLQ | 2 lançamentos, DLQ vazia | passou |
| Outro provedor ocupa antes o messageId de um primeiro | comportamento atual: a messageId vale para o consumidor inteiro; a mensagem legítima vai à DLQ | a legítima não foi aplicada: 1 veneno(s) na DLQ (INBOX_PAYLOAD_CONFLICT×1), sem escrita; a mensagem válida seguinte foi sempre processada | limitação confirmada |
| Logs do consumidor durante os venenos | uma linha JSON por evento, sem o corpo da mensagem | 4 linhas de log, sem a marca nem o valor | passou |
| A fila de entrada não é autenticada | comportamento atual: quem consegue publicar na fila move qualquer wallet | WIN de um providerId desconhecido foi creditado; a proteção depende da política da fila | limitação confirmada |

### 9. Disponibilidade

| Caso | Esperado | Observado | Resultado |
| --- | --- | --- | --- |
| Wallet travada: a submissão não fica pendurada | 503 com Retry-After em poucos segundos; nada gravado; depois 201 | 503×8 com Retry-After: 1 (lock_timeout de 300 ms, 3 tentativas); após liberar, 201 | passou |
| Poucas requisições contra uma wallet travada não derrubam as outras | outra wallet responde 201 enquanto a primeira está travada | outra wallet: 201 | passou |
| Uma wallet travada esgota o pool e atrasa TODAS as outras e o readiness | comportamento atual: outra wallet só responde quando uma conexão é liberada; /health/ready vira 503 | 30 requisições numa wallet travada: 10 conexões presas; outra wallet sem resposta até a liberação (depois 201); ready 503 | limitação confirmada |
| Não há rate limiting | comportamento atual: 500 requisições seguidas de um mesmo chamador, nenhuma 429 | 200×500; nenhuma limitação por origem, provedor ou rota | limitação confirmada |
| Corpos grandes repetidos não derrubam o serviço | 413 em todos e health 200 em seguida | 20 corpos de 5 MB: 413×20; ready 200 | passou |

### 10. Segredos e configuração

| Caso | Esperado | Observado | Resultado |
| --- | --- | --- | --- |
| Credenciais reconhecíveis nos arquivos versionados | nenhuma ocorrência | 8 padrões, nenhuma ocorrência | passou |
| Credenciais reconhecíveis no histórico do git | nenhuma linha adicionada em commit algum | todas as linhas adicionadas no histórico foram varridas; nenhuma ocorrência | passou |
| Senhas em strings de conexão versionadas | só as de desenvolvimento local | todas as encontradas apontam para localhost ou nomes fictícios de teste | passou |
| .env fora do git, hoje e no histórico | .env ignorado, não rastreado e nunca commitado | ignorado; só .env.example rastreado; nenhum .env em commit algum | passou |
| .env.example só com valores do ambiente local | exatamente as variáveis e os valores locais previstos; qualquer outro valor reprova | 8 variáveis, todas com os valores do ambiente local | passou |
| Senha fixa no docker-compose.yml | comportamento atual: credencial de desenvolvimento versionada e porta publicada no host | POSTGRES_PASSWORD de desenvolvimento e portas 5432 e 4566 publicadas em todas as interfaces | limitação confirmada |
| Dependências com versão fixa e lockfile versionado | sem ^ ou ~; bun.lock rastreado | 18 dependências diretas com versão exata | passou |

## Auditoria de dependências

`bun audit` consulta o registro de pacotes, por isso não faz parte da suíte. Execução manual em 2026-11-25 (UTC 17:39), saída completa:

```
[0.16ms] ".env"
bun audit v1.4.4 (38afee6c8)

No vulnerabilities found (checked 237 packages) [263.00ms]
```

Vale para essa data e para o `bun.lock` desse momento. Ausência de aviso não significa ausência de vulnerabilidade.

## Não coberto

- **Autenticação e autorização reais:** não existem; só se testou que o ponto de extensão consegue negar.
- **TLS:** o serviço fala HTTP puro; nada sobre certificados, versões ou cifras.
- **Rate limiting:** não existe.
- **DoS volumétrico:** nenhum teste de volume, conexões lentas (*slowloris*), exaustão de sockets ou de memória. Os casos de disponibilidade usam poucas dezenas ou centenas de requisições.
- **WAF** ou qualquer proteção na borda de rede.
- **SQS com mensagem assinada** ou autenticação do produtor; políticas IAM não existem no MiniStack.
- **AWS real:** limites de tamanho, caracteres aceitos e permissões do SQS podem diferir dos do MiniStack.
- *Fuzzing* sistemático, análise estática de segurança, varredura de imagens de container e revisão manual por terceiros.
- *Request smuggling* atrás de proxy, ataques de temporização e canais laterais (sem autenticação, quem declara o `providerId` de outro descobre, pela resposta `409`, que ele já usou a chave).
- Privilégios do banco: a aplicação conecta como dona das tabelas e não há papel restrito.
- Segredos: a busca usa padrões conhecidos nos arquivos e no histórico local; um segredo sem formato reconhecível passaria.
