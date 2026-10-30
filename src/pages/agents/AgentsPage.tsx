import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Input, RadioGroup, Select, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { cancelAgentCode, createPairingCode, createRotationCode, listAgents, listWorkers, revokeAgent, type Agent, type AgentCode, type Worker } from '../../api/agents';
import { isApiError } from '../../api/http';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, orgStepUp } from '../access/shared';
import { ForbiddenState } from '../admin/shared';
import { DateTimeText, LoadErrorState, PageHeader } from '../product/shared';
import '../../identity/identity.css';
import './agents.css';

const STATUS: Record<NonNullable<Agent['status']>, { label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  PENDING: { label: 'Pendente', tone: 'neutral' },
  ACTIVE: { label: 'Ativo', tone: 'success' },
  SUSPENDED: { label: 'Suspenso', tone: 'warning' },
  REVOKED: { label: 'Revogado', tone: 'danger' },
};

/**
 * Código de uso único (pareamento ou rotação): exibido SÓ na resposta de criação, copiado por gesto explícito, com o
 * prazo visível. Sai da memória ao concluir ou sair da tela; a listagem nunca o devolve (não há recuperação).
 */
export function OneTimeCode({ code, onCancel, onDone }: { code: AgentCode; onCancel?: () => Promise<void>; onDone: () => void }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [now, setNow] = useState(Date.now());
  const [cancelState, setCancelState] = useState<'idle' | 'busy' | 'done' | string>('idle');
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((new Date(code.expiresAt).getTime() - now) / 1000));
  const expired = left === 0;

  return (
    <Card variant="outlined" padding="lg">
      <Stack gap={3}>
        <Alert tone="warning" title="Este código aparece só agora.">
          Use-o no Agent da máquina ({'"'}Parear com a Platform{'"'}). Ele é temporário e de uso único; ao sair desta tela ele não
          pode ser exibido de novo — se perder, cancele e gere outro.
        </Alert>
        <code className="pw-break pw-hash pw-code" aria-label="Código de uso único">
          {code.code}
        </code>
        <Text variant="body-sm" aria-live="off">
          {expired ? 'Prazo vencido: gere outro código.' : `Vale por mais ${Math.floor(left / 60)} min ${String(left % 60).padStart(2, '0')} s (até `}
          {!expired && (
            <>
              <DateTimeText iso={code.expiresAt} />)
            </>
          )}
        </Text>
        <div className="pw-form__row">
          <Button
            variant="secondary"
            leftIcon="copy"
            disabled={expired}
            onClick={() =>
              navigator.clipboard.writeText(code.code).then(
                () => setCopied('ok'),
                () => setCopied('fail'),
              )
            }
          >
            Copiar código
          </Button>
          {onCancel && cancelState !== 'done' && (
            <Button
              variant="ghost"
              loading={cancelState === 'busy'}
              onClick={() => {
                setCancelState('busy');
                onCancel().then(
                  () => setCancelState('done'),
                  (e) =>
                    setCancelState(
                      isApiError(e, 'conflict') ? 'O código já foi usado ou cancelado.' : 'Não foi possível confirmar o cancelamento. Confira a lista de Agents.',
                    ),
                );
              }}
            >
              Cancelar código
            </Button>
          )}
          <Button variant="ghost" onClick={onDone}>
            Concluir
          </Button>
        </div>
        {copied === 'ok' && <Text variant="body-sm">Copiado. Cole no Agent; não guarde o código em outro lugar.</Text>}
        {copied === 'fail' && <Text variant="body-sm">Não foi possível copiar automaticamente. Selecione o código e copie manualmente.</Text>}
        {cancelState === 'done' && <Alert tone="success">Código cancelado: ele não pode mais ser usado.</Alert>}
        {cancelState !== 'idle' && cancelState !== 'busy' && cancelState !== 'done' && <Alert tone="warning">{cancelState}</Alert>}
      </Stack>
    </Card>
  );
}

type Pending = { kind: 'pair' } | { kind: 'rotate'; agent: Agent } | { kind: 'revoke'; agent: Agent };

/**
 * /o/{org}/agents — Agents da organização (agent.manage). Situação do Agent (credencial) e conectividade (último sinal,
 * CONNECTED até 180 s) são dimensões diferentes, e nenhuma delas é a situação do Worker.
 */
