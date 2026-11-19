import { useCallback, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Heading, Input, Select, Stack, StateView, Table, Text, Textarea, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import {
  createOrganizationByOperator,
  endLicense,
  getOperatorOrganization,
  grantLicenses,
  listUnresolvedSessions,
  previewEnforcement,
  reconcileSession,
  renewLicense,
  setEnforcement,
  transferLicense,
  type EnforcementPreview,
  type OperatorLicense,
  type OperatorOrganization,
  type PreviousAgentSession,
} from '../../api/licenseOperations';
import { useSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, orgStepUp } from '../access/shared';
import { DateTimeText, PageHeader } from '../product/shared';
import './licenses.css';

type Loaded = { organization: OperatorOrganization; preview: EnforcementPreview; sessions: PreviousAgentSession[] };
type Target = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: Loaded } | { status: 'error'; text: string };
type Act =
  | { kind: 'create' }
  | { kind: 'grant' }
  | { kind: 'enforce'; model: 'licensed' | 'legacy' }
  | { kind: 'renew'; license: OperatorLicense }
  | { kind: 'end'; license: OperatorLicense }
  | { kind: 'transfer'; license: OperatorLicense }
  | { kind: 'reconcile'; session: PreviousAgentSession };

export const OPERATOR_TEXT = {
  intro:
    'Área do suporte da Nekkora. Cada ato pede a sua confirmação reforçada e uma justificativa, e fica registrado com o seu nome. Você não ganha acesso aos dados da organização do cliente: vê só o necessário para o ato.',
  target: 'O identificador é o que aparece no endereço da organização do cliente, depois de "/o/". Peça ao administrador no chamado.',
  create:
    'Você indica a pessoa responsável pelo e-mail verificado dela. Ela recebe a administração da nova organização e passa a ser a responsável. Você não recebe conta nem acesso. Um membro pode ser indicado; quem só tem conta de Cliente, não. O limite de organizações vazias da pessoa continua valendo.',
  exceed: 'Ultrapassar o limite de organizações vazias desta pessoa. É uma exceção da Nekkora: fica registrada com a justificativa abaixo.',
  enforceOn:
    'Ligar a exigência faz executar e monitorar pela Platform depender de licença nesta organização. As automações abaixo estão em uso e ficariam sem trabalho novo. Autorizações já entregues continuam valendo sem conexão até a validade: uma máquina desconectada não é bloqueada de imediato.',
  enforceOff: 'Desligar a exigência devolve a organização à ativação e aos limites anteriores. Licenças, vínculos e histórico ficam como estão.',
  transfer:
    'A transferência é feita a pedido de um administrador da organização, recebido pelo atendimento. Você atesta o pedido: o solicitante, o chamado e como a identidade foi verificada ficam gravados. É recusada enquanto puder existir trabalho na automação de origem.',
  reconcile:
    'A reconciliação registra o que você verificou: que o processo terminou, ou que a máquina está fora de operação. Tempo sem contato, sozinho, não basta. Ela não altera a sessão: o estado continua o que a máquina informou, nenhum desfecho é gravado e nada declara a máquina livre. O efeito é a sessão deixar de segurar a transferência de licença e a vaga de execução. A declaração fica no histórico; se a máquina informar depois que a execução ainda está ativa, a sessão volta a contar.',
  reconcileAck: 'Verifiquei, fora do sistema, que o processo terminou ou que a máquina está fora de operação.',
  sessions:
    'Sessões do Agent anterior sem desfecho confiável: resultado desconhecido, ou sem encerramento. Cada uma segura a transferência de licença da automação e reserva uma vaga de execução da organização. O tempo decorrido não libera nada: só a reconciliação, ou o desfecho informado pela máquina.',
} as const;

export const SESSION_STATE: Record<PreviousAgentSession['state'], string> = {
  READY: 'Pronta (sem encerramento)',
  STARTING: 'Iniciando (sem encerramento)',
  RUNNING: 'Em execução (sem encerramento)',
  OUTCOME_UNKNOWN: 'Resultado desconhecido',
};

const LICENSE_STATUS: Record<OperatorLicense['status'], { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  VALID: { label: 'Vigente', tone: 'success' },
  NOT_VALID: { label: 'Sem período vigente', tone: 'warning' },
  ENDED: { label: 'Encerrada', tone: 'neutral' },
};

