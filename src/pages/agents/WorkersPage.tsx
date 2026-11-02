import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Select, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { authorizeWorkerInWorkspace, listWorkers, revokeWorkerInWorkspace, type Worker } from '../../api/agents';
import { isApiError } from '../../api/http';
import { useInternalArea } from '../../area/InternalShell';
import { useSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, orgStepUp } from '../access/shared';
import { ForbiddenState } from '../admin/shared';
import { LoadErrorState, PageHeader } from '../product/shared';

const STATUS: Record<NonNullable<Worker['status']>, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  ACTIVE: { label: 'Ativo', tone: 'success' },
  SUSPENDED: { label: 'Suspenso', tone: 'warning' },
  RETIRED: { label: 'Aposentado', tone: 'neutral' },
};

type Pending = { kind: 'authorize'; worker: Worker } | { kind: 'remove'; worker: Worker; workspaceId: string };

/**
 * /o/{org}/workers — Workers (worker.manage). A situação do Worker (ACTIVE/SUSPENDED/RETIRED) não é a conexão do Agent.
 * Não há rota para criar Worker sozinho: ele nasce no pedido de código de pareamento (tela de Agents).
 */
export function WorkersPage() {
  const { org, expired } = useSession();
  const { workspaces } = useInternalArea();
  const [list, setList] = useState<{ status: 'loading' } | { status: 'ready'; items: Worker[] } | { status: 'error'; error: unknown }>({ status: 'loading' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [target, setTarget] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
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

  if (list.status === 'error' && isApiError(list.error, 'forbidden')) return <ForbiddenState area="os Workers" onRetry={() => void load()} />;

  const wsName = (id: string) => workspaces.items.find((w) => w.workspaceId === id)?.name ?? `Workspace ${id.slice(0, 8)}…`;
  const columns: TableColumn<Worker>[] = [
    { key: 'nome', header: 'Worker', render: (w) => <span className="pw-break">{w.name}</span> },
    { key: 'situacao', header: 'Situação', render: (w) => (w.status ? <Badge tone={STATUS[w.status].tone}>{STATUS[w.status].label}</Badge> : '—') },
    { key: 'agent', header: 'Agent', render: (w) => (w.agentId ? 'Associado' : 'Sem Agent') },
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
      render: (w) =>
        w.status === 'ACTIVE' ? (
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
        ) : null,
    },
  ];

  const done = (text: string) => {
    setPending(null);
    setNotice({ tone: 'success', text });
    void load();
  };

  return (
    <Stack gap={5}>
      <PageHeader title="Workers" subtitle="Onde as automações podem rodar. Um Worker recebe autorizações só nos workspaces em que está autorizado." onRefresh={() => void load()} />
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {list.status === 'loading' && <StateView status="loading" title="Carregando Workers…" />}
      {list.status === 'error' && <LoadErrorState error={list.error} onRetry={() => void load()} />}
      {list.status === 'ready' &&
        (list.items.length === 0 ? (
          <StateView status="neutral" title="Nenhum Worker registrado." description="O Worker é criado junto com o código de pareamento, na tela de Agents (com a organização ativada)." />
        ) : (
          <div className="pw-prod__scroll" role="region" aria-label="Lista de Workers" tabIndex={0}>
            <Table columns={columns} data={list.items} rowKey="workerId" size="sm" caption="Workers da organização." />
          </div>
        ))}

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