export function AgentsPage() {
  const { org, expired } = useSession();
  const { permissions } = useInternalArea();
  const has = (p: string) => permissions.status === 'ready' && (permissions.data.organization.permissions as string[]).includes(p);
  const [list, setList] = useState<{ status: 'loading' } | { status: 'ready'; items: Agent[] } | { status: 'error'; error: unknown }>({ status: 'loading' });
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState<{ code: AgentCode; pairing: boolean } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [agentName, setAgentName] = useState('');
  const [workerMode, setWorkerMode] = useState<'new' | 'existing'>('new');
  const [workerName, setWorkerName] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [minutes, setMinutes] = useState('15');
  const [reason, setReason] = useState<'COMPROMISED' | 'ADMINISTRATIVE'>('ADMINISTRATIVE');
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    setList({ status: 'loading' });
    try {
      const data = await listAgents(org);
      if (gen === generation.current) setList({ status: 'ready', items: data.items });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setList({ status: 'error', error: e });
    }
    // Workers só para escolher no pareamento (worker.manage); falha aqui não esconde os Agents
    listWorkers(org).then(
      (w) => gen === generation.current && setWorkers(w.items),
      () => undefined,
    );
  }, [org, expired]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  // o código sai da memória ao sair da tela
  useEffect(() => () => setCode(null), []);

  if (list.status === 'error' && isApiError(list.error, 'forbidden')) return <ForbiddenState area="os Agents" onRetry={() => void load()} />;

  const workerOf = (id: string | null | undefined) => (id ? (workers.find((w) => w.workerId === id)?.name ?? `Worker ${id.slice(0, 8)}…`) : 'Sem Worker');
  const canCode = has('agent_credential.manage');
  const columns: TableColumn<Agent>[] = [
    { key: 'nome', header: 'Agent', render: (a) => <span className="pw-break">{a.name}</span> },
    { key: 'situacao', header: 'Situação', render: (a) => (a.status ? <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge> : '—') },
    {
      key: 'conexao',
      header: 'Conexão',
      render: (a) => (
        <Stack gap={1}>
          <Badge tone={a.connectivity === 'CONNECTED' ? 'success' : 'neutral'} dot>
            {a.connectivity === 'CONNECTED' ? 'Conectado' : 'Sem sinal recente'}
          </Badge>
          <Text variant="body-sm" color="secondary">
            Último sinal: <DateTimeText iso={a.lastHeartbeatAt} empty="nunca" />
          </Text>
        </Stack>
      ),
    },
    { key: 'worker', header: 'Worker', render: (a) => workerOf(a.workerId) },
    { key: 'versao', header: 'Versão', render: (a) => a.agentVersion ?? '—' },
    { key: 'credencial', header: 'Credencial vale até', render: (a) => <DateTimeText iso={a.credentialExpiresAt} /> },
    {
      key: 'acoes',
      header: 'Ações',
      render: (a) =>
        a.status === 'REVOKED' ? null : (
          <div className="pw-form__row">
            {canCode && (
              <Button size="sm" variant="secondary" onClick={() => setPending({ kind: 'rotate', agent: a })} aria-label={`Gerar código de rotação para ${a.name}`}>
                Rotacionar credencial
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setPending({ kind: 'revoke', agent: a })} aria-label={`Revogar ${a.name}`}>
              Revogar
            </Button>
          </div>
        ),
    },
  ];

  const pairReady =
    agentName.trim().length > 0 &&
    agentName.trim().length <= 80 &&
    (workerMode === 'existing' ? !!workerId : workerName.trim().length > 0 && workerName.trim().length <= 80) &&
    Number(minutes) >= 5 &&
    Number(minutes) <= 60;

  return (
    <Stack gap={5}>
      <PageHeader
        title="Agents"
        subtitle="Máquinas que executam automações localmente. A execução começa sempre no Agent, por confirmação da pessoa."
        onRefresh={() => void load()}
        actions={
          canCode ? (
            <Button size="sm" leftIcon="plus" onClick={() => setPending({ kind: 'pair' })}>
              Parear novo Agent
            </Button>
          ) : undefined
        }
      />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {code && (
        <OneTimeCode
          code={code.code}
          onCancel={code.pairing ? () => cancelAgentCode(org, code.code.enrollmentId) : undefined}
          onDone={() => {
            setCode(null);
            void load();
          }}
        />
      )}

      {list.status === 'loading' && <StateView status="loading" title="Carregando Agents…" />}
      {list.status === 'error' && <LoadErrorState error={list.error} onRetry={() => void load()} />}
      {list.status === 'ready' &&
        (list.items.length === 0 ? (
          <StateView status="neutral" title="Nenhum Agent pareado." description="Gere um código de pareamento e use-o no Agent instalado na máquina." />
        ) : (
          <div className="pw-prod__scroll" role="region" aria-label="Lista de Agents" tabIndex={0}>
            <Table columns={columns} data={list.items} rowKey="agentId" size="sm" caption="Agents da organização." />
          </div>
        ))}

      <StepUpDialog<AgentCode>
        open={pending?.kind === 'pair'}
        title="Gerar código de pareamento"
        guard={{ operation: 'agent.pairing-code' }}
        confirmLabel="Gerar código"
        ready={pairReady}
        stepUp={orgStepUp(org)}
        action={() =>
          createPairingCode(org, {
            agentName: agentName.trim(),
            ...(workerMode === 'existing' ? { workerId } : { workerName: workerName.trim() }),
            expiresInMinutes: Number(minutes),
          })
        }
        onDone={(c) => {
          setPending(null);
          setAgentName('');
          setWorkerName('');
          setCode({ code: c, pairing: true });
        }}
        onClose={() => setPending(null)}
        refusalText={(e) =>
          accessRefusal(e, {
            conflict: 'O Worker escolhido já tem um Agent ativo.',
            forbidden:
              'O código não foi gerado: faltam permissões (Agents, credenciais, Workers) ou a organização ainda não tem capacidade para registrar Workers (aguardando ativação).',
          })
        }
        uncertainText="Não foi possível confirmar se o código foi gerado. Feche: se foi, ele não pode ser exibido de novo e vence sozinho; gere outro."
        onUnauthenticated={expired}
      >
        <Input label="Nome da máquina" required fullWidth maxLength={80} value={agentName} onChange={(e) => setAgentName(e.target.value)} hint="Nome lógico informado por você; nada é coletado da máquina." />
        <RadioGroup
          legend="Worker"
          value={workerMode}
          onChange={(v) => setWorkerMode(v as 'new' | 'existing')}
          options={[
            { value: 'new', label: 'Criar um Worker novo' },
            { value: 'existing', label: 'Usar um Worker existente', disabled: workers.length === 0 },
          ]}
        />
        {workerMode === 'new' ? (
          <Input label="Nome do Worker" required fullWidth maxLength={80} value={workerName} onChange={(e) => setWorkerName(e.target.value)} />
        ) : (
          <Select
            label="Worker"
            fullWidth
            value={workerId}
            placeholder="Escolha um Worker"
            onChange={(e) => setWorkerId(e.target.value)}
            options={workers.filter((w) => w.status === 'ACTIVE' && !w.agentId).map((w) => ({ value: w.workerId!, label: w.name ?? w.workerId! }))}
          />
        )}
        <Input label="Validade do código (minutos)" type="number" min={5} max={60} value={minutes} onChange={(e) => setMinutes(e.target.value)} hint="De 5 a 60." />
      </StepUpDialog>

      <StepUpDialog<AgentCode>
        open={pending?.kind === 'rotate'}
        title={pending?.kind === 'rotate' ? `Gerar código de rotação para ${pending.agent.name}?` : ''}
        guard={{ operation: 'agent.rotation-code', target: pending?.kind === 'rotate' ? pending.agent.agentId : undefined }}
        confirmLabel="Gerar código"
        stepUp={orgStepUp(org)}
        action={() => (pending?.kind === 'rotate' ? createRotationCode(org, pending.agent.agentId!) : Promise.reject())}
        onDone={(c) => {
          setPending(null);
          setCode({ code: c, pairing: false });
        }}
        onClose={() => setPending(null)}
        refusalText={(e) => accessRefusal(e, { notFound: 'O Agent não existe mais ou não tem Worker associado.' })}
        uncertainText="Não foi possível confirmar se o código foi gerado. Feche e gere outro se precisar."
        onUnauthenticated={expired}
      >
        <Text>O Agent resgata o código apresentando a credencial atual; nesse momento a credencial anterior deixa de valer.</Text>
      </StepUpDialog>

      <StepUpDialog
        open={pending?.kind === 'revoke'}
        title={pending?.kind === 'revoke' ? `Revogar ${pending.agent.name}?` : ''}
        guard={{ operation: 'agent.revoke', target: pending?.kind === 'revoke' ? pending.agent.agentId : undefined }}
        confirmLabel="Revogar Agent"
        tone="danger"
        stepUp={orgStepUp(org)}
        action={() => (pending?.kind === 'revoke' ? revokeAgent(org, pending.agent.agentId!, reason) : Promise.reject())}
        onDone={() => {
          setPending(null);
          setNotice({
            tone: 'success',
            text: 'Agent revogado: a credencial caiu e o canal recusa a máquina. Isso não prova que um processo já em execução numa máquina desconectada parou.',
          });
          void load();
        }}
        onClose={() => setPending(null)}
        refusalText={(e) => accessRefusal(e, { conflict: 'O Agent já está revogado.' })}
        uncertainText="Não foi possível confirmar a revogação. Feche e confira a lista de Agents."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && setNotice({ tone: 'warning', text: 'O resultado da revogação não foi confirmado. Confira a lista.' })}
      >
        <Text>
          Credencial revogada, Worker desassociado e códigos abertos cancelados, no mesmo ato. A revogação não interrompe um
          processo que já esteja rodando numa máquina sem conexão.
        </Text>
        <RadioGroup
          legend="Motivo"
          value={reason}
          onChange={(v) => setReason(v as 'COMPROMISED' | 'ADMINISTRATIVE')}
          options={[
            { value: 'ADMINISTRATIVE', label: 'Administrativo (máquina desativada, troca de equipamento)' },
            { value: 'COMPROMISED', label: 'Suspeita de comprometimento' },
          ]}
        />
      </StepUpDialog>
    </Stack>
  );
}