const REFUSAL: Record<string, string> = {
  organization_responsible_not_found: 'Não há conta Nekkora ativa com esse e-mail verificado. A pessoa precisa se cadastrar e confirmar o e-mail antes.',
  organization_responsible_is_client: 'A pessoa indicada só tem conta do tipo Cliente e não pode ser responsável por uma organização.',
  organization_name_taken: 'A pessoa indicada já tem uma organização com esse nome.',
  empty_organization_limit_reached:
    'A pessoa indicada já está no limite de organizações vazias. Ela pode usar ou desativar uma delas; ou a Nekkora ultrapassa o limite por exceção, marcando a opção e justificando.',
  organization_limit_reached: 'A pessoa indicada atingiu o número máximo de organizações criadas. Esse teto não é ultrapassado por aqui.',
  license_preview_changed: 'O conjunto de automações mudou desde a prévia. A prévia foi refeita: confira de novo antes de ligar.',
  license_model_unchanged: 'A organização já está nesse modelo.',
  license_not_assigned: 'A licença não está vinculada a nenhuma automação.',
  license_transfer_same_automation: 'A licença já está nessa automação.',
  license_transfer_work_in_progress:
    'Ainda pode existir trabalho na automação de origem: execução, monitoramento, pedido pendente, tentativa remota não terminada ou sessão do Agent anterior sem desfecho confiável. Precisa terminar, ter o cancelamento confirmado ou ser reconciliada.',
  license_transfer_requester_not_admin: 'O solicitante informado não administra esta organização agora.',
  automation_already_licensed: 'A automação de destino já tem licença.',
  license_automation_archived: 'A automação de destino está arquivada.',
  license_not_valid: 'A licença não está vigente. Renove antes.',
  license_ended: 'A licença foi encerrada.',
  license_period_overlaps: 'O período informado se sobrepõe a um período existente da licença.',
  license_period_already_ended: 'O período informado já terminou.',
  previous_agent_session_has_outcome: 'A máquina já informou o desfecho desta sessão. Não há o que reconciliar.',
  previous_agent_session_already_reconciled: 'Esta sessão já foi reconciliada.',
};

