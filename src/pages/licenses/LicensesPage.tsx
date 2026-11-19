import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Select, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import { assignLicense, getCapacity, getLicenseSummary, listAllLicenses, type LicenseSummary, type OrganizationCapacity, type OrganizationLicense } from '../../api/licenses';
import { listOrganizationAutomations } from '../../api/product';
import type { OrganizationAutomation } from '../../api/v1';
import { useSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, orgStepUp } from '../access/shared';
import { ForbiddenState } from '../admin/shared';
import { DateTimeText, LoadErrorState, PageHeader } from '../product/shared';
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
    body: 'Executar e monitorar seguem as regras anteriores. As licenças abaixo já podem ser vinculadas às automações; a exigência é ligada pelo suporte da Nekkora, que antes mostra quais automações ficariam sem licença.',
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
} as const;

const ASSIGN_REFUSAL: Record<string, string> = {
  license_already_assigned: 'Esta licença já foi vinculada a uma automação. Atualize a lista.',
  automation_already_licensed: 'Esta automação já tem uma licença.',
  license_not_valid: 'Esta licença não está vigente.',
  license_automation_archived: 'A automação está arquivada e não recebe licença.',
};

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

/** De que é feita a ocupação das vagas de execução, em palavras. Só as parcelas que existem. */
export function breakdownText(b: OrganizationCapacity['concurrentExecutions']['breakdown']): string {
  const parts = [
    b.remote ? `${b.remote} pelo Agent Client` : '',
    b.previousAgent ? `${b.previousAgent} pelo Agent anterior` : '',
    b.platform ? `${b.platform} pela Platform` : '',
    b.unconfirmed ? `${b.unconfirmed} com término não confirmado pela máquina` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * /o/{org}/administracao/licencas — licenças de execução e monitoração da organização e, SEPARADA, a capacidade técnica
 * (PLATFORM-LICENCIAMENTO-001). Só para quem administra a organização (org.manage). Daqui só se VINCULA uma licença
 * disponível a uma automação; conceder, renovar, encerrar e transferir são atos do suporte da Nekkora. A API decide tudo.
 */
export function LicensesPage() {
  const { org, expired } = useSession();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [automations, setAutomations] = useState<OrganizationAutomation[] | null>(null);
  const [assigning, setAssigning] = useState<OrganizationLicense | null>(null);
  const [automationId, setAutomationId] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
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

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  const openAssign = async (license: OrganizationLicense) => {
    setNotice(null);
    setAutomationId('');
    setAssigning(license);
    try {
      const page = await listOrganizationAutomations(org, { limit: 100 });
      setAutomations(page.items);
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      setAutomations([]);
    }
  };

  if (state.status === 'loading') return <StateView status="loading" title="Carregando licenças e capacidade…" />;
  if (state.status === 'error')
    return isApiError(state.error, 'forbidden') ? (
      <ForbiddenState area="as licenças e a capacidade" onRetry={() => void load()} />
    ) : (
      <LoadErrorState error={state.error} onRetry={() => void load()} />
    );

  const { summary, licenses, capacity } = state.data;
  const model = MODEL_TEXT[summary.model];
  const licensed = new Set(licenses.filter((l) => l.automation && (l.status === 'active' || l.status === 'scheduled' || l.status === 'expired')).map((l) => l.automation!.automationId));
  const choices = (automations ?? [])
    .filter((a) => a.status !== 'archived' && !licensed.has(a.automationId))
    .map((a) => ({ value: a.automationId, label: `${a.name} · ${a.workspaceName}` }));
  const chosen = automations?.find((a) => a.automationId === automationId);

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
    {
      key: 'acoes',
      header: 'Ações',
      render: (l) =>
        l.status === 'active' && !l.automation ? (
          <Button size="sm" variant="secondary" onClick={() => void openAssign(l)} aria-label={`Vincular a licença nº ${l.number} a uma automação`}>
            Vincular a uma automação
          </Button>
        ) : null,
    },
  ];

  const c = capacity;
  const legacyCapacity = c.model === 'legacy';

  return (
    <Stack gap={6}>
      <PageHeader
        title="Licenças e capacidade"
        subtitle="As licenças de execução e monitoração desta organização e, separadamente, os limites técnicos de capacidade."
        onRefresh={() => void load()}
      />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

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
              <Usage label="Utilizadas (com automação)" used={summary.used} limit={null} />
            </Card>
            <Card variant="outlined" padding="md">
              <Usage label="Disponíveis (sem automação)" used={summary.available} limit={null} />
            </Card>
          </div>
          {summary.expiredWithAutomation > 0 && (
            <Alert tone="warning" title={summary.expiredWithAutomation === 1 ? 'Uma licença vencida continua vinculada a uma automação.' : `${summary.expiredWithAutomation} licenças vencidas continuam vinculadas a automações.`}>
              {summary.model === 'licensed'
                ? 'Essas automações não iniciam trabalho novo até a renovação. O que já estava em execução termina e entrega, e o histórico continua disponível. A renovação é feita pelo suporte da Nekkora e mantém a mesma automação.'
                : 'A renovação é feita pelo suporte da Nekkora e mantém a mesma automação.'}
            </Alert>
          )}
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
            Uma licença atende uma automação durante o ciclo. O vínculo é escolhido por você e não é desfeito por aqui: trocar a automação atendida é uma
            transferência, feita pelo suporte da Nekkora a pedido de quem administra a organização. Conceder, renovar e encerrar licenças também são atos do
            suporte.
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
                {breakdownText(c.concurrentExecutions.breakdown) && (
                  <Text variant="body-sm" color="secondary">
                    {breakdownText(c.concurrentExecutions.breakdown)}
                  </Text>
                )}
              </Usage>
            </Card>
            <Card variant="outlined" padding="md">
              <Usage label="Execuções pendentes (na fila)" used={c.pendingExecutions.used} limit={c.pendingExecutions.limit} note={CAPACITY_TEXT.pendingFull} />
            </Card>
          </div>
          {c.concurrentExecutions.breakdown.unconfirmed > 0 && (
            <Alert tone="warning" title="Há execução com término não confirmado ocupando vaga.">
              A máquina ainda não confirmou que os processos dessas execuções terminaram. A vaga volta quando a máquina confirmar ou quando quem administra
              a organização declarar a reconciliação da tentativa, na página da execução remota.
            </Alert>
          )}
        </Stack>
      </section>

      <StepUpDialog
        open={assigning !== null}
        title={assigning ? `Vincular a licença nº ${assigning.number} a uma automação?` : ''}
        guard={{ operation: 'license.assign', target: assigning?.licenseId }}
        confirmLabel="Vincular licença"
        stepUp={orgStepUp(org)}
        ready={!!chosen}
        action={() => (assigning && chosen ? assignLicense(org, assigning.licenseId, chosen.automationId) : Promise.reject())}
        onDone={() => {
          const name = chosen?.name ?? 'a automação';
          setAssigning(null);
          setNotice({ tone: 'success', text: `Licença vinculada a ${name}.` });
          void load();
        }}
        onClose={() => setAssigning(null)}
        refusalText={(e) => {
          const reason = isApiError(e, 'conflict') ? (e as { reason?: string }).reason : undefined;
          return reason && ASSIGN_REFUSAL[reason] ? `${ASSIGN_REFUSAL[reason]} Nada foi alterado.` : accessRefusal(e);
        }}
        uncertainText="Não foi possível confirmar o vínculo. Feche e confira a lista de licenças antes de tentar de novo."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && setNotice({ tone: 'warning', text: 'O resultado do último vínculo não foi confirmado. Confira a lista.' })}
      >
        <Stack gap={3}>
          {automations === null ? (
            <Text color="secondary">Carregando as automações…</Text>
          ) : choices.length === 0 ? (
            <Alert tone="info">Não há automação sem licença para receber esta. Automações arquivadas não recebem licença.</Alert>
          ) : (
            <Select
              label="Automação que vai usar esta licença"
              fullWidth
              value={automationId}
              onChange={(e) => setAutomationId(e.target.value)}
              options={[{ value: '', label: 'Escolha a automação' }, ...choices]}
            />
          )}
          <Text>
            A licença passa a atender a automação escolhida até o fim do ciclo
            {assigning?.validUntil ? (
              <>
                {' '}
                (<DateTimeText iso={assigning.validUntil} />)
              </>
            ) : null}
            . Renovar a licença mantém a mesma automação.
          </Text>
          <Text>
            <strong>Você não desfaz este vínculo por aqui.</strong> Suspender ou arquivar a automação depois não libera a licença; trocar a automação é uma
            transferência, feita pelo suporte da Nekkora.
          </Text>
        </Stack>
      </StepUpDialog>
    </Stack>
  );
}
