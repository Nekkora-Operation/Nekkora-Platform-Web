import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Checkbox, RadioGroup, Stack, Table, Text, type TableColumn, type Tone } from 'nekkora-lib';
import {
  EnvironmentLogExpired,
  authorizeManagedEnvironment,
  getManagedEnvironment,
  getRemoteAttemptEnvironmentLog,
  requestManagedEnvironmentResolution,
  revokeManagedEnvironmentAuthorization,
  type EnvironmentMode,
  type ManagedEnvironment,
  type ManagedFailure,
  type ManagedLockItem,
  type ManagedPrerequisite,
  type RemoteAttemptEnvironment,
} from '../../api/managedEnvironment';
import { listRemoteAttemptLogs, listRemoteAttemptResults, type RemoteAttempt, type RemoteCandidate } from '../../api/remoteExecutions';
import { isApiError } from '../../api/http';
import { useOptionalSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { usePolling } from '../../hooks/usePolling';
import { orgStepUp } from '../access/shared';
import { DateTimeText } from '../product/shared';

/**
 * AMBIENTE-PYTHON-001 — "Dependências gerenciadas por execução" (CONTRATO.md §0, §2, §5). O padrão continua sendo o Python
 * preparado: nada daqui aparece sem `me.managedEnvironmentAvailable`, e a solicitação nunca escolhe o ambiente por execução
 * sozinha. A tela não decide nada: mostra o que a máquina resolveu, pede o aceite explícito daquele lock e acompanha o preparo.
 */

/** A chave da Platform está ligada (e a execução remota disponível). Ausente (API anterior ao campo) = indisponível. */
export function useManagedEnvironmentAvailable(): boolean {
  return useOptionalSession()?.me.managedEnvironmentAvailable === true;
}

export const MANAGED = {
  COLUMN: 'Ambiente',
  PREPARED: 'Python preparado',
  ACCEPTED: 'Ambiente por execução · aceito',
  STALE: 'Ambiente por execução · dependências mudaram',
  INCOMPATIBLE: 'Máquina não compatível com ambiente por execução',
  OPEN: 'Ambiente por execução…',
  BACK: 'Voltar ao Python preparado',
  EXPLAIN:
    'A cada execução, a máquina cria um ambiente Python temporário a partir da instalação do Python escolhida, instala nele as dependências abaixo e o apaga no fim. Nada é instalado no Python da máquina.',
  ORIGIN: 'Só pacotes já compilados (wheels) do PyPI público (pypi.org). Outros índices, endereços, Git e caminhos locais não são usados.',
  NOT_COMPATIBLE:
    'O aplicativo desta máquina não oferece o ambiente por execução. Ela continua executando com o Python preparado, como hoje.',
  BASE_NOT_SELECTED: 'Escolha antes o Python desta automação nesta máquina (coluna "Python desta automação"). O ambiente temporário é criado a partir dele.',
  BASE_IS_VENV:
    'O Python escolhido para esta automação nesta máquina é um ambiente virtual. O ambiente por execução é criado a partir de uma instalação do Python: escolha uma instalação na coluna "Python desta automação".',
  NO_DEPENDENCIES: 'Esta versão não declara dependências além das do pacote.',
  GENERATE: 'Gerar a lista completa nesta máquina',
  GENERATE_HINT:
    'A máquina calcula a lista completa (com as dependências indiretas) para o Python e o sistema dela, sem instalar nada. Gerar a lista não autoriza nada.',
  PENDING: 'Pedido enviado: aguardando a máquina responder (o prazo é de até 30 minutos). Esta tela se atualiza sozinha.',
  UNANSWERED: 'A máquina não respondeu dentro do prazo; nada foi decidido. Você pode gerar a lista de novo.',
  ENVIRONMENT_GONE: 'A máquina não encontrou mais o Python escolhido. Escolha outro Python; nada foi decidido.',
  NOT_CURRENT: 'Esta lista é de antes da última mudança (do Python escolhido, das dependências ou da versão). Gere a lista de novo para poder aceitar.',
  RESOLUTION_FAILED: 'Não foi possível gerar a lista completa nesta máquina',
  PREREQUISITES: 'Componentes externos que a máquina precisa ter',
  PREREQUISITES_HINT:
    'Estes componentes não são pacotes Python: quem administra a máquina os instala manualmente. A Nekkora só confere, antes de iniciar, o que estiver marcado abaixo; ela nunca instala navegadores nem componentes do sistema.',
  BROWSERS_LEGEND: 'Navegadores do Playwright que a máquina deve ter',
  BROWSERS_REQUIRED: 'Escolha ao menos um navegador.',
  CONFIRM: 'Autorizar o ambiente por execução',
  ACK: (n: number, version: string, machine: string) =>
    `Autorizo instalar estes ${n} pacotes, a cada execução da ${version} na máquina ${machine}, num ambiente temporário.`,
  DONE: 'Ambiente por execução aceito. Ao solicitar, escolha "Ambiente por execução (aceito)": o Python preparado continua sendo o padrão.',
  REVOKED: 'Aceite revogado: esta máquina volta ao Python preparado nesta versão.',
  STALE_TITLE: 'As dependências mudaram desde o aceite',
  STALE_ACTION: 'O aceite anterior não vale mais. Gere a lista completa de novo e aceite outra vez para voltar a usar o ambiente por execução.',
  REVOKE_TEXT:
    'O aceite do ambiente por execução desta versão nesta máquina é revogado. As próximas execuções usam o Python preparado da máquina, como antes. Uma execução já entregue no ambiente por execução é recusada antes de iniciar.',
  READ_ONLY: 'Só quem gerencia esta automação pode gerar a lista e aceitar.',
} as const;

export const STALE_REASON: Record<string, string> = {
  REQUIREMENTS_CHANGED: 'as dependências declaradas mudaram',
  PYTHON_CHANGED: 'o Python escolhido nesta máquina mudou',
  LOCK_CHANGED: 'a lista completa gerada agora é diferente da aceita',
};

/** Fases de falha da resolução (§1), em palavras. */
export const RESOLUTION_PHASE: Record<string, (python: string) => string> = {
  NO_COMPATIBLE_WHEEL: (py) => `não há pacote compilado (wheel) compatível com Python ${py} nesta máquina`,
  RESOLUTION_CONFLICT: () => 'as dependências pedem versões incompatíveis entre si',
  NOT_FOUND: () => 'a versão pedida não existe no PyPI público',
  INDEX_UNREACHABLE: () => 'a máquina não conseguiu acessar o PyPI público (rede, proxy ou firewall)',
  PIP_UNAVAILABLE: () => 'o pip deste Python não está disponível ou é anterior à versão 22.2',
  TIMEOUT: () => 'a máquina não terminou de calcular a lista dentro do tempo limite',
  OTHER: () => 'a máquina informou outro erro (veja o resumo)',
};

/** Fases de falha do preparo (§1), em palavras. */
export const PREPARE_PHASE: Record<string, (python: string) => string> = {
  VENV: () => 'não foi possível criar o ambiente temporário a partir do Python escolhido',
  DOWNLOAD: () => 'o download do PyPI público falhou',
  HASH_MISMATCH: () => 'o arquivo baixado não confere com o hash aceito',
  NO_COMPATIBLE_WHEEL: (py) => `não há pacote compilado (wheel) compatível com Python ${py} nesta máquina`,
  INSTALL: () => 'a instalação no ambiente temporário falhou',
  VERIFY: () => 'as versões instaladas não conferem com a lista aceita',
  PREREQUISITE: () => 'falta na máquina um componente externo exigido (por exemplo, o navegador do Playwright); a Nekkora só confere e não instala',
  NO_SPACE: () => 'faltou espaço em disco na máquina',
  TIMEOUT: () => 'o preparo passou do tempo limite',
  OTHER: () => 'a máquina informou outro erro (veja o resumo)',
};

const phaseText = (table: Record<string, (py: string) => string>, phase: string, python: string | null | undefined) =>
  table[phase]?.(python || 'desta máquina') ?? `fase ${phase}`;

/** Por que a lista completa não saiu: qual dependência e em que fase. */
export function resolutionFailureText(failure: ManagedFailure | null | undefined, python: string | null | undefined): string {
  if (!failure) return `${MANAGED.RESOLUTION_FAILED}.`;
  const why = phaseText(RESOLUTION_PHASE, failure.phase, python);
  return failure.requirement ? `${MANAGED.RESOLUTION_FAILED}: a dependência ${failure.requirement} falhou — ${why}.` : `${MANAGED.RESOLUTION_FAILED}: ${why}.`;
}

/** A tentativa no ambiente por execução que não chegou a iniciar a automação, em palavras. */
export function preparationFailureText(env: RemoteAttemptEnvironment | null | undefined, refusalReason?: string | null): string | null {
  const report = env?.report;
  if (report?.outcome === 'INTERRUPTED' || refusalReason === 'ENVIRONMENT_SETUP_INTERRUPTED')
    return 'Não iniciada — o Client reiniciou durante o preparo; a automação não chegou a iniciar.';
  if (report?.outcome === 'FAILED' || (refusalReason && MANAGED_REFUSALS.includes(refusalReason))) {
    const f = report?.failure;
    const why = f ? phaseText(PREPARE_PHASE, f.phase, report?.pythonVersion) : null;
    if (f?.requirement) return `Não iniciada — a dependência ${f.requirement} não pôde ser instalada: ${why}. A automação não foi executada.`;
    if (why) return `Não iniciada — o ambiente temporário não pôde ser preparado: ${why}. A automação não foi executada.`;
    return 'Não iniciada — o ambiente temporário não pôde ser preparado. A automação não foi executada.';
  }
  return null;
}

/** Motivos de recusa da máquina que vêm do preparo do ambiente por execução (§1). */
export const MANAGED_REFUSAL: Record<string, string> = {
  ENVIRONMENT_SETUP_FAILED: 'não foi possível preparar o ambiente temporário; a automação não foi executada',
  DEPENDENCY_INSTALL_FAILED: 'uma dependência não pôde ser instalada no ambiente temporário; a automação não foi executada',
  ENVIRONMENT_SETUP_INTERRUPTED: 'o Client reiniciou durante o preparo; a automação não chegou a iniciar',
  EXTERNAL_PREREQUISITE_MISSING:
    'falta na máquina um componente externo exigido (por exemplo, o navegador do Playwright); a Nekkora só confere e não instala, e a automação não foi executada',
};
const MANAGED_REFUSALS = Object.keys(MANAGED_REFUSAL);

/** Recusas (409/404) das rotas do ambiente por execução e da solicitação no modo MANAGED. */
export const MANAGED_REQUEST_REFUSAL: Record<string, string> = {
  managed_environment_unavailable: 'O ambiente por execução não está disponível nesta Platform.',
  managed_environment_machine_incompatible: MANAGED.NOT_COMPATIBLE,
  managed_environment_base_not_installation: MANAGED.BASE_IS_VENV,
  managed_environment_resolution_pending: 'Já há um pedido de lista completa em aberto para esta máquina. Aguarde a resposta dela.',
  managed_environment_resolution_not_current:
    'A lista gerada deixou de valer: o Python escolhido, as dependências ou a versão mudaram. Gere a lista de novo e confira antes de aceitar.',
  managed_environment_lock_changed: 'A lista completa mudou depois que você a viu. Confira a lista nova e aceite de novo.',
  managed_environment_not_authorized: 'Não há aceite vigente do ambiente por execução desta versão nesta máquina. Solicite com o Python preparado, ou aceite o ambiente antes.',
  managed_environment_changed:
    'O aceite do ambiente por execução não corresponde mais ao que está declarado (dependências, Python escolhido ou lista completa mudaram). Gere a lista e aceite de novo.',
  managed_environment_log_expired: 'O registro do preparo foi removido após 30 dias.',
};

/** Catálogo de dependências externas (§5): o que a pessoa precisa preparar à mão na máquina. */
export const PREREQUISITE: Record<string, { name: string; manual: string }> = {
  PLAYWRIGHT_BROWSER: {
    name: 'Navegadores do Playwright',
    manual: 'Instale na máquina os navegadores com a mesma versão do Playwright desta lista. A Nekkora só confere se o navegador marcado existe.',
  },
  SELENIUM_DRIVER: { name: 'Navegador e driver do Selenium', manual: 'O navegador e o driver ficam na máquina; o selenium-manager pode baixá-los na hora da execução.' },
  ODBC_DRIVER: { name: 'Driver ODBC', manual: 'O driver ODBC do banco de dados precisa estar instalado na máquina.' },
  ORACLE_CLIENT: { name: 'Oracle Instant Client', manual: 'O Oracle Instant Client precisa estar instalado, se a automação usar o modo thick.' },
  TESSERACT: { name: 'Tesseract OCR', manual: 'O Tesseract OCR precisa estar instalado e no PATH da máquina.' },
  POPPLER: { name: 'Poppler', manual: 'O Poppler precisa estar instalado na máquina.' },
  WKHTMLTOPDF: { name: 'wkhtmltopdf', manual: 'O wkhtmltopdf precisa estar instalado na máquina.' },
  JAVA_RUNTIME: { name: 'Java', manual: 'O Java precisa estar instalado na máquina.' },
};

export const PLAYWRIGHT_CHECK: Record<string, string> = {
  PLAYWRIGHT_CHROMIUM: 'Chromium',
  PLAYWRIGHT_FIREFOX: 'Firefox',
  PLAYWRIGHT_WEBKIT: 'WebKit',
};

/** A indicação "Ambiente" de uma máquina na lista da versão. */
export function managedIndication(c: RemoteCandidate): { label: string; tone: Tone } | null {
  const m = c.managedEnvironment;
  if (!m) return null;
  if (!m.compatible) return { label: MANAGED.INCOMPATIBLE, tone: 'neutral' };
  if (m.authorized === 'CURRENT') return { label: MANAGED.ACCEPTED, tone: 'success' };
  if (m.authorized === 'STALE') return { label: MANAGED.STALE, tone: 'warning' };
  return { label: MANAGED.PREPARED, tone: 'neutral' };
}

/** Nome normalizado (PEP 503) e o nome de uma linha `nome[extras]==versão`. */
export const normalizeName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
const declaredName = (dep: string) => normalizeName(dep.split(/[[=<>!~; ]/, 1)[0] ?? dep);

const shortHash = (sha: string) => sha.slice(0, 12);

// ===================================================================== diálogo: ambiente por execução de uma máquina

type LoadState = { status: 'loading' } | { status: 'ready'; env: ManagedEnvironment } | { status: 'error'; error: unknown };

export function ManagedEnvironmentDialog({
  org,
  automationId,
  versionId,
  versionLabel,
  candidate,
  canManage,
  onClose,
  onDone,
  onUnauthenticated,
  refusalText,
}: {
  org: string;
  automationId: string;
  versionId: string;
  versionLabel: string;
  candidate: RemoteCandidate;
  canManage: boolean;
  onClose: () => void;
  onDone: (text: string) => void;
  onUnauthenticated: () => void;
  refusalText: (e: unknown) => string;
}) {
  const [notice, setNotice] = useState<{ tone: 'warning' | 'success'; text: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [browsers, setBrowsers] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const poll = usePolling<ManagedEnvironment>(() => getManagedEnvironment(org, automationId, candidate.agentId, versionId), {
    intervalMs: 3_000,
    keepGoing: (e) => e.resolution?.state === 'PENDING',
    deps: [org, automationId, candidate.agentId, versionId],
    onUnauthenticated,
  });
  const load: LoadState = poll.data ? { status: 'ready', env: poll.data } : poll.error ? { status: 'error', error: poll.error } : { status: 'loading' };
  const env = load.status === 'ready' ? load.env : null;
  const r = env?.resolution ?? null;
  const lock = r?.state === 'ANSWERED' && r.outcome === 'RESOLVED' ? (r.lock ?? []) : null;
  const lockKey = r?.lockSha256 ?? '';
  // o consentimento é de UMA lista: lista nova, consentimento novo
  useEffect(() => {
    setAck(false);
  }, [lockKey]);
  const playwright = env?.externalPrerequisites.find((p) => p.code === 'PLAYWRIGHT_BROWSER') ?? null;
  const browsersOk = !playwright || browsers.length > 0;
  const acceptable = !!env && env.machineCompatible && env.baseEligible && !!lock && !!r?.current && !!r.lockSha256;
  const ready = canManage && acceptable && browsersOk && ack;

  const generate = async () => {
    setGenerating(true);
    setNotice(null);
    try {
      await requestManagedEnvironmentResolution(org, automationId, candidate.agentId, versionId);
      poll.refresh();
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) onUnauthenticated();
      else setNotice({ tone: 'warning', text: refusalText(e) });
    } finally {
      setGenerating(false);
    }
  };

  const declared = new Set((env?.requirements?.dependencies ?? []).map(declaredName));
  const lockColumns: TableColumn<ManagedLockItem>[] = [
    { key: 'pacote', header: 'Pacote', render: (i) => i.name },
    { key: 'versao', header: 'Versão', render: (i) => i.version },
    { key: 'hash', header: 'Hash (SHA-256)', render: (i) => <code title={i.sha256}>{shortHash(i.sha256)}</code> },
    { key: 'arquivo', header: 'Arquivo', render: (i) => <span className="pw-managed__file">{i.fileName}</span> },
    { key: 'origem', header: 'Origem', render: (i) => (declared.has(normalizeName(i.name)) ? 'Declarada' : 'Indireta') },
  ];

  return (
    <StepUpDialog<void>
      open
      size="lg"
      ready={ready}
      title={`Ambiente por execução em ${candidate.agentName}`}
      guard={{ operation: 'managed-environment.authorize', target: `${versionId}|${candidate.agentId}|${lockKey}` }}
      confirmLabel={MANAGED.CONFIRM}
      stepUp={orgStepUp(org)}
      action={() =>
        r && r.lockSha256
          ? authorizeManagedEnvironment(org, automationId, candidate.agentId, {
              versionId,
              resolutionId: r.resolutionId,
              lockSha256: r.lockSha256,
              checks: playwright ? playwright.checks.filter((c) => browsers.includes(c)) : [],
            })
          : Promise.reject()
      }
      onDone={() => onDone(MANAGED.DONE)}
      onClose={onClose}
      refusalText={refusalText}
      uncertainText="Não foi possível confirmar o aceite. Feche, atualize a lista de máquinas e confira o ambiente antes de repetir."
      onUnauthenticated={onUnauthenticated}
    >
      <Stack gap={3}>
        <Text>{MANAGED.EXPLAIN}</Text>
        <Text variant="body-sm" color="secondary">
          {MANAGED.ORIGIN}
        </Text>
        {load.status === 'loading' && <Text variant="body-sm">Carregando o ambiente desta máquina…</Text>}
        {load.status === 'error' && (
          <Alert tone="warning">
            {isApiError(load.error, 'not_found') ? MANAGED_REQUEST_REFUSAL.managed_environment_unavailable : 'Não foi possível ler o ambiente desta máquina agora. Feche e tente de novo.'}
          </Alert>
        )}
        {env && !env.machineCompatible && <Alert tone="info">{MANAGED.NOT_COMPATIBLE}</Alert>}
        {env && env.machineCompatible && (
          <>
            <Text>
              <strong>Python base: </strong>
              {env.basePython
                ? `Python ${env.basePython.pythonVersion} · ${env.basePython.kind === 'INSTALLATION' ? 'instalação' : 'ambiente virtual'} · código ${env.basePython.environmentId.slice(0, 6)}`
                : 'não escolhido'}
            </Text>
            {!env.basePython && <Alert tone="warning">{MANAGED.BASE_NOT_SELECTED}</Alert>}
            {env.basePython && !env.baseEligible && <Alert tone="warning">{MANAGED.BASE_IS_VENV}</Alert>}
            <div>
              <Text>
                <strong>
                  Dependências da {versionLabel}
                  {env.requirements?.revision != null ? ` (revisão ${env.requirements.revision})` : ''}:
                </strong>
              </Text>
              {env.requirements && env.requirements.dependencies.length > 0 ? (
                <ul aria-label="Dependências declaradas">
                  {env.requirements.dependencies.map((d) => (
                    <li key={d}>
                      <code>{d}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <Text variant="body-sm" color="secondary">
                  {MANAGED.NO_DEPENDENCIES}
                </Text>
              )}
            </div>

            {env.authorization?.status === 'CURRENT' && (
              <Alert tone="success" title="Aceito">
                {`Esta máquina tem um aceite vigente desta versão: ${env.authorization.packages ?? '?'} pacotes`}
                {env.authorization.grantedAt ? (
                  <>
                    , aceito em <DateTimeText iso={env.authorization.grantedAt} />
                  </>
                ) : null}
                . Ao solicitar, o Python preparado continua sendo o padrão.
              </Alert>
            )}
            {env.authorization?.status === 'STALE' && <StaleAuthorization authorization={env.authorization} />}

            <Stack gap={2}>
              <Text variant="body-sm" color="secondary">
                {MANAGED.GENERATE_HINT}
              </Text>
              {canManage ? (
                <span>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={generating}
                    disabled={generating || r?.state === 'PENDING' || !env.basePython || !env.baseEligible}
                    onClick={() => void generate()}
                  >
                    {MANAGED.GENERATE}
                  </Button>
                </span>
              ) : (
                <Text variant="body-sm" color="secondary">
                  {MANAGED.READ_ONLY}
                </Text>
              )}
              {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
              <div role="status" aria-live="polite">
                {r?.state === 'PENDING' && <Text variant="body-sm">{MANAGED.PENDING}</Text>}
                {r?.state === 'UNANSWERED' && <Alert tone="warning">{MANAGED.UNANSWERED}</Alert>}
              </div>
              {r?.state === 'ANSWERED' && r.outcome === 'ENVIRONMENT_GONE' && <Alert tone="warning">{MANAGED.ENVIRONMENT_GONE}</Alert>}
              {r?.state === 'ANSWERED' && (r.outcome === 'INCOMPATIBLE' || r.outcome === 'NOT_RESOLVED') && (
                <Alert tone="danger" title={r.outcome === 'INCOMPATIBLE' ? 'Incompatível com esta máquina' : 'Lista não gerada'}>
                  {resolutionFailureText(r.failure, r.pythonVersion ?? env.basePython?.pythonVersion)}
                  {r.failure?.summary ? ` Resumo da máquina: ${r.failure.summary}` : ''} Nada foi autorizado.
                </Alert>
              )}
              {r && r.state !== 'PENDING' && !r.current && <Alert tone="warning">{MANAGED.NOT_CURRENT}</Alert>}
            </Stack>

            {lock && (
              <Stack gap={2}>
                <Text>
                  <strong>{`Lista completa: ${lock.length} ${lock.length === 1 ? 'pacote' : 'pacotes'}`}</strong>
                  {r?.pythonVersion ? ` · Python ${r.pythonVersion}` : ''}
                  {r?.pipVersion ? ` · pip ${r.pipVersion}` : ''}
                  {r?.answeredAt ? (
                    <>
                      {' '}
                      · gerada em <DateTimeText iso={r.answeredAt} />
                    </>
                  ) : null}
                </Text>
                <div className="pw-prod__scroll" role="region" aria-label="Lista completa dos pacotes" tabIndex={0}>
                  <Table
                    columns={lockColumns}
                    data={lock}
                    rowKey="name"
                    size="sm"
                    caption={`Lista completa gerada pela máquina: ${lock.length} pacotes, com as dependências declaradas e as indiretas.`}
                  />
                </div>
              </Stack>
            )}

            {env.externalPrerequisites.length > 0 && (
              <Prerequisites items={env.externalPrerequisites} browsers={browsers} onBrowsers={setBrowsers} disabled={!canManage} />
            )}

            {canManage && acceptable && lock && (
              <Checkbox label={MANAGED.ACK(lock.length, versionLabel, candidate.workerName)} checked={ack} onChange={(e) => setAck(e.target.checked)} />
            )}
          </>
        )}
      </Stack>
    </StepUpDialog>
  );
}

function StaleAuthorization({ authorization }: { authorization: NonNullable<ManagedEnvironment['authorization']> }) {
  const reasons = (authorization.staleReasons ?? []).map((s) => STALE_REASON[s] ?? s);
  const diff = authorization.diff;
  return (
    <Alert tone="warning" title={MANAGED.STALE_TITLE}>
      <Stack gap={2}>
        {reasons.length > 0 && <span>{`Motivo: ${reasons.join('; ')}.`}</span>}
        {diff && (
          <ul aria-label="O que mudou na lista">
            {(diff.added ?? []).map((d) => (
              <li key={`+${d}`}>{`Acrescentado: ${d}`}</li>
            ))}
            {(diff.removed ?? []).map((d) => (
              <li key={`-${d}`}>{`Removido: ${d}`}</li>
            ))}
            {(diff.changed ?? []).map((d) => (
              <li key={`~${d.name}`}>{`Versão trocada: ${d.name} ${d.from} → ${d.to}`}</li>
            ))}
          </ul>
        )}
        <span>{MANAGED.STALE_ACTION}</span>
      </Stack>
    </Alert>
  );
}

function Prerequisites({
  items,
  browsers,
  onBrowsers,
  disabled,
}: {
  items: ManagedPrerequisite[];
  browsers: string[];
  onBrowsers: (b: string[]) => void;
  disabled: boolean;
}) {
  return (
    <Stack gap={2}>
      <Text>
        <strong>{MANAGED.PREREQUISITES}</strong>
      </Text>
      <Text variant="body-sm" color="secondary">
        {MANAGED.PREREQUISITES_HINT}
      </Text>
      <ul aria-label={MANAGED.PREREQUISITES}>
        {items.map((p) => (
          <li key={`${p.code}|${p.package}`}>
            <Text variant="body-sm">
              <strong>{PREREQUISITE[p.code]?.name ?? p.code}</strong> (pacote {p.package}): {PREREQUISITE[p.code]?.manual ?? 'Prepare este componente na máquina.'}
            </Text>
            {p.code === 'PLAYWRIGHT_BROWSER' && p.checks.length > 0 && (
              <fieldset className="pw-managed__browsers">
                <legend>{MANAGED.BROWSERS_LEGEND}</legend>
                {p.checks.map((c) => (
                  <Checkbox
                    key={c}
                    label={PLAYWRIGHT_CHECK[c] ?? c}
                    checked={browsers.includes(c)}
                    disabled={disabled}
                    onChange={(e) => onBrowsers(e.target.checked ? [...browsers, c] : browsers.filter((b) => b !== c))}
                  />
                ))}
                {browsers.length === 0 && (
                  <Text variant="body-sm" color="secondary">
                    {MANAGED.BROWSERS_REQUIRED}
                  </Text>
                )}
              </fieldset>
            )}
          </li>
        ))}
      </ul>
    </Stack>
  );
}

/** Voltar ao Python preparado (revoga o aceite, step-up). */
export function RevokeManagedDialog({
  org,
  automationId,
  versionId,
  candidate,
  onClose,
  onDone,
  onUnauthenticated,
  refusalText,
}: {
  org: string;
  automationId: string;
  versionId: string;
  candidate: RemoteCandidate | null;
  onClose: () => void;
  onDone: (text: string) => void;
  onUnauthenticated: () => void;
  refusalText: (e: unknown) => string;
}) {
  return (
    <StepUpDialog<void>
      open={!!candidate}
      tone="danger"
      title={candidate ? `${MANAGED.BACK} em ${candidate.agentName}?` : ''}
      guard={{ operation: 'managed-environment.revoke', target: candidate ? `${versionId}|${candidate.agentId}` : undefined }}
      confirmLabel={MANAGED.BACK}
      stepUp={orgStepUp(org)}
      action={() => (candidate ? revokeManagedEnvironmentAuthorization(org, automationId, candidate.agentId, versionId) : Promise.reject())}
      onDone={() => onDone(MANAGED.REVOKED)}
      onClose={onClose}
      refusalText={refusalText}
      uncertainText="Não foi possível confirmar a revogação. Atualize a lista de máquinas e confira antes de repetir."
      onUnauthenticated={onUnauthenticated}
    >
      <Text>{MANAGED.REVOKE_TEXT}</Text>
    </StepUpDialog>
  );
}

/** Escolha do ambiente na solicitação: só com aceite vigente; o Python preparado vem SEMPRE marcado. */
export function EnvironmentModeChoice({ value, onChange }: { value: EnvironmentMode; onChange: (m: EnvironmentMode) => void }) {
  return (
    <RadioGroup
      legend="Ambiente desta execução"
      value={value}
      onChange={(v) => onChange(v === 'MANAGED' ? 'MANAGED' : 'PREPARED')}
      options={[
        { value: 'PREPARED', label: 'Python preparado', description: 'O Python escolhido nesta máquina, com as dependências que já estão nele (o padrão).' },
        {
          value: 'MANAGED',
          label: 'Ambiente por execução (aceito)',
          description: 'Um ambiente temporário com os pacotes aceitos, criado para esta execução e apagado no fim.',
        },
      ]}
    />
  );
}

// ===================================================================== tentativa: etapas, relatório e registro do preparo

export type StepStatus = 'done' | 'current' | 'failed' | 'stopped' | 'pending' | 'skipped';
export interface ManagedStep {
  key: 'env' | 'deps' | 'run' | 'deliver';
  title: string;
  status: StepStatus;
  at: string | null;
  durationMs: number | null;
}
/** A entrega de registros e resultados: confirmada pelos fechamentos, em andamento, ou não sabida nesta tela. */
export type Delivery = 'done' | 'pending' | 'unknown';

const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'REFUSED', 'EXPIRED', 'ENDED_UNKNOWN'];

/**
 * As quatro etapas de uma tentativa no ambiente por execução, derivadas SÓ do que a máquina informou:
 *
 * 1. Preparando ambiente: alcançada com a etapa ENV_CREATING; concluída quando a máquina chega a DEPS_INSTALLING, manda o
 *    relatório READY ou inicia a automação (startedAt). Duração = report.createMs.
 * 2. Instalando dependências: alcançada com DEPS_INSTALLING; concluída com o relatório READY ou com o início. Duração =
 *    report.installMs.
 *    Falha do preparo (relatório FAILED/INTERRUPTED ou recusa com motivo do preparo): marca a etapa 1 (fase VENV, ou se a 2
 *    não foi alcançada) ou a 2; as seguintes ficam "não executada".
 * 3. Executando: alcançada com startedAt; concluída quando a tentativa termina (endedAt), qualquer que seja o desfecho (o
 *    desfecho aparece no estado da tentativa).
 * 4. Enviando resultados: alcançada no término de uma tentativa que iniciou (endedAt); concluída só quando os fechamentos do
 *    envio de registros E de resultados chegaram (`delivery = 'done'`); sem essa informação fica "em andamento".
 *
 * Tentativa terminada sem alcançar uma etapa: "não executada"; alcançada e não concluída, sem falha do preparo: "interrompida".
 */
export function deriveManagedSteps(a: Pick<RemoteAttempt, 'state' | 'startedAt' | 'endedAt' | 'refusalReason' | 'environment'>, delivery: Delivery = 'unknown'): ManagedStep[] {
  const env = a.environment ?? null;
  const at = (s: 'ENV_CREATING' | 'DEPS_INSTALLING') => env?.stages.find((x) => x.stage === s)?.at ?? null;
  const creating = at('ENV_CREATING');
  const installing = at('DEPS_INSTALLING');
  const report = env?.report ?? null;
  const ready = report?.outcome === 'READY';
  const started = !!a.startedAt;
  const terminal = TERMINAL.includes(a.state);
  const prepFailed = !started && (report?.outcome === 'FAILED' || report?.outcome === 'INTERRUPTED' || (!!a.refusalReason && MANAGED_REFUSALS.includes(a.refusalReason)));
  const failedAt = prepFailed ? (report?.failure?.phase === 'VENV' || !installing ? 'env' : 'deps') : null;

  const status = (key: ManagedStep['key'], reached: boolean, done: boolean): StepStatus => {
    if (failedAt === key) return 'failed';
    if (done) return 'done';
    if (reached) return terminal ? 'stopped' : 'current';
    return terminal ? 'skipped' : 'pending';
  };
  const envDone = !!installing || ready || started;
  const depsDone = ready || started;
  return [
    { key: 'env', title: 'Preparando ambiente', status: status('env', !!creating, envDone), at: creating, durationMs: report?.createMs ?? null },
    { key: 'deps', title: 'Instalando dependências', status: status('deps', !!installing, depsDone), at: installing, durationMs: report?.installMs ?? null },
    { key: 'run', title: 'Executando', status: status('run', started, started && terminal), at: a.startedAt, durationMs: null },
    {
      key: 'deliver',
      title: 'Enviando resultados',
      status: started && terminal ? (delivery === 'done' ? 'done' : 'current') : terminal ? 'skipped' : 'pending',
      at: started && terminal ? a.endedAt : null,
      durationMs: null,
    },
  ];
}

const STEP_LABEL: Record<StepStatus, { label: string; tone: Tone }> = {
  done: { label: 'Concluída', tone: 'success' },
  current: { label: 'Em andamento', tone: 'info' },
  failed: { label: 'Falhou', tone: 'danger' },
  stopped: { label: 'Interrompida', tone: 'warning' },
  pending: { label: 'Aguardando', tone: 'neutral' },
  skipped: { label: 'Não executada', tone: 'neutral' },
};

export const durationMsText = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

export function ManagedSteps({ attempt, delivery = 'unknown' }: { attempt: RemoteAttempt; delivery?: Delivery }) {
  const steps = deriveManagedSteps(attempt, delivery);
  return (
    <ol className="pw-managed__steps" aria-label={`Etapas da tentativa ${attempt.attemptNumber} no ambiente por execução`}>
      {steps.map((s) => (
        <li key={s.key} className="pw-managed__step">
          <Badge tone={STEP_LABEL[s.status].tone} size="sm">
            {STEP_LABEL[s.status].label}
          </Badge>
          <Text as="span" variant="body-sm">
            <strong>{s.title}</strong>
            {s.at ? (
              <>
                {' · desde '}
                <DateTimeText iso={s.at} />
              </>
            ) : null}
            {s.durationMs != null && s.status === 'done' ? ` · ${durationMsText(s.durationMs)}` : ''}
            {s.key === 'deliver' && s.status === 'current' && delivery === 'unknown' ? ' · a confirmação do envio aparece em Registros e Resultados' : ''}
          </Text>
        </li>
      ))}
    </ol>
  );
}

/** O relatório do preparo e o registro dele (o texto só quando a pessoa pede). */
export function AttemptEnvironment({
  org,
  executionId,
  attempt,
  delivery,
  detailed = false,
}: {
  org: string;
  executionId: string;
  attempt: RemoteAttempt;
  delivery?: Delivery;
  /** Na página da execução: a lista instalada e as durações; na página da versão, só o essencial. */
  detailed?: boolean;
}) {
  const env = attempt.environment;
  const [log, setLog] = useState<{ status: 'idle' | 'loading' | 'expired' | 'error' } | { status: 'ready'; text: string }>({ status: 'idle' });
  if (!env) return null;
  const report = env.report;
  const failure = preparationFailureText(env, attempt.state === 'REFUSED' ? attempt.refusalReason : null);
  const expired = !!report?.logExpiredAt || report?.logAvailable === false;
  const openLog = async () => {
    setLog({ status: 'loading' });
    try {
      setLog({ status: 'ready', text: await getRemoteAttemptEnvironmentLog(org, executionId, attempt.attemptId) });
    } catch (e) {
      setLog({ status: e instanceof EnvironmentLogExpired ? 'expired' : 'error' });
    }
  };
  return (
    <Stack gap={2}>
      <Text variant="body-sm" color="secondary">
        {`Ambiente por execução · ${env.packages} ${env.packages === 1 ? 'pacote aceito' : 'pacotes aceitos'}`}
        {env.checks.length ? ` · confere: ${env.checks.map((c) => PLAYWRIGHT_CHECK[c] ?? c).join(', ')}` : ''}
      </Text>
      <ManagedSteps attempt={attempt} delivery={delivery} />
      {failure && <Alert tone="warning">{failure}</Alert>}
      {failure && report?.failure?.summary && (
        <Text variant="body-sm" color="secondary">
          Resumo da máquina: {report.failure.summary}
        </Text>
      )}
      {detailed && report && report.outcome === 'READY' && (
        <Text variant="body-sm" color="secondary">
          {`Preparado com Python ${report.pythonVersion ?? '?'}${report.pipVersion ? ` e pip ${report.pipVersion}` : ''}`}
          {report.createMs != null ? ` · ambiente criado em ${durationMsText(report.createMs)}` : ''}
          {report.installMs != null ? ` · dependências instaladas em ${durationMsText(report.installMs)}` : ''}.
        </Text>
      )}
      {detailed && report && (report.installed ?? []).length > 0 && (
        <details>
          <summary>{`Pacotes instalados (${report.installed!.length})`}</summary>
          <ul aria-label="Pacotes instalados">
            {report.installed!.map((p) => (
              <li key={p.name}>
                <code>{`${p.name}==${p.version}`}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {report && (
        <div>
          {expired || log.status === 'expired' ? (
            <Text variant="body-sm" color="secondary">
              Registro do preparo: removido após 30 dias{report.logExpiredAt ? ' (em ' : ''}
              {report.logExpiredAt && <DateTimeText iso={report.logExpiredAt} />}
              {report.logExpiredAt ? ')' : ''}. O resumo da falha, se houve, continua acima.
            </Text>
          ) : log.status === 'ready' ? (
            <div className="pw-log" role="region" aria-label={`Registro do preparo da tentativa ${attempt.attemptNumber}`} tabIndex={0}>
              <pre className="pw-log-line">{log.text}</pre>
            </div>
          ) : (
            <Button size="sm" variant="ghost" loading={log.status === 'loading'} onClick={() => void openLog()}>
              Registro do preparo
            </Button>
          )}
          {log.status === 'error' && (
            <Text variant="body-sm" color="secondary">
              Não foi possível ler o registro do preparo agora.
            </Text>
          )}
        </div>
      )}
    </Stack>
  );
}

/**
 * Se o envio de registros e de resultados de uma tentativa terminada já foi fechado pela máquina (página da execução, só para
 * quem pode ver registros). Consulta a cada 5 s até os dois fechamentos chegarem; sem permissão ou sem início: 'unknown'.
 */
export function useDelivery(org: string, executionId: string, attempt: RemoteAttempt, enabled: boolean): Delivery {
  const active = enabled && !!attempt.environment && !!attempt.startedAt && TERMINAL.includes(attempt.state);
  const [delivery, setDelivery] = useState<Delivery>('unknown');
  useEffect(() => {
    if (!active) {
      setDelivery('unknown');
      return;
    }
    let alive = true;
    let timer: number | undefined;
    const check = async (n: number) => {
      try {
        const [logs, results] = await Promise.all([
          listRemoteAttemptLogs(org, executionId, attempt.attemptId, 0, 1),
          listRemoteAttemptResults(org, executionId, attempt.attemptId),
        ]);
        if (!alive) return;
        const done = !!logs.closure && !!results.closure;
        setDelivery(done ? 'done' : 'pending');
        if (!done && n < 120) timer = window.setTimeout(() => void check(n + 1), 5_000);
      } catch {
        if (alive) setDelivery('unknown');
      }
    };
    void check(0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [active, org, executionId, attempt.attemptId]);
  return delivery;
}

/** Página da execução: o relatório completo, com a entrega conferida pelos fechamentos (só para quem pode ver registros). */
export function AttemptEnvironmentDetail({ org, executionId, attempt, canReadLogs }: { org: string; executionId: string; attempt: RemoteAttempt; canReadLogs: boolean }) {
  const delivery = useDelivery(org, executionId, attempt, canReadLogs);
  return <AttemptEnvironment org={org} executionId={executionId} attempt={attempt} delivery={delivery} detailed />;
}

export const ENVIRONMENT_MODE_TEXT: Record<EnvironmentMode, string> = {
  PREPARED: 'Python preparado da máquina',
  MANAGED: 'Ambiente por execução (temporário, com a lista aceita)',
};
