import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Input, Select, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { authorizeWorkerInWorkspace, cancelAgentCode, createWorker, listWorkers, revokeWorkerInWorkspace, type AgentCode, type Worker } from '../../api/agents';
import { hasReason, isApiError } from '../../api/http';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, orgStepUp } from '../access/shared';
import { ForbiddenState } from '../admin/shared';
import { DateTimeText, LoadErrorState, PageHeader } from '../product/shared';
import { OneTimeCode, PairAgentDialog, RevokeLinkDialog, RotateCredentialDialog, type FreeWorker, type LinkedAgent } from './agentDialogs';
import { LinkedAgentsView } from './linkedAgents';

const STATUS: Record<NonNullable<Worker['status']>, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  ACTIVE: { label: 'Ativo', tone: 'success' },
  SUSPENDED: { label: 'Suspenso', tone: 'warning' },
  RETIRED: { label: 'Aposentado', tone: 'neutral' },
};

const AGENT_STATUS: Record<NonNullable<Worker['agentStatus']>, { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' }> = {
  PENDING: { label: 'Agent pendente', tone: 'neutral' },
  ACTIVE: { label: 'Agent ativo', tone: 'success' },
  SUSPENDED: { label: 'Agent suspenso', tone: 'warning' },
  REVOKED: { label: 'Agent revogado', tone: 'danger' },
};

/** Texto da recusa por capacidade (409 worker_limit_reached). */
export const WORKER_LIMIT_TEXT =
  'A organização atingiu o limite de Workers. Enquanto ela aguarda ativação, o limite é zero; depois da ativação, ele é definido pela Nekkora. Nada foi criado.';

type Pending = { kind: 'authorize'; worker: Worker } | { kind: 'remove'; worker: Worker; workspaceId: string };

/**
 * /o/{org}/workers — Workers (worker.manage), entrada única do fluxo de execução local (PLATFORM-AGENT-V2-002, T07):
 * criar o Worker (sem Agent, sem código, sem execução), autorizá-lo em workspaces, vincular o Agent da máquina e
 * gerenciar o vínculo (renovar a credencial, revogar). Três dimensões separadas: a situação do Worker, a máquina
 * vinculada (só quando a lista do servidor a traz, depois do resgate do código) e a comunicação (último sinal).
 */
