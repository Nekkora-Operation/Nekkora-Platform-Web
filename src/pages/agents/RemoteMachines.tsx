import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Heading, Stack, Table, Text, type TableColumn } from 'nekkora-lib';
import { listRemoteMachinePythonEnvironments, listRemoteMachines, type PythonEnvironment, type RemoteMachine } from '../../api/agents';
import { isApiError } from '../../api/http';
import { useSession } from '../../area/session';
import { DateTimeText, LoadErrorState } from '../product/shared';
import './agents.css';

/**
 * PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T01a — as máquinas HABILITADAS para execução remota deste workspace, com o estado
 * que a Platform conhece. O estado é indicativo: não reserva a máquina e não autoriza versão alguma (as autorizações de
 * workspace e de versão continuam valendo como hoje). Nesta entrega a tela só mostra; solicitar uma execução vem depois.
 *
 * Sem máquina habilitada, ou numa Platform sem o recurso (404), a seção não aparece: nada é anunciado antes de existir.
 */
export const REMOTE_STATE: Record<RemoteMachine['state'], { label: string; tone: 'success' | 'neutral' | 'warning'; detail: string }> = {
  AVAILABLE: { label: 'Disponível', tone: 'success', detail: 'Em contato e recebendo.' },
  BUSY: { label: 'Ocupada', tone: 'neutral', detail: 'A máquina informou uma execução em andamento.' },
  PAUSED: { label: 'Pausada', tone: 'warning', detail: 'O recebimento foi pausado na máquina.' },
  NO_DISK_SPACE: { label: 'Sem espaço em disco', tone: 'warning', detail: 'A máquina informou pouco espaço para preparar uma execução.' },
  INCOMPATIBLE: { label: 'Incompatível', tone: 'warning', detail: 'A versão do aplicativo nesta máquina não executa solicitações da Platform.' },
  OFFLINE: { label: 'Offline', tone: 'neutral', detail: 'Sem contato recente com a Platform.' },
};

type State = { status: 'loading' } | { status: 'ready'; items: RemoteMachine[] } | { status: 'absent' } | { status: 'error'; error: unknown };

const KIND: Record<PythonEnvironment['kind'], string> = { INSTALLATION: 'instalação', VIRTUAL_ENVIRONMENT: 'ambiente virtual' };

/**
 * T01c — as versões de Python que a máquina informou, pedidas só quando a pessoa clica. É o que a máquina disse: não
 * escolhe ambiente nem prova que uma automação roda nele. A Platform não recebe caminhos, e a tela não tem o que mostrar
 * além da versão e do tipo.
 */
function MachinePython({ workspaceId, machine }: { workspaceId: string; machine: RemoteMachine }) {
  const { org, expired } = useSession();
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'error' } | { status: 'ready'; items: PythonEnvironment[] }>({ status: 'idle' });
  const load = async () => {
    setState({ status: 'loading' });
    try {
      const data = await listRemoteMachinePythonEnvironments(org, workspaceId, machine.agentId);
      setState({ status: 'ready', items: data.items });
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      setState({ status: 'error' });
    }
  };
  if (state.status === 'ready')
    return state.items.length === 0 ? (
      <Text variant="body-sm" color="secondary">
        Esta máquina ainda não informou versões de Python, ou não encontrou nenhuma.
      </Text>
    ) : (
      <ul className="pw-plain-list" aria-label={`Versões de Python de ${machine.agentName}`}>
        {state.items.map((e) => (
          <li key={e.environmentId}>
            <Text variant="body-sm">
              Python {e.pythonVersion} ({KIND[e.kind]})
            </Text>
          </li>
        ))}
      </ul>
    );
  return (
    <Stack gap={1}>
      <span>
        <Button size="sm" variant="ghost" loading={state.status === 'loading'} onClick={() => void load()} aria-label={`Ver versões de Python de ${machine.agentName}`}>
          Ver versões
        </Button>
      </span>
      {state.status === 'error' && (
        <Text variant="body-sm" color="secondary">
          Não foi possível consultar. Tente de novo.
        </Text>
      )}
    </Stack>
  );
}

export function RemoteMachines({ workspaceId }: { workspaceId: string }) {
  const { org, expired } = useSession();
  const [list, setList] = useState<State>({ status: 'loading' });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const data = await listRemoteMachines(org, workspaceId);
      if (gen === generation.current) setList({ status: 'ready', items: data.items });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      // Platform sem o recurso, ou sem permissão neste workspace: não há o que mostrar
      setList(isApiError(e, 'not_found') ? { status: 'absent' } : { status: 'error', error: e });
    }
  }, [org, workspaceId, expired]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  if (list.status === 'loading' || list.status === 'absent') return null;
  if (list.status === 'ready' && list.items.length === 0) return null;

  const columns: TableColumn<RemoteMachine>[] = [
    {
      key: 'estado',
      header: 'Estado',
      render: (m) => (
        <Stack gap={1}>
          <span>
            <Badge tone={REMOTE_STATE[m.state].tone}>{REMOTE_STATE[m.state].label}</Badge>
          </span>
          <Text variant="body-sm" color="secondary">
            {REMOTE_STATE[m.state].detail}
          </Text>
        </Stack>
      ),
    },
    { key: 'worker', header: 'Worker', render: (m) => m.workerName },
    {
      key: 'maquina',
      header: 'Máquina',
      render: (m) => (
        <Stack gap={1}>
          <span>{m.agentName}</span>
          <Text variant="body-sm" color="secondary">
            Versão do aplicativo: {m.agentVersion}
          </Text>
        </Stack>
      ),
    },
    { key: 'python', header: 'Python informado', render: (m) => <MachinePython workspaceId={workspaceId} machine={m} /> },
    { key: 'contato', header: 'Último contato', render: (m) => <DateTimeText iso={m.lastHeartbeatAt ?? null} empty="nenhum" /> },
    { key: 'habilitada', header: 'Habilitada em', render: (m) => <DateTimeText iso={m.enabledAt} /> },
  ];

  return (
    <section className="pw-prod__section" aria-labelledby={`maquinas-remotas-${workspaceId}`}>
      <Heading level={2} id={`maquinas-remotas-${workspaceId}`} className="pw-prod__section-title">
        Máquinas habilitadas para execução remota
      </Heading>
      <Text variant="body-sm" color="secondary">
        O estado é o que a Platform conhece no momento da leitura e não reserva a máquina. Uma máquina habilitada não autoriza
        nenhuma automação: as autorizações deste ambiente de trabalho continuam valendo como estão.
      </Text>
      {list.status === 'error' && <LoadErrorState error={list.error} onRetry={() => void load()} />}
      {list.status === 'ready' && (
        <>
          <div className="pw-prod__scroll" role="region" aria-label="Lista de máquinas habilitadas para execução remota" tabIndex={0}>
            <Table columns={columns} data={list.items} rowKey="agentId" size="sm" caption="Máquinas habilitadas para execução remota neste ambiente de trabalho." />
          </div>
          <div>
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              Atualizar estado
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
