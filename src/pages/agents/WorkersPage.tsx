import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { listMachineActivity, type MachineActivity } from '../../api/activity';
import { orgPath } from '../../auth/organization';
import { Alert, Badge, Button, Input, Select, Stack, StateView, Text, type TableColumn } from 'nekkora-lib';
import { authorizeWorkerInWorkspace, cancelAgentCode, createWorker, listWorkers, revokeWorkerInWorkspace, type AgentCode, type Worker } from '../../api/agents';
import { hasReason, isApiError } from '../../api/http';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, orgStepUp } from '../access/shared';
import { ForbiddenState } from '../admin/shared';
import { DateTimeText, LoadErrorState, PageHeader, RouteLink } from '../product/shared';
import './workers.css';
import { OneTimeCode, PairAgentDialog, RevokeLinkDialog, RotateCredentialDialog, type FreeWorker, type LinkedAgent } from './agentDialogs';
import { LinkedAgentsView } from './linkedAgents';
import { ResponsiveTable } from './ResponsiveTable';
import { CommunicationCell, FreshnessNotice, LinkBadge, PRESENCE_TEXT, useLiveList } from './presence';
import { MachineStateBadge } from './machine';

const STATUS: Record<NonNullable<Worker['status']>, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  ACTIVE: { label: 'Ativo', tone: 'success' },
  SUSPENDED: { label: 'Suspenso', tone: 'warning' },
  RETIRED: { label: 'Aposentado', tone: 'neutral' },
};

/** T08: texto de abertura da tela. */
export const WORKERS_INTRO = 'Crie máquinas, vincule as máquinas e escolha em quais ambientes de trabalho elas podem executar automações.';

/** T08: o destino do "Retirar" legível por teclado e leitor de tela (o workspace e o Worker do item). */
export const removeLabel = (workspace: string, worker: string) => `Retirar autorização de ${workspace} da máquina ${worker}`;

/** Texto da recusa por capacidade (409 worker_limit_reached), no modelo anterior: o limite vem da ativação. */
export const WORKER_LIMIT_TEXT =
  'A organização atingiu o limite de máquinas. Enquanto ela aguarda ativação, o limite é zero; depois da ativação, ele é definido pela Nekkora. Nada foi criado.';
/** A mesma recusa no modelo por licença: o limite é técnico, igual para todas, e não depende de ativação nem de licença. */
export const WORKER_LIMIT_TEXT_LICENSED =
  'A organização atingiu o limite técnico de máquinas cadastradas. É um limite de capacidade, igual para todas as organizações, sem relação com a ativação nem com a quantidade de licenças. Nada foi criado.';
export const workerLimitText = (model: 'legacy' | 'licensed' | undefined) => (model === 'licensed' ? WORKER_LIMIT_TEXT_LICENSED : WORKER_LIMIT_TEXT);

type Pending = { kind: 'authorize'; worker: Worker } | { kind: 'remove'; worker: Worker; workspaceId: string };

/**
 * /o/{org}/workers — Workers (worker.manage), entrada única do fluxo de execução local (PLATFORM-AGENT-V2-002, T07):
 * criar o Worker (sem Agent, sem código, sem execução), autorizá-lo em workspaces, vincular o Agent da máquina e
 * gerenciar o vínculo (renovar a credencial, revogar). Três dimensões separadas: a situação do Worker, a máquina
 * vinculada (só quando a lista do servidor a traz, depois do resgate do código) e a comunicação (último sinal).
 */
