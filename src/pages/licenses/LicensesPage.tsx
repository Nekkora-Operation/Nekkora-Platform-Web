import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Card, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { listActivations, type AutomationActivationList } from '../../api/activations';
import { getCapacity, getLicenseSummary, listAllLicenses, type LicenseSummary, type OrganizationCapacity, type OrganizationLicense } from '../../api/licenses';
import { useSession } from '../../area/session';
import { ForbiddenState } from '../admin/shared';
import { DateTimeText, LoadErrorState, PageHeader } from '../product/shared';
import { ActivationSection } from './ActivationSection';
import './licenses.css';

type Loaded = { summary: LicenseSummary; licenses: OrganizationLicense[]; capacity: OrganizationCapacity };
type State = { status: 'loading' } | { status: 'ready'; data: Loaded } | { status: 'error'; error: unknown };

export const LICENSE_STATUS: Record<OrganizationLicense['status'], { label: string; tone: 'success' | 'neutral' | 'warning' | 'info' }> = {
  active: { label: 'Vigente', tone: 'success' },
  scheduled: { label: 'Ainda não começou', tone: 'info' },
  expired: { label: 'Vencida', tone: 'warning' },
  ended: { label: 'Encerrada', tone: 'neutral' },
};

export const MODEL_TEXT = {
  legacy: {
    title: 'Esta organização ainda não exige licença.',
    body: 'Executar e monitorar seguem as regras anteriores. Ativar uma automação já usa uma licença disponível, se houver; a exigência é ligada pelo suporte da Nekkora, que antes mostra quais automações ficariam sem licença.',
  },
  licensed: {
    title: 'Esta organização exige licença.',
    body: 'Cada automação precisa de uma licença vigente vinculada a ela para ser executada e monitorada pela Platform. Uma automação parada continua usando a licença dela.',
  },
} as const;

export const CAPACITY_TEXT = {
  intro:
    'Limites técnicos de capacidade, iguais para todas as organizações. Não são contratados e não têm relação com a quantidade de licenças: atingir um limite daqui não consome nem libera licença.',
  legacy: 'Nesta organização a capacidade ainda é a definida na ativação pela Nekkora. Os limites abaixo passam a valer quando a organização exigir licença.',
  concurrentFull: 'No limite, nada é recusado: a execução seguinte fica pendente até uma vaga ser liberada.',
  pendingFull: 'Com a fila cheia, uma solicitação nova é recusada até uma execução pendente começar ou terminar.',
  workersFull: 'No limite, um Worker novo não é cadastrado até outro ser arquivado.',
  previousAgentUnconfirmed:
    'O Agent anterior informou que não sabe como essas execuções terminaram. Isso não comprova que deixaram de ocupar a máquina, então a vaga continua reservada. Ela volta quando o suporte da Nekkora registrar a reconciliação, depois de verificar que o processo terminou ou que a máquina está fora de operação. O tempo, sozinho, não libera a vaga.',
} as const;

function Usage({ label, used, limit, note, children }: { label: string; used: number; limit: number | null; note?: string; children?: React.ReactNode }) {
  const full = limit !== null && used >= limit;
  return (
    <div className="pw-lic__usage">
      <Text variant="body-sm" color="secondary">
        {label}
      </Text>
      <Text as="p" variant="h4">
        {used}
        {limit !== null && <span className="pw-lic__limit"> de {limit}</span>}
      </Text>
      {children}
      {full && note && (
        <Text variant="body-sm" color="secondary">
          {note}
        </Text>
      )}
    </div>
  );
}

type Breakdown = OrganizationCapacity['concurrentExecutions']['breakdown'];