function WorkersManagement() {
  const { org, expired } = useSession();
  const { workspaces, permissions } = useInternalArea();
  const has = (p: string) => permissions.status === 'ready' && (permissions.data.organization.permissions as string[]).includes(p);
  const [list, setList] = useState<{ status: 'loading' } | { status: 'ready'; items: Worker[] } | { status: 'error'; error: unknown }>({ status: 'loading' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [target, setTarget] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [pairing, setPairing] = useState<FreeWorker | null>(null);
  const [rotating, setRotating] = useState<LinkedAgent | null>(null);
  const [revoking, setRevoking] = useState<LinkedAgent | null>(null);
  const [code, setCode] = useState<{ code: AgentCode; purpose: string } | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setList({ status: 'loading' });
    try {
      const data = await listWorkers(org);
      if (gen === generation.current) setList({ status: 'ready', items: data.items });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setList({ status: 'error', error: e });
    }
  }, [org, expired]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  // o código sai da memória ao sair da tela
  useEffect(() => () => setCode(null), []);

  if (list.status === 'error' && isApiError(list.error, 'forbidden')) return <ForbiddenState area="os Workers" onRetry={() => void load()} />;

  const wsName = (id: string) => workspaces.items.find((w) => w.workspaceId === id)?.name ?? `Workspace ${id.slice(0, 8)}…`;
  const canCreate = has('worker.manage');
  // pareamento: a API exige agent.manage, agent_credential.manage e worker_agent.assign
  const canPair = has('agent.manage') && has('agent_credential.manage') && has('worker_agent.assign');
  const canRotate = has('agent_credential.manage');
  const canRevoke = has('agent.manage');
  const machineName = (w: Worker) => w.agentName ?? `Agent ${w.agentId!.slice(0, 8)}…`;
  const linked = (w: Worker): LinkedAgent => ({ agentId: w.agentId!, name: machineName(w), workerName: w.name ?? '' });
  const columns: TableColumn<Worker>[] = [
    { key: 'nome', header: 'Worker', render: (w) => <span className="pw-break">{w.name}</span> },
    { key: 'situacao', header: 'Situação do Worker', render: (w) => (w.status ? <Badge tone={STATUS[w.status].tone}>{STATUS[w.status].label}</Badge> : '—') },
    {
      key: 'maquina',
      header: 'Máquina vinculada',
      render: (w) =>
        w.agentId ? (
          <Stack gap={1}>
            <span className="pw-break">{machineName(w)}</span>
            {w.agentStatus && (
              <span>
                <Badge tone={AGENT_STATUS[w.agentStatus].tone}>{AGENT_STATUS[w.agentStatus].label}</Badge>
              </span>
            )}
            <Text variant="body-sm" color="secondary">
              Versão do Agent: {w.agentVersion ?? 'não informada'}
            </Text>
            <Text variant="body-sm" color="secondary">
              Credencial vale até <DateTimeText iso={w.credentialExpiresAt} />
            </Text>
          </Stack>
        ) : (
          // ausência de vínculo, nunca falta de sinal
          'Sem Agent'
        ),
    },
    {
      key: 'comunicacao',
      header: 'Comunicação',
      render: (w) =>
        w.agentId ? (
          <Stack gap={1}>
            <span>
              <Badge tone={w.connectivity === 'CONNECTED' ? 'success' : 'neutral'} dot>
                {w.connectivity === 'CONNECTED' ? 'Conectada' : 'Sem comunicação'}
              </Badge>
            </span>
            <Text variant="body-sm" color="secondary">
              Último sinal: <DateTimeText iso={w.lastHeartbeatAt} empty="nunca" />
            </Text>
          </Stack>
        ) : (
          <span aria-label="Sem máquina vinculada">—</span>
        ),
    },
    {
      key: 'workspaces',
      header: 'Workspaces autorizados',
      render: (w) =>
        w.workspaceIds?.length ? (
          <ul className="pw-identity__orgs" aria-label={`Workspaces de ${w.name}`}>
            {w.workspaceIds.map((id) => (
              <li key={id} className="pw-form__row">
                <span>{wsName(id)}</span>
                <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'remove', worker: w, workspaceId: id })} aria-label={`Retirar ${w.name} de ${wsName(id)}`}>
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
      render: (w) => (
        <div className="pw-form__row">
          {w.status === 'ACTIVE' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setTarget('');
                setPending({ kind: 'authorize', worker: w });
              }}
              aria-label={`Autorizar ${w.name} num workspace`}
            >
              Autorizar em workspace
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
        title="Workers"
        subtitle="Onde as automações podem rodar. Um Worker recebe autorizações só nos workspaces em que está autorizado."
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
              Criar Worker
            </Button>
          ) : undefined
        }
      />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
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
      {list.status === 'loading' && <StateView status="loading" title="Carregando Workers…" />}
      {list.status === 'error' && <LoadErrorState error={list.error} onRetry={() => void load()} />}
      {list.status === 'ready' &&
        (list.items.length === 0 ? (
          <StateView
            status="neutral"
            title="Nenhum Worker criado."
            description="Use Criar Worker para registrar onde as automações vão rodar. Depois, autorize o Worker nos workspaces e vincule o Agent da máquina, na linha do Worker, na ordem que preferir."
          />
        ) : (
          <>
            <div className="pw-prod__scroll" role="region" aria-label="Lista de Workers" tabIndex={0}>
              <Table columns={columns} data={list.items} rowKey="workerId" size="sm" caption="Workers da organização." />
            </div>
            <Text variant="body-sm" color="secondary">
              Sem comunicação quer dizer que a Platform não recebe sinal da máquina há alguns minutos, não que ela foi desligada. A
              falta de sinal não revoga a credencial, não libera o Worker, não retira workspaces e não encerra execuções. Quando o
              sinal voltar, a máquina aparece conectada de novo, sem novo pareamento.
            </Text>
          </>
        ))}

      <StepUpDialog
        open={creating}
        title="Criar Worker"
        guard={{ operation: 'worker.create' }}
        confirmLabel="Criar Worker"
        ready={newName.trim().length > 0 && newName.trim().length <= 80}
        action={() => createWorker(org, newName.trim())}
        onDone={(w) => {
          setCreating(false);
          setNotice({ tone: 'success', text: `Worker ${w.name} criado, sem Agent. Autorize-o nos workspaces e vincule o Agent da máquina quando quiser.` });
          void load();
        }}
        onClose={() => setCreating(false)}
        refusalText={(e) => (hasReason(e, 'conflict', 'worker_limit_reached') ? WORKER_LIMIT_TEXT : accessRefusal(e))}
        uncertainText="Não foi possível confirmar se o Worker foi criado. Feche e confira a lista de Workers antes de criar de novo, para não registrar um Worker repetido."
        onUnauthenticated={expired}
      >
        <Input label="Nome do Worker" required fullWidth maxLength={80} value={newName} onChange={(e) => setNewName(e.target.value)} hint="De 1 a 80 caracteres." />
        <Text variant="body-sm" color="secondary">
          Criar o Worker não cria Agent, não emite código e não inicia execução. Depois, use Vincular Agent na linha do Worker.
        </Text>
      </StepUpDialog>

      <PairAgentDialog
        worker={pairing}
        onDone={(c) => {
          const w = pairing;
          setPairing(null);
          setCode({ code: c, purpose: `Código de pareamento para ${w?.name ?? 'o Worker'}` });
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
            text: `Vínculo revogado: o Worker ${a?.workerName ?? ''} está livre, com os workspaces e o histórico mantidos. A máquina precisa ser pareada de novo para voltar a executar. Isso não prova que um processo já em execução numa máquina desconectada parou.`,
          });
          void load();
        }}
        onClose={() => setRevoking(null)}
        onUncertain={() => setNotice({ tone: 'warning', text: 'O resultado da revogação não foi confirmado. Confira a lista.' })}
      />

      <StepUpDialog
        open={pending?.kind === 'authorize'}
        title={pending?.kind === 'authorize' ? `Autorizar ${pending.worker.name} num workspace` : ''}
        guard={{ operation: 'worker.authorize', target: pending?.kind === 'authorize' ? `${pending.worker.workerId}|${target}` : undefined }}
        confirmLabel="Autorizar"
        ready={!!target}
        stepUp={orgStepUp(org)}
        action={() => (pending?.kind === 'authorize' ? authorizeWorkerInWorkspace(org, pending.worker.workerId!, target) : Promise.reject())}
        onDone={(r) => done(r.created === false ? 'O Worker já estava autorizado neste workspace.' : 'Worker autorizado no workspace.')}
        onClose={() => setPending(null)}
        refusalText={(e) => accessRefusal(e, { conflict: 'O Worker ou o workspace não está ativo.' })}
        uncertainText="Não foi possível confirmar a autorização. Feche e confira a lista (repetir é idempotente)."
        onUnauthenticated={expired}
      >
        <Select
          label="Workspace"
          fullWidth
          value={target}
          placeholder="Escolha um workspace"
          onChange={(e) => setTarget(e.target.value)}
          options={workspaces.items
            .filter((w) => w.status === 'active' && !(pending?.kind === 'authorize' && pending.worker.workspaceIds?.includes(w.workspaceId)))
            .map((w) => ({ value: w.workspaceId, label: w.name }))}
        />
        <Text variant="body-sm" color="secondary">
          Autorizar o Worker não executa nada: é preciso também autorizar a execução local de uma versão publicada.
        </Text>
      </StepUpDialog>

      <StepUpDialog
        open={pending?.kind === 'remove'}
        title={pending?.kind === 'remove' ? `Retirar ${pending.worker.name} de ${wsName(pending.workspaceId)}?` : ''}
        guard={{ operation: 'worker.remove', target: pending?.kind === 'remove' ? `${pending.worker.workerId}|${pending.workspaceId}` : undefined }}
        confirmLabel="Retirar"
        tone="danger"
        action={() => (pending?.kind === 'remove' ? revokeWorkerInWorkspace(org, pending.worker.workerId!, pending.workspaceId) : Promise.reject())}
        onDone={() => done('Worker retirado do workspace. As autorizações de execução local dele ali deixam de ser entregues ao Agent.')}
        onClose={() => setPending(null)}
        refusalText={(e) => accessRefusal(e)}
        uncertainText="Não foi possível confirmar a retirada. Feche e confira a lista."
        onUnauthenticated={expired}
      >
        <Text>As autorizações de execução local deste Worker no workspace deixam de ser entregues ao Agent. Uma máquina desconectada só percebe na próxima conexão.</Text>
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
  if (permissions.status === 'loading') return <StateView status="loading" title="Carregando Workers…" />;
  if (permissions.status === 'ready' && !has('worker.manage') && has('agent.manage')) {
    return (
      <Stack gap={5}>
        <PageHeader title="Workers" subtitle="Máquinas vinculadas aos Workers desta organização." />
        <LinkedAgentsView has={has} />
      </Stack>
    );
  }
  return <WorkersManagement />;
}