function WorkersManagement() {
  const { org, expired, me } = useSession();
  const { workspaces, permissions } = useInternalArea();
  const has = (p: string) => permissions.status === 'ready' && (permissions.data.organization.permissions as string[]).includes(p);
  // T11 (PLATFORM-AGENT-V2-003): releitura a cada 30 s com a página visível; falha mantém os dados como não confirmados
  const { list, freshness, load, refresh } = useLiveList(async () => (await listWorkers(org)).items, [org], expired);
  const [pending, setPending] = useState<Pending | null>(null);
  const [target, setTarget] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [pairing, setPairing] = useState<FreeWorker | null>(null);
  const [rotating, setRotating] = useState<LinkedAgent | null>(null);
  const [revoking, setRevoking] = useState<LinkedAgent | null>(null);
  const [code, setCode] = useState<{ code: AgentCode; purpose: string } | null>(null);

  // o código sai da memória ao sair da tela
  useEffect(() => () => setCode(null), []);
  // PLATFORM-FLUXO-002: a atividade de cada máquina (as mesmas linhas de Execuções, contadas no servidor); sem leitura de
  // execuções (automation.read), a coluna diz que não há atividade visível, sem esconder a máquina
  const [activity, setActivity] = useState<Map<string, MachineActivity> | null>(null);
  useEffect(() => {
    let alive = true;
    listMachineActivity(org).then(
      (r) => alive && setActivity(new Map(r.items.map((x) => [x.workerId, x]))),
      () => alive && setActivity(new Map()),
    );
    return () => {
      alive = false;
    };
  }, [org, list.status === 'ready' ? list.items : null]);
  // de uma execução para a sua máquina: /workers?maquina=<id> mostra só ela, com o caminho de volta para todas
  const [searchParams, setSearchParams] = useSearchParams();
  const focus = searchParams.get('maquina');

  if (list.status === 'error' && isApiError(list.error, 'forbidden')) return <ForbiddenState area="as máquinas" onRetry={() => void load()} />;

  const wsName = (id: string) => workspaces.items.find((w) => w.workspaceId === id)?.name ?? `Ambiente de trabalho ${id.slice(0, 8)}…`;
  const canCreate = has('worker.manage');
  // pareamento: a API exige agent.manage, agent_credential.manage e worker_agent.assign
  const canPair = has('agent.manage') && has('agent_credential.manage') && has('worker_agent.assign');
  const canRotate = has('agent_credential.manage');
  const canRevoke = has('agent.manage');
  const machineName = (w: Worker) => w.agentName ?? `Agent ${w.agentId!.slice(0, 8)}…`;
  const linked = (w: Worker): LinkedAgent => ({ agentId: w.agentId!, name: machineName(w), workerName: w.name ?? '' });
  const columns: TableColumn<Worker>[] = [
    { key: 'nome', header: 'Máquina', align: 'center', render: (w) => <span className="pw-break">{w.name}</span> },
    {
      key: 'situacao',
      header: 'Situação da máquina',
      align: 'center',
      // PLATFORM-FLUXO-002: cadastrada, aguardando conexão, conectada ou sem contato (o servidor decide o estado)
      render: (w) =>
        w.machineState ? (
          <MachineStateBadge state={w.machineState} lastContactAt={w.lastHeartbeatAt} />
        ) : w.status ? (
          <Badge tone={STATUS[w.status].tone}>{STATUS[w.status].label}</Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'maquina',
      header: 'Computador vinculado',
      align: 'center',
      render: (w) =>
        w.agentId ? (
          <Stack gap={1}>
            <span className="pw-break">{machineName(w)}</span>
            <LinkBadge status={w.agentStatus} />
            <Text variant="body-sm" color="secondary">
              Versão do Agent: {w.agentVersion ?? 'não informada'}
            </Text>
            <Text variant="body-sm" color="secondary">
              Credencial vale até <DateTimeText iso={w.credentialExpiresAt} />
            </Text>
          </Stack>
        ) : (
          // ausência de vínculo, nunca falta de sinal
          'Sem computador vinculado'
        ),
    },
    {
      key: 'comunicacao',
      header: 'Comunicação',
      align: 'center',
      render: (w) =>
        w.agentId ? (
          <CommunicationCell status={w.agentStatus} connectivity={w.connectivity} lastHeartbeatAt={w.lastHeartbeatAt} freshness={freshness} />
        ) : (
          <span aria-label="Sem computador vinculado">—</span>
        ),
    },
    {
      key: 'atividade',
      header: 'Atividade',
      align: 'center',
      render: (w) => {
        const a = activity?.get(w.workerId!);
        return (
          <Stack gap={1}>
            {activity === null ? (
              <Text variant="body-sm" color="secondary">
                Carregando…
              </Text>
            ) : !a ? (
              <Text variant="body-sm" color="secondary">
                Nenhuma execução visível para você.
              </Text>
            ) : (
              <>
                <Text variant="body-sm">{a.inProgress === 1 ? '1 em andamento' : `${a.inProgress} em andamento`}</Text>
                {a.attention > 0 && (
                  <Badge tone="warning" dot>
                    {a.attention === 1 ? '1 requer atenção' : `${a.attention} requerem atenção`}
                  </Badge>
                )}
                {a.lastActivityAt && (
                  <Text variant="body-sm" color="secondary">
                    Última: <DateTimeText iso={a.lastActivityAt} />
                  </Text>
                )}
              </>
            )}
            <RouteLink to={orgPath.machineActivity(org, w.workerId!)} aria-label={`Ver atividade de ${w.name}`}>
              Ver atividade
            </RouteLink>
          </Stack>
        );
      },
    },
    {
      key: 'workspaces',
      header: 'Ambientes de trabalho autorizados',
      align: 'center',
      render: (w) =>
        w.workspaceIds?.length ? (
          <ul className="pw-workers__ws" aria-label={`Ambientes de trabalho autorizados de ${w.name}`}>
            {w.workspaceIds.map((id) => (
              <li key={id} className="pw-workers__ws-item">
                <span className="pw-workers__ws-name">{wsName(id)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPending({ kind: 'remove', worker: w, workspaceId: id })}
                  aria-label={removeLabel(wsName(id), w.name ?? '')}
                >
                  Retirar
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <Text variant="body-sm" color="secondary">
            Nenhum
          </Text>
        ),
    },
    {
      key: 'acoes',
      header: 'Ações',
      align: 'center',
      render: (w) => (
        <div className="pw-workers__actions">
          {w.status === 'ACTIVE' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setTarget('');
                setPending({ kind: 'authorize', worker: w });
              }}
              aria-label={`Autorizar ${w.name} num ambiente de trabalho`}
            >
              Autorizar em ambiente de trabalho
            </Button>
          )}
          {w.status === 'ACTIVE' && !w.agentId && canPair && (
            <Button size="sm" variant="secondary" onClick={() => setPairing({ workerId: w.workerId!, name: w.name ?? '' })} aria-label={`Vincular Agent a ${w.name}`}>
              Vincular Agent
            </Button>
          )}
          {w.agentId && w.agentStatus !== 'REVOKED' && canRotate && (
            <Button size="sm" variant="ghost" onClick={() => setRotating(linked(w))} aria-label={`Renovar credencial de ${machineName(w)}`}>
              Renovar credencial
            </Button>
          )}
          {w.agentId && w.agentStatus !== 'REVOKED' && canRevoke && (
            <Button size="sm" variant="ghost" onClick={() => setRevoking(linked(w))} aria-label={`Revogar vínculo de ${machineName(w)} com ${w.name}`}>
              Revogar vínculo
            </Button>
          )}
        </div>
      ),
    },
  ];

  const done = (text: string) => {
    setPending(null);
    setNotice({ tone: 'success', text });
    void load();
  };

  return (
    <Stack gap={5}>
      <PageHeader
        title="Máquinas"
        subtitle={WORKERS_INTRO}
        onRefresh={() => void load()}
        actions={
          canCreate ? (
            <Button
              size="sm"
              leftIcon="plus"
              onClick={() => {
                setNewName('');
                setCreating(true);
              }}
            >
              Cadastrar máquina
            </Button>
          ) : undefined
        }
      />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {list.status === 'ready' && <FreshnessNotice freshness={freshness} onRetry={() => void refresh()} />}
      {code && (
        <section aria-label={code.purpose}>
          <Stack gap={2}>
            <Text weight="semibold">{code.purpose}</Text>
            <OneTimeCode
              key={code.code.enrollmentId}
              code={code.code}
              // código de pareamento OU de rotação: os dois ficam em agent_enrollments e o cancelamento vale para qualquer um ainda não usado
              onCancel={() => cancelAgentCode(org, code.code.enrollmentId)}
              onDone={() => {
                setCode(null);
                void load();
              }}
            />
          </Stack>
        </section>
      )}
      {list.status === 'loading' && <StateView status="loading" title="Carregando as máquinas…" />}
      {list.status === 'error' && <LoadErrorState error={list.error} onRetry={() => void load()} />}
      {list.status === 'ready' &&
        (list.items.length === 0 ? (
          <StateView
            status="neutral"
            title="Nenhuma máquina cadastrada."
            description="Use Cadastrar máquina para registrar onde as automações vão rodar. Depois, autorize a máquina nos ambientes de trabalho e vincule o Agent da máquina, na linha da máquina, na ordem que preferir."
          />
        ) : (
          <>
            {/* R1: tabela quando cabe; cartões quando não cabe (janela estreita, zoom de 200%), com as MESMAS colunas */}
            {focus && (
              <Alert tone="info">
                {list.items.some((w) => w.workerId === focus) ? 'Mostrando só a máquina da execução.' : 'A máquina indicada não está nesta lista (pode ter sido desativada ou não ser visível para você).'}{' '}
                <Button size="sm" variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
                  Mostrar todas as máquinas
                </Button>
              </Alert>
            )}
            <ResponsiveTable
              className="pw-prod__scroll pw-workers"
              label="Lista de máquinas"
              columns={columns}
              data={focus ? list.items.filter((w) => w.workerId === focus) : list.items}
              rowKey="workerId"
              title="nome"
              caption="Máquinas da organização."
            />
            <Text variant="body-sm" color="secondary">
              {PRESENCE_TEXT} Quando o contato voltar, a máquina aparece online de novo, sem novo pareamento.
            </Text>
          </>
        ))}

      <StepUpDialog
        open={creating}
        title="Cadastrar máquina"
        guard={{ operation: 'worker.create' }}
        confirmLabel="Cadastrar máquina"
        ready={newName.trim().length > 0 && newName.trim().length <= 80}
        action={() => createWorker(org, newName.trim())}
        onDone={(w) => {
          setCreating(false);
          setNotice({ tone: 'success', text: `Máquina ${w.name} cadastrada, sem computador vinculado. Autorize-a nos ambientes de trabalho e vincule o computador (Agent) quando quiser. Cadastrar não consome licença.` });
          void load();
        }}
        onClose={() => setCreating(false)}
        refusalText={(e) => (hasReason(e, 'conflict', 'worker_limit_reached') ? workerLimitText(me.organizationLicenseModel) : accessRefusal(e))}
        uncertainText="Não foi possível confirmar se a máquina foi criada. Feche e confira a lista de máquinas antes de criar de novo, para não cadastrar uma máquina repetida."
        onUnauthenticated={expired}
      >
        <Input label="Nome da máquina" required fullWidth maxLength={80} value={newName} onChange={(e) => setNewName(e.target.value)} hint="De 1 a 80 caracteres." />
        <Text variant="body-sm" color="secondary">
          Cadastrar a máquina não vincula computador, não emite código, não inicia execução e não consome licença. Depois, use Vincular Agent na linha da máquina para vincular o computador.
        </Text>
      </StepUpDialog>

      <PairAgentDialog
        worker={pairing}
        onDone={(c) => {
          const w = pairing;
          setPairing(null);
          setCode({
            code: c,
            purpose: c.remoteExecution
              ? `Código de habilitação para execução remota de ${w?.name ?? 'a máquina'}`
              : `Código de pareamento para ${w?.name ?? 'a máquina'}`,
          });
        }}
        onClose={() => setPairing(null)}
      />

      <RotateCredentialDialog
        agent={rotating}
        onDone={(c) => {
          const a = rotating;
          setRotating(null);
          setCode({ code: c, purpose: `Código de renovação da credencial de ${a?.name ?? 'a máquina'}` });
        }}
        onClose={() => setRotating(null)}
      />

      <RevokeLinkDialog
        agent={revoking}
        onDone={() => {
          const a = revoking;
          setRevoking(null);
          setNotice({
            tone: 'success',
            text: `Vínculo revogado: a máquina ${a?.workerName ?? ''} está livre, com os ambientes de trabalho e o histórico mantidos. A máquina precisa ser pareada de novo para voltar a executar. Isso não prova que um processo já em execução numa máquina desconectada parou.`,
          });
          void load();
        }}
        onClose={() => setRevoking(null)}
        onUncertain={() => setNotice({ tone: 'warning', text: 'O resultado da revogação não foi confirmado. Confira a lista.' })}
      />

      <StepUpDialog
        open={pending?.kind === 'authorize'}
        title={pending?.kind === 'authorize' ? `Autorizar ${pending.worker.name} num ambiente de trabalho` : ''}
        guard={{ operation: 'worker.authorize', target: pending?.kind === 'authorize' ? `${pending.worker.workerId}|${target}` : undefined }}
        confirmLabel="Autorizar"
        ready={!!target}
        stepUp={orgStepUp(org)}
        action={() => (pending?.kind === 'authorize' ? authorizeWorkerInWorkspace(org, pending.worker.workerId!, target) : Promise.reject())}
        onDone={(r) => done(r.created === false ? 'A máquina já estava autorizada neste ambiente de trabalho.' : 'Máquina autorizada no ambiente de trabalho.')}
        onClose={() => setPending(null)}
        refusalText={(e) => accessRefusal(e, { conflict: 'A máquina ou o ambiente de trabalho não está ativo.' })}
        uncertainText="Não foi possível confirmar a autorização. Feche e confira a lista (repetir é idempotente)."
        onUnauthenticated={expired}
      >
        <Select
          label="Ambiente de trabalho"
          fullWidth
          value={target}
          placeholder="Escolha um ambiente de trabalho"
          onChange={(e) => setTarget(e.target.value)}
          options={workspaces.items
            .filter((w) => w.status === 'active' && !(pending?.kind === 'authorize' && pending.worker.workspaceIds?.includes(w.workspaceId)))
            .map((w) => ({ value: w.workspaceId, label: w.name }))}
        />
        <Text variant="body-sm" color="secondary">
          Autorizar a máquina no ambiente não executa nada: a automação passa a executar e ser monitorada nele quando quem administra a organização a ativa para esta máquina, em Licenças e automações.
        </Text>
      </StepUpDialog>

      <StepUpDialog
        open={pending?.kind === 'remove'}
        title={pending?.kind === 'remove' ? `Retirar ${pending.worker.name} de ${wsName(pending.workspaceId)}?` : ''}
        guard={{ operation: 'worker.remove', target: pending?.kind === 'remove' ? `${pending.worker.workerId}|${pending.workspaceId}` : undefined }}
        confirmLabel="Retirar"
        tone="danger"
        action={() => (pending?.kind === 'remove' ? revokeWorkerInWorkspace(org, pending.worker.workerId!, pending.workspaceId) : Promise.reject())}
        onDone={() => done('Máquina retirada do ambiente de trabalho. As autorizações de execução local dele ali deixam de ser entregues ao Agent.')}
        onClose={() => setPending(null)}
        refusalText={(e) => accessRefusal(e)}
        uncertainText="Não foi possível confirmar a retirada. Feche e confira a lista."
        onUnauthenticated={expired}
      >
        <Text>As autorizações de execução local desta máquina no ambiente de trabalho deixam de ser entregues ao Agent. Uma máquina desconectada só percebe na próxima conexão.</Text>
      </StepUpDialog>
    </Stack>
  );
}

/**
 * PLATFORM-AGENT-V2-002 R1 — quem administra Workers (`worker.manage`) vê a tela completa. Quem administra só Agents
 * (`agent.manage`, sem `worker.manage`) vê as máquinas vinculadas, com as ações que já tinha na antiga tela de Agents.
 * Enquanto as permissões carregam, nada é pedido. Se falharem, a tela completa tenta a lista e a API decide; o aviso de
 * permissões não carregadas, com nova tentativa, fica no topo da área (InternalShell).
 */
export function WorkersPage() {
  const { permissions } = useInternalArea();
  const has = (p: string) => permissions.status === 'ready' && (permissions.data.organization.permissions as string[]).includes(p);
  // a visão depende das permissões: nenhuma lista é pedida antes delas
  if (permissions.status === 'loading') return <StateView status="loading" title="Carregando as máquinas…" />;
  if (permissions.status === 'ready' && !has('worker.manage') && has('agent.manage')) {
    return (
      <Stack gap={5}>
        <PageHeader title="Máquinas" subtitle="Computadores vinculados às máquinas desta organização." />
        <LinkedAgentsView has={has} />
      </Stack>
    );
  }
  return <WorkersManagement />;
}