function refusal(e: unknown): string {
  const reason = isApiError(e, 'conflict') ? (e as { reason?: string }).reason : undefined;
  return reason && REFUSAL[reason] ? `${REFUSAL[reason]} Nada foi alterado.` : accessRefusal(e);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const endOfDay = (d: string) => new Date(`${d}T23:59:59`).toISOString();
const startOfDay = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const text = (v: string, min: number, max: number) => v.trim().length >= min && v.trim().length <= max;

/**
 * /o/{org}/operador-de-licencas — interface mínima dos atos do operador de licenças da Nekkora (PLATFORM-LICENCIAMENTO-001):
 * criação excepcional de organização, concessão, renovação, encerramento, transferência, prévia e exigência, e a reconciliação
 * de sessões do Agent anterior. Só aparece no menu para quem a API reconhece como operador; o endereço direto de outra pessoa
 * mostra a recusa da API.
 */
export function LicenseOperatorPage() {
  const { org, expired } = useSession();
  const [targetId, setTargetId] = useState('');
  const [target, setTarget] = useState<Target>({ status: 'idle' });
  const [act, setAct] = useState<Act | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [ack, setAck] = useState(false);
  const generation = useRef(0);
  const set = (k: string) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const v = (k: string) => f[k] ?? '';

  const load = useCallback(
    async (id: string) => {
      const gen = ++generation.current;
      setTarget({ status: 'loading' });
      try {
        const [organization, preview, sessions] = [
          await getOperatorOrganization(org, id),
          await previewEnforcement(org, id),
          await listUnresolvedSessions(org, id),
        ];
        if (gen === generation.current) setTarget({ status: 'ready', data: { organization, preview, sessions: sessions.items } });
      } catch (e) {
        if (gen !== generation.current) return;
        if (isApiError(e, 'unauthenticated')) return expired();
        setTarget({
          status: 'error',
          text: isApiError(e, 'forbidden')
            ? 'Esta conta não é de um operador de licenças.'
            : isApiError(e, 'not_found') || (e as { status?: number }).status === 404
              ? 'Organização não encontrada, ou esta não é a organização interna da Nekkora.'
              : 'Não foi possível carregar a organização agora.',
        });
      }
    },
    [org, expired],
  );

  const open = (a: Act) => {
    setNotice(null);
    setF({});
    setAck(false);
    setAct(a);
  };
  const done = (message: string, reload = true) => {
    setAct(null);
    setNotice({ tone: 'success', text: message });
    if (reload && target.status === 'ready') void load(target.data.organization.organizationId);
  };
  const data = target.status === 'ready' ? target.data : null;
  const tid = data?.organization.organizationId ?? '';
  const justified = text(v('justification'), 10, 1000);
  const justification = v('justification').trim();
  const common = { stepUp: orgStepUp(org), onClose: () => setAct(null), refusalText: refusal, onUnauthenticated: expired } as const;
  const justificationField = (
    <Textarea
      label="Justificativa"
      fullWidth
      value={v('justification')}
      onChange={set('justification')}
      hint="De 10 a 1000 caracteres. Fica gravada no ato."
    />
  );

  const licenseColumns: TableColumn<OperatorLicense>[] = [
    { key: 'numero', header: 'Licença', render: (l) => `nº ${l.number}` },
    { key: 'situacao', header: 'Situação', render: (l) => <Badge tone={LICENSE_STATUS[l.status].tone}>{LICENSE_STATUS[l.status].label}</Badge> },
    { key: 'ate', header: 'Vale até', render: (l) => (l.validUntil ? <DateTimeText iso={l.validUntil} /> : '—') },
    { key: 'automacao', header: 'Automação', render: (l) => l.automationName ?? 'sem vínculo' },
    {
      key: 'acoes',
      header: 'Ações',
      render: (l) =>
        l.status === 'ENDED' ? null : (
          <div className="pw-form__row">
            <Button size="sm" variant="secondary" onClick={() => open({ kind: 'renew', license: l })} aria-label={`Renovar a licença nº ${l.number}`}>
              Renovar
            </Button>
            {l.automationId && (
              <Button size="sm" variant="secondary" onClick={() => open({ kind: 'transfer', license: l })} aria-label={`Transferir a licença nº ${l.number}`}>
                Transferir
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => open({ kind: 'end', license: l })} aria-label={`Encerrar a licença nº ${l.number}`}>
              Encerrar
            </Button>
          </div>
        ),
    },
  ];
  const sessionColumns: TableColumn<PreviousAgentSession>[] = [
    { key: 'automacao', header: 'Automação', render: (s) => s.automationName },
    { key: 'estado', header: 'Estado informado pela máquina', render: (s) => SESSION_STATE[s.state] },
    { key: 'registro', header: 'Registrada em', render: (s) => <DateTimeText iso={s.registeredAt} /> },
    { key: 'noticia', header: 'Última notícia', render: (s) => <DateTimeText iso={s.lastReportAt} /> },
    {
      key: 'segura',
      header: 'Segura',
      render: (s) => (
        <Stack gap={1}>
          <span>transferência e uma vaga de execução</span>
          {s.previouslyReconciledAt && (
            <Text variant="body-sm" color="secondary">
              Reconciliada em <DateTimeText iso={s.previouslyReconciledAt} />; depois disso a máquina informou execução ativa.
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: 'acoes',
      header: 'Ações',
      render: (s) => (
        <Button size="sm" variant="secondary" onClick={() => open({ kind: 'reconcile', session: s })} aria-label={`Reconciliar a sessão de ${s.automationName}`}>
          Reconciliar
        </Button>
      ),
    },
  ];

  return (
    <Stack gap={5}>
      <PageHeader title="Operador de licenças" subtitle={OPERATOR_TEXT.intro} />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <Card variant="outlined" padding="md" aria-label="Criação excepcional de organização">
        <Stack gap={3}>
          <Heading level={2}>Criação excepcional de organização</Heading>
          <Text variant="body-sm" color="secondary">
            {OPERATOR_TEXT.create}
          </Text>
          <div>
            <Button variant="secondary" onClick={() => open({ kind: 'create' })}>
              Criar organização por exceção
            </Button>
          </div>
        </Stack>
      </Card>

      <Card variant="outlined" padding="md" aria-label="Organização do cliente">
        <Stack gap={3}>
          <Heading level={2}>Organização do cliente</Heading>
          <form
            className="pw-form__row"
            onSubmit={(e) => {
              e.preventDefault();
              setNotice(null);
              if (UUID.test(targetId.trim())) void load(targetId.trim());
            }}
          >
            <Input
              label="Identificador da organização"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              hint={OPERATOR_TEXT.target}
              error={targetId && !UUID.test(targetId.trim()) ? 'Não é um identificador de organização.' : undefined}
              fullWidth
            />
            <Button type="submit" disabled={!UUID.test(targetId.trim())} loading={target.status === 'loading'}>
              Abrir
            </Button>
          </form>
          {target.status === 'error' && <Alert tone="warning">{target.text}</Alert>}
          {target.status === 'loading' && <StateView status="loading" title="Carregando a organização…" />}
        </Stack>
      </Card>

      {data && (
        <>
          <Card variant="outlined" padding="md" aria-label="Modelo e exigência de licença">
            <Stack gap={3}>
              <Heading level={2}>{data.organization.name}</Heading>
              <div className="pw-form__row">
                <Badge tone={data.preview.model === 'licensed' ? 'info' : 'neutral'}>
                  {data.preview.model === 'licensed' ? 'Modelo por licença (exigência ligada)' : 'Modelo anterior (exigência desligada)'}
                </Badge>
                <Text variant="body-sm" color="secondary">
                  Licenças: {data.preview.contracted} contratadas, {data.preview.used} utilizadas, {data.preview.available} disponíveis.
                </Text>
              </div>
              <Text variant="body-sm">
                Prévia de agora: {data.preview.blockedAutomations.length} automação(ões) em uso ficaria(m) sem licença; {data.preview.offlineAuthorizations}{' '}
                autorização(ões) já entregue(s) continuaria(m) valendo
                {data.preview.offlineAuthorizationsValidUntil ? (
                  <>
                    {' '}
                    até <DateTimeText iso={data.preview.offlineAuthorizationsValidUntil} />
                  </>
                ) : null}
                ; {data.preview.workInProgress} com trabalho em andamento.
              </Text>
              {data.preview.blockedAutomations.length > 0 && (
                <ul aria-label="Automações em uso sem licença">
                  {data.preview.blockedAutomations.map((a) => (
                    <li key={a.automationId}>
                      <Text variant="body-sm">
                        {a.name} ({a.workspaceName})
                      </Text>
                    </li>
                  ))}
                </ul>
              )}
              <div className="pw-form__row">
                <Button onClick={() => open({ kind: 'grant' })}>Conceder licenças</Button>
                {data.preview.model === 'legacy' ? (
                  <Button variant="secondary" onClick={() => open({ kind: 'enforce', model: 'licensed' })}>
                    Ligar a exigência de licença
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => open({ kind: 'enforce', model: 'legacy' })}>
                    Desligar a exigência de licença
                  </Button>
                )}
                <Button variant="ghost" leftIcon="refresh" onClick={() => void load(tid)}>
                  Atualizar
                </Button>
              </div>
            </Stack>
          </Card>

          <Card variant="outlined" padding="md" aria-label="Licenças da organização">
            <Stack gap={3}>
              <Heading level={2}>Licenças</Heading>
              {data.organization.licenses.length === 0 ? (
                <Text color="secondary">Nenhuma licença concedida a esta organização.</Text>
              ) : (
                <div className="pw-prod__scroll" role="region" aria-label="Lista de licenças da organização" tabIndex={0}>
                  <Table columns={licenseColumns} data={data.organization.licenses} rowKey="licenseId" size="sm" caption="Licenças da organização do cliente." />
                </div>
              )}
              <Text variant="body-sm" color="secondary">
                Vincular uma licença disponível a uma automação é ato do administrador da organização, não do suporte.
              </Text>
            </Stack>
          </Card>

          <Card variant="outlined" padding="md" aria-label="Sessões do Agent anterior sem desfecho">
            <Stack gap={3}>
              <Heading level={2}>Sessões do Agent anterior sem desfecho</Heading>
              <Text variant="body-sm" color="secondary">
                {OPERATOR_TEXT.sessions}
              </Text>
              {data.sessions.length === 0 ? (
                <Text color="secondary">Nenhuma sessão sem desfecho nesta organização.</Text>
              ) : (
                <div className="pw-prod__scroll" role="region" aria-label="Lista de sessões sem desfecho" tabIndex={0}>
                  <Table columns={sessionColumns} data={data.sessions} rowKey="sessionId" size="sm" caption="Sessões do Agent anterior sem desfecho confiável." />
                </div>
              )}
            </Stack>
          </Card>
        </>
      )}

      <StepUpDialog<{ organizationId: string; emptyLimitExceeded: boolean }>
        {...common}
        open={act?.kind === 'create'}
        ready={justified && /\S+@\S+\.\S+/.test(v('email')) && text(v('name'), 1, 120) && text(v('legalName'), 1, 120) && (!ack || text(v('limitJustification'), 10, 1000))}
        title="Criar uma organização por exceção?"
        guard={{ operation: 'license-operator.create-organization', target: `${v('email')}|${v('name')}` }}
        confirmLabel="Criar a organização"
        action={() =>
          createOrganizationByOperator(org, {
            responsibleEmail: v('email').trim(),
            name: v('name').trim(),
            legalName: v('legalName').trim(),
            justification,
            // a exceção ao limite de vazias só vai quando marcada, com a justificativa própria
            ...(ack ? { exceedEmptyLimit: true, limitJustification: v('limitJustification').trim() } : {}),
          })
        }
        onDone={(r) =>
          done(
            `Organização criada. Identificador: ${r.organizationId}. A pessoa indicada a administra; você não tem acesso a ela.${r.emptyLimitExceeded ? ' O limite de organizações vazias dela foi ultrapassado por exceção, registrada com a sua justificativa.' : ''}`,
            false,
          )
        }
        uncertainText="Não foi possível confirmar a criação. Antes de repetir, confira com a pessoa indicada se a organização apareceu para ela."
      >
        <Stack gap={3}>
          <Text>{OPERATOR_TEXT.create}</Text>
          <Input label="E-mail da pessoa responsável" type="email" fullWidth value={v('email')} onChange={set('email')} hint="O e-mail verificado da conta Nekkora dela." />
          <Input label="Nome da organização" fullWidth value={v('name')} onChange={set('name')} />
          <Input label="Razão social" fullWidth value={v('legalName')} onChange={set('legalName')} />
          {justificationField}
          <Checkbox label={OPERATOR_TEXT.exceed} checked={ack} onChange={(e) => setAck(e.target.checked)} />
          {ack && (
            <Textarea
              label="Justificativa da exceção ao limite"
              fullWidth
              value={v('limitJustification')}
              onChange={set('limitJustification')}
              hint="Por que esta pessoa pode ter mais uma organização vazia. De 10 a 1000 caracteres."
            />
          )}
        </Stack>
      </StepUpDialog>

      <StepUpDialog
        {...common}
        open={act?.kind === 'grant'}
        ready={justified && Number(v('count')) >= 1 && Number(v('count')) <= 100 && !!v('startsAt') && !!v('endsAt') && v('endsAt') > v('startsAt')}
        title={data ? `Conceder licenças a ${data.organization.name}?` : ''}
        guard={{ operation: 'license-operator.grant', target: `${tid}|${v('count')}|${v('startsAt')}|${v('endsAt')}` }}
        confirmLabel="Conceder"
        action={() => grantLicenses(org, tid, { count: Number(v('count')), startsAt: startOfDay(v('startsAt')), endsAt: endOfDay(v('endsAt')), justification })}
        onDone={() => done('Licenças concedidas. Elas nascem sem vínculo: quem administra a organização vincula cada uma a uma automação.')}
        uncertainText="Não foi possível confirmar a concessão. Atualize e confira a lista de licenças antes de repetir."
      >
        <Stack gap={3}>
          <Input label="Quantidade" type="number" fullWidth value={v('count')} onChange={set('count')} hint="De 1 a 100." />
          <Input label="Início da validade" type="date" fullWidth value={v('startsAt')} onChange={set('startsAt')} />
          <Input label="Fim da validade" type="date" fullWidth value={v('endsAt')} onChange={set('endsAt')} />
          {justificationField}
        </Stack>
      </StepUpDialog>

      <StepUpDialog
        {...common}
        open={act?.kind === 'enforce'}
        ready={justified && (act?.kind !== 'enforce' || act.model === 'legacy' || ack)}
        title={act?.kind === 'enforce' && data ? `${act.model === 'licensed' ? 'Ligar' : 'Desligar'} a exigência de licença em ${data.organization.name}?` : ''}
        guard={{ operation: 'license-operator.enforcement', target: `${tid}|${act?.kind === 'enforce' ? act.model : ''}` }}
        confirmLabel={act?.kind === 'enforce' && act.model === 'licensed' ? 'Ligar a exigência' : 'Desligar a exigência'}
        action={() =>
          act?.kind === 'enforce' && data
            ? setEnforcement(org, tid, { model: act.model, ...(act.model === 'licensed' ? { confirmPreview: data.preview.previewToken } : {}), justification })
            : Promise.reject()
        }
        onDone={() => done(act?.kind === 'enforce' && act.model === 'licensed' ? 'Exigência de licença ligada.' : 'Exigência de licença desligada.')}
        refusalText={(e) => {
          // a prévia mudou: a tela a refaz, para a pessoa conferir o conjunto atual antes de tentar de novo
          if (isApiError(e, 'conflict') && (e as { reason?: string }).reason === 'license_preview_changed' && tid) void load(tid);
          return refusal(e);
        }}
        uncertainText="Não foi possível confirmar a mudança. Atualize e confira o modelo da organização antes de repetir."
      >
        <Stack gap={3}>
          <Text>{act?.kind === 'enforce' && act.model === 'licensed' ? OPERATOR_TEXT.enforceOn : OPERATOR_TEXT.enforceOff}</Text>
          {act?.kind === 'enforce' && act.model === 'licensed' && data && (
            <>
              {data.preview.blockedAutomations.length === 0 ? (
                <Text variant="body-sm">Nenhuma automação em uso ficaria sem licença.</Text>
              ) : (
                <ul aria-label="Automações que ficariam sem trabalho novo">
                  {data.preview.blockedAutomations.map((a) => (
                    <li key={a.automationId}>
                      {a.name} ({a.workspaceName})
                    </li>
                  ))}
                </ul>
              )}
              <Checkbox
                label={`Conferi a prévia: ${data.preview.blockedAutomations.length} automação(ões) em uso ficará(ão) sem trabalho novo.`}
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
            </>
          )}
          {justificationField}
        </Stack>
      </StepUpDialog>

      <StepUpDialog
        {...common}
        open={act?.kind === 'renew'}
        ready={justified && !!v('endsAt')}
        title={act?.kind === 'renew' ? `Renovar a licença nº ${act.license.number}?` : ''}
        guard={{ operation: 'license-operator.renew', target: `${act?.kind === 'renew' ? act.license.licenseId : ''}|${v('endsAt')}` }}
        confirmLabel="Renovar"
        action={() =>
          act?.kind === 'renew'
            ? renewLicense(org, tid, act.license.licenseId, { ...(v('startsAt') ? { startsAt: startOfDay(v('startsAt')) } : {}), endsAt: endOfDay(v('endsAt')), justification })
            : Promise.reject()
        }
        onDone={() => done('Licença renovada. O vínculo com a automação não muda.')}
        uncertainText="Não foi possível confirmar a renovação. Atualize e confira a validade antes de repetir."
      >
        <Stack gap={3}>
          <Text>A renovação acrescenta um período de validade. A licença continua vinculada à mesma automação.</Text>
          <Input label="Início do novo período" type="date" fullWidth value={v('startsAt')} onChange={set('startsAt')} hint="Opcional. Em branco, o novo período começa no fim do último, sem intervalo." />
          <Input label="Fim do novo período" type="date" fullWidth value={v('endsAt')} onChange={set('endsAt')} />
          {justificationField}
        </Stack>
      </StepUpDialog>

      <StepUpDialog
        {...common}
        open={act?.kind === 'end'}
        ready={justified}
        tone="danger"
        title={act?.kind === 'end' ? `Encerrar a licença nº ${act.license.number}?` : ''}
        guard={{ operation: 'license-operator.end', target: act?.kind === 'end' ? act.license.licenseId : undefined }}
        confirmLabel="Encerrar a licença"
        action={() => (act?.kind === 'end' ? endLicense(org, tid, act.license.licenseId, justification) : Promise.reject())}
        onDone={() => done('Licença encerrada.')}
        uncertainText="Não foi possível confirmar o encerramento. Atualize e confira antes de repetir."
      >
        <Stack gap={3}>
          <Text>Encerrar é definitivo: a licença não é reaberta nem renovada depois. O que já está em execução não é interrompido.</Text>
          {justificationField}
        </Stack>
      </StepUpDialog>

      <StepUpDialog
        {...common}
        open={act?.kind === 'transfer'}
        ready={justified && !!v('to') && /\S+@\S+\.\S+/.test(v('requester')) && text(v('ticket'), 3, 200) && text(v('verification'), 10, 500)}
        title={act?.kind === 'transfer' ? `Transferir a licença nº ${act.license.number}, hoje em "${act.license.automationName}"?` : ''}
        guard={{ operation: 'license-operator.transfer', target: `${act?.kind === 'transfer' ? act.license.licenseId : ''}|${v('to')}` }}
        confirmLabel="Transferir"
        action={() =>
          act?.kind === 'transfer'
            ? transferLicense(org, tid, act.license.licenseId, {
                toAutomationId: v('to'),
                requesterEmail: v('requester').trim(),
                ticketReference: v('ticket').trim(),
                identityVerification: v('verification').trim(),
                justification,
              })
            : Promise.reject()
        }
        onDone={() => done('Licença transferida. O fim do ciclo não mudou.')}
        uncertainText="Não foi possível confirmar a transferência. Atualize e confira em qual automação a licença está antes de repetir."
      >
        <Stack gap={3}>
          <Text>{OPERATOR_TEXT.transfer}</Text>
          <Select
            label="Automação de destino"
            fullWidth
            value={v('to')}
            onChange={set('to')}
            placeholder="Escolha a automação"
            options={(data?.organization.automations ?? [])
              .filter((a) => act?.kind !== 'transfer' || a.automationId !== act.license.automationId)
              .map((a) => ({ value: a.automationId, label: a.name }))}
          />
          <Input label="E-mail do administrador que pediu" type="email" fullWidth value={v('requester')} onChange={set('requester')} />
          <Input label="Referência do chamado" fullWidth value={v('ticket')} onChange={set('ticket')} />
          <Textarea label="Como a identidade do solicitante foi verificada" fullWidth value={v('verification')} onChange={set('verification')} hint="De 10 a 500 caracteres." />
          {justificationField}
        </Stack>
      </StepUpDialog>

      <StepUpDialog
        {...common}
        open={act?.kind === 'reconcile'}
        ready={justified && text(v('verification'), 10, 1000) && ack}
        title={act?.kind === 'reconcile' ? `Reconciliar a sessão de "${act.session.automationName}"?` : ''}
        guard={{ operation: 'license-operator.reconcile', target: act?.kind === 'reconcile' ? act.session.sessionId : undefined }}
        confirmLabel="Registrar a reconciliação"
        action={() =>
          act?.kind === 'reconcile' ? reconcileSession(org, tid, act.session.sessionId, { justification, verification: v('verification').trim() }) : Promise.reject()
        }
        onDone={() => done('Reconciliação registrada. A sessão não foi alterada: ela só deixou de segurar a transferência e a vaga.')}
        uncertainText="Não foi possível confirmar a reconciliação. Atualize e confira a lista de sessões antes de repetir."
      >
        <Stack gap={3}>
          <Text>{OPERATOR_TEXT.reconcile}</Text>
          {act?.kind === 'reconcile' && (
            <Text variant="body-sm" color="secondary">
              Estado informado pela máquina: {SESSION_STATE[act.session.state]}. Última notícia em <DateTimeText iso={act.session.lastReportAt} />.
            </Text>
          )}
          <Textarea label="Verificação realizada" fullWidth value={v('verification')} onChange={set('verification')} hint="O que foi conferido e como. De 10 a 1000 caracteres." />
          {justificationField}
          <Checkbox label={OPERATOR_TEXT.reconcileAck} checked={ack} onChange={(e) => setAck(e.target.checked)} />
        </Stack>
      </StepUpDialog>
    </Stack>
  );
}
