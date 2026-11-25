// Segredos versionados e configuração de ambiente. Só lê o repositório local (arquivos rastreados e histórico do git); não usa rede.
// A auditoria de dependências (`bun audit`) consulta um serviço externo e por isso é rodada e registrada à parte.
import { afterAll, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { securityCategory } from '../support/security';

const { securityCase, write } = securityCategory(10, 'Segredos e configuração');
afterAll(() => write());

function git(...args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(['git', ...args]);
  return { code: result.exitCode, out: result.stdout.toString() };
}

/** Formatos de credencial reconhecíveis. Escritos com classes e repetições para este arquivo não casar consigo mesmo. */
const SECRET_PATTERNS: [string, string][] = [
  ['chave de acesso AWS', '(AKIA|ASIA)[0-9A-Z]{16}'],
  ['chave privada', '-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}'],
  ['token do GitHub', '(gh[pousr]_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{22,})'],
  ['token do Slack', 'xox[abprs]-[0-9A-Za-z-]{10,}'],
  ['chave de API no formato sk-', 'sk-[A-Za-z0-9_-]{32,}'],
  ['chave de API do Google', 'AIza[0-9A-Za-z_-]{35}'],
  ['segredo da AWS atribuído', '[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]_[Aa][Cc][Cc][Ee][Ss][Ss]_[Kk][Ee][Yy] *[=:] *[A-Za-z0-9/+]{40}'],
  ['JWT assinado', 'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{20,}'],
];

securityCase('Credenciais reconhecíveis nos arquivos versionados', 'nenhuma ocorrência', async () => {
  const found = SECRET_PATTERNS.flatMap(([name, pattern]) => {
    const { code, out } = git('grep', '-n', '-I', '-E', '-e', pattern);
    expect([0, 1]).toContain(code); // 1: sem ocorrência; outro código é erro do próprio git
    return code === 0 ? [`${name}: ${out.split('\n')[0]}`] : [];
  });
  expect(found).toEqual([]);
  return `${SECRET_PATTERNS.length} padrões, nenhuma ocorrência`;
});

securityCase('Credenciais reconhecíveis no histórico do git', 'nenhuma linha adicionada em commit algum', async () => {
  const history = git('log', '--all', '-p', '--no-color', '--unified=0').out;
  const added = history.split('\n').filter((line) => line.startsWith('+'));
  const found = SECRET_PATTERNS.filter(([, pattern]) => added.some((line) => new RegExp(pattern).test(line))).map(([name]) => name);
  expect(found).toEqual([]);
  return `${added.length} linhas adicionadas em ${git('rev-list', '--all', '--count').out.trim()} commits, nenhuma ocorrência`;
});

securityCase('Senhas em strings de conexão versionadas', 'só as de desenvolvimento local', async () => {
  const { out } = git('grep', '-h', '-o', '-I', '-E', '-e', '(postgres(ql)?|amqp|redis|mongodb(\\+srv)?)://[^ :/@\'"`]+:[^ @\'"`]+@[^ /\'"`]+');
  const urls = [...new Set(out.split('\n').filter((line) => line !== ''))];
  // Locais (senha de desenvolvimento do compose) e as marcas falsas desta suíte, apontadas para a máquina local.
  const remote = urls.filter((url) => !/@(localhost|127\.0\.0\.1|db|host)(:\d+)?$/.test(url));
  expect(remote).toEqual([]);
  return urls.length === 0 ? 'nenhuma string com senha' : `${urls.length}, todas para localhost ou nomes fictícios de teste`;
});

securityCase('.env fora do git, hoje e no histórico', '.env ignorado, não rastreado e nunca commitado', async () => {
  expect(git('check-ignore', '-q', '.env').code).toBe(0);
  const tracked = git('ls-files').out.split('\n').filter((file) => /(^|\/)\.env(\..*)?$/.test(file));
  expect(tracked).toEqual(['.env.example']);
  const committed = git('log', '--all', '--name-only', '--pretty=format:').out.split('\n').filter((file) => /(^|\/)\.env(\.(?!example$).*)?$/.test(file));
  expect(committed).toEqual([]);
  return 'ignorado; só .env.example rastreado; nenhum .env em commit algum';
});

securityCase('.env.example sem credenciais', 'toda variável de credencial ou conexão vazia', async () => {
  const assignments = readFileSync('.env.example', 'utf8').split('\n').filter((line) => /^\s*[A-Z_]+=/.test(line));
  const filled = assignments.filter((line) => !/=\s*(#.*)?$/.test(line.trim()));
  expect(filled).toEqual([]);
  return `${assignments.length} variáveis declaradas, todas vazias`;
});

securityCase('Senha fixa no docker-compose.yml', 'comportamento atual: credencial de desenvolvimento versionada e porta publicada no host', async () => {
  const compose = readFileSync('docker-compose.yml', 'utf8');
  expect(compose).toContain('POSTGRES_PASSWORD: wager');
  expect(compose).toContain('"5432:5432"');
  return 'POSTGRES_PASSWORD de desenvolvimento e portas 5432 e 4566 publicadas em todas as interfaces';
}, 'limitação');

securityCase('Dependências com versão fixa e lockfile versionado', 'sem ^ ou ~; bun.lock rastreado', async () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string> | undefined>;
  const versions = Object.entries({ ...manifest['dependencies'], ...manifest['devDependencies'] });
  expect(versions.filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version))).toEqual([]);
  expect(git('ls-files', '--error-unmatch', 'bun.lock').code).toBe(0);
  return `${versions.length} dependências diretas com versão exata`;
});