/** Execuções ATIVAS (a máquina ou a Platform informa que estão em andamento), em palavras. Só as parcelas que existem. */
export function activeText(b: Breakdown): string {
  return [
    b.remote ? `${b.remote} pelo Agent Client` : '',
    b.previousAgent ? `${b.previousAgent} pelo Agent anterior` : '',
    b.platform ? `${b.platform} pela Platform` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * RESERVAS POR SITUAÇÃO INCERTA: não há prova de que a execução terminou, então a vaga continua reservada. Não são execuções
 * confirmadas em andamento, e a tela as mostra à parte.
 */
export function reservedText(b: Breakdown): string {
  return [
    b.unconfirmed ? `${b.unconfirmed} com término não confirmado pela máquina (Agent Client)` : '',
    b.previousAgentUnconfirmed ? `${b.previousAgentUnconfirmed} com resultado desconhecido (Agent anterior)` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * /o/{org}/administracao/licencas — "Licenças e automações" (PLATFORM-FLUXO-002): a conta das licenças, as automações
 * atendidas com a ativação unificada ("Ativar automação" e "Gerenciar ativação") e, SEPARADA, a capacidade técnica. Só para
 * quem administra a organização (org.manage). Conceder, renovar, encerrar e transferir licenças são atos do suporte da
 * Nekkora. A API decide tudo.
 */
export function LicensesPage() {
  const { org, expired } = useSession();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [activations, setActivations] = useState<AutomationActivationList | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setState({ status: 'loading' });
    try {
      const [summary, licenses, capacity] = await Promise.all([getLicenseSummary(org), listAllLicenses(org), getCapacity(org)]);
      if (gen === generation.current) setState({ status: 'ready', data: { summary, licenses, capacity } });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setState({ status: 'error', error: e });
    }
  }, [org, expired]);

  const loadActivations = useCallback(async () => {
    try {
      setActivations(await listActivations(org));
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      setActivations({ model: 'legacy', licenses: { contracted: 0, used: 0, available: 0 }, items: [], asOf: new Date().toISOString() });
    }
  }, [org, expired]);

  const reloadAll = useCallback(() => {
    void load();
    void loadActivations();
  }, [load, loadActivations]);

  useEffect(() => {
    reloadAll();
    return () => {
      generation.current++;
    };
  }, [reloadAll]);

  if (state.status === 'loading') return <StateView status="loading" title="Carregando licenças e automações…" />;
  if (state.status === 'error')
    return isApiError(state.error, 'forbidden') ? (
      <ForbiddenState area="as licenças e as automações atendidas" onRetry={reloadAll} />
    ) : (
      <LoadErrorState error={state.error} onRetry={reloadAll} />
    );

  const { summary, licenses, capacity } = state.data;
  const model = MODEL_TEXT[summary.model];
  // as automações que estão usando licença vigente, pelo número da licença: é o que "Utilizadas" conta
  const inUse = licenses.filter((l) => l.status === 'active' && l.automation).sort((a, b) => a.number - b.number);
  const free = licenses.filter((l) => l.status === 'active' && !l.automation).sort((a, b) => a.number - b.number);

  const columns: TableColumn<OrganizationLicense>[] = [
    { key: 'numero', header: 'Licença', render: (l) => `nº ${l.number}` },
    {
      key: 'situacao',
      header: 'Situação',
      render: (l) => (
        <Badge tone={LICENSE_STATUS[l.status].tone} dot>
          {LICENSE_STATUS[l.status].label}
        </Badge>
      ),
    },
    {
      key: 'validade',
      header: 'Validade',
      render: (l) => (
        <Stack gap={1}>
          <span>
            <DateTimeText iso={l.validFrom} /> até <DateTimeText iso={l.validUntil} />
          </span>
          {l.renewals > 0 && (
            <Text variant="body-sm" color="secondary">
              {l.renewals === 1 ? 'Renovada 1 vez' : `Renovada ${l.renewals} vezes`}
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: 'automacao',
      header: 'Automação',
      render: (l) =>
        l.automation ? (
          <Stack gap={1}>
            <span>{l.automation.name}</span>
            <Text variant="body-sm" color="secondary">
              {l.automation.workspaceName}
              {l.automation.executionInProgress ? ' · com execução em andamento agora' : ''}
            </Text>
          </Stack>
        ) : (
          <Text color="secondary">Disponível (sem automação)</Text>
        ),
    },
  ];

  const c = capacity;
  const legacyCapacity = c.model === 'legacy';

  return (
    <Stack gap={6}>
      <PageHeader
        title="Licenças e automações"
        subtitle="As licenças desta organização, as automações que elas atendem e, separadamente, os limites técnicos de capacidade."
        onRefresh={reloadAll}
      />

      <section aria-labelledby="pw-lic-licencas">
        <Stack gap={4}>
          <Text as="h2" variant="h3" id="pw-lic-licencas">
            Licenças
          </Text>
          <Alert tone={summary.model === 'licensed' ? 'info' : 'warning'} title={model.title}>
            {model.body}
          </Alert>
          <div className="pw-lic__tiles" role="group" aria-label="Conta das licenças">
            <Card variant="outlined" padding="md">
              <Usage label="Contratadas (vigentes)" used={summary.contracted} limit={null} />
            </Card>
            <Card variant="outlined" padding="md">
              <Usage label="Utilizadas (com automação)" used={summary.used} limit={null}>
                {inUse.length > 0 && (
                  <ul className="pw-lic__names" aria-label="Automações com licença">
                    {inUse.map((l) => (
                      <li key={l.licenseId}>
                        <Text variant="body-sm" color="secondary">
                          nº {l.number}: {l.automation!.name}
                        </Text>
                      </li>
                    ))}
                  </ul>
                )}
              </Usage>
            </Card>
            <Card variant="outlined" padding="md">
              <Usage label="Disponíveis (sem automação)" used={summary.available} limit={null}>
                {free.length > 0 && (
                  <Text variant="body-sm" color="secondary">
                    {free.map((l) => `nº ${l.number}`).join(', ')}
                  </Text>
                )}
              </Usage>
            </Card>
          </div>
          {free.length > 0 && (
            <Alert tone="info" title={free.length === 1 ? 'Você tem 1 licença disponível.' : `Você tem ${free.length} licenças disponíveis.`}>
              Para usar uma licença, use “Ativar automação” logo abaixo: escolha o ambiente de trabalho, a automação e os Workers. Enquanto não for usada, a
              licença não libera a execução de nenhuma automação.
            </Alert>
          )}
          {summary.expiredWithAutomation > 0 && (
            <Alert tone="warning" title={summary.expiredWithAutomation === 1 ? 'Uma licença vencida continua vinculada a uma automação.' : `${summary.expiredWithAutomation} licenças vencidas continuam vinculadas a automações.`}>
              {summary.model === 'licensed'
                ? 'Essas automações não iniciam trabalho novo até a renovação. O que já estava em execução termina e entrega, e o histórico continua disponível. A renovação é feita pelo suporte da Nekkora e mantém a mesma automação.'
                : 'A renovação é feita pelo suporte da Nekkora e mantém a mesma automação.'}
            </Alert>
          )}
        </Stack>
      </section>

      <ActivationSection data={activations} onChanged={reloadAll} canActivate />

      <section aria-labelledby="pw-lic-lista">
        <Stack gap={3}>
          <Text as="h2" variant="h3" id="pw-lic-lista">
            Licenças, pelo número
          </Text>
          {licenses.length === 0 ? (
            <StateView
              status="neutral"
              title="Esta organização ainda não tem licenças."
              description="As licenças são concedidas pelo suporte da Nekkora. Criar a organização não concede licença."
            />
          ) : (
            <div className="pw-prod__scroll" role="region" aria-label="Lista de licenças" tabIndex={0}>
              <Table columns={columns} data={licenses} rowKey="licenseId" size="sm" caption="Licenças da organização, pelo número." />
            </div>
          )}
          <Text variant="body-sm" color="secondary">
            Uma licença atende uma automação durante o ciclo, em qualquer número de Workers, e não é desfeita por aqui: trocar a automação atendida é uma
            transferência, feita pelo suporte da Nekkora a pedido de quem administra a organização. Conceder, renovar e encerrar licenças também são atos
            do suporte.
          </Text>
        </Stack>
      </section>

      <section aria-labelledby="pw-lic-capacidade">
        <Stack gap={4}>
          <Text as="h2" variant="h3" id="pw-lic-capacidade">
            Capacidade
          </Text>
          <Text color="secondary">{CAPACITY_TEXT.intro}</Text>
          {legacyCapacity && <Alert tone="info">{CAPACITY_TEXT.legacy}</Alert>}
          <div className="pw-lic__tiles" role="group" aria-label="Capacidade técnica">
            <Card variant="outlined" padding="md">
              <Usage label="Workers cadastrados" used={c.workers.used} limit={c.workers.limit} note={CAPACITY_TEXT.workersFull} />
            </Card>
            <Card variant="outlined" padding="md">
              <Usage label="Execuções simultâneas" used={c.concurrentExecutions.used} limit={c.concurrentExecutions.limit} note={CAPACITY_TEXT.concurrentFull}>
                <Text variant="body-sm" color="secondary">
                  Em execução: {c.concurrentExecutions.active}
                  {activeText(c.concurrentExecutions.breakdown) && ` (${activeText(c.concurrentExecutions.breakdown)})`}
                </Text>
                <Text variant="body-sm" color="secondary">
                  Reservadas por situação incerta: {c.concurrentExecutions.reservedUncertain}
                  {reservedText(c.concurrentExecutions.breakdown) && ` (${reservedText(c.concurrentExecutions.breakdown)})`}
                </Text>
              </Usage>
            </Card>
            <Card variant="outlined" padding="md">
              <Usage label="Execuções pendentes (na fila)" used={c.pendingExecutions.used} limit={c.pendingExecutions.limit} note={CAPACITY_TEXT.pendingFull} />
            </Card>
          </div>
          {c.concurrentExecutions.breakdown.previousAgentUnconfirmed > 0 && (
            <Alert tone="warning" title="Há execução do Agent anterior com resultado desconhecido reservando vaga.">
              {CAPACITY_TEXT.previousAgentUnconfirmed}
            </Alert>
          )}
          {c.concurrentExecutions.breakdown.unconfirmed > 0 && (
            <Alert tone="warning" title="Há execução com término não confirmado ocupando vaga.">
              A máquina ainda não confirmou que os processos dessas execuções terminaram. A vaga volta quando a máquina confirmar ou quando quem administra
              a organização declarar a reconciliação da tentativa, na página da execução remota.
            </Alert>
          )}
        </Stack>
      </section>
    </Stack>
  );
}
