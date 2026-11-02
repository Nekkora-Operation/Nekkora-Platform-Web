import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, Stack, StateView, Text } from 'nekkora-lib';
import { isApiError } from '../api/http';
import { listAutomations, listExecutions } from '../api/product';
import type { Automation, Execution, Workspace } from '../api/v1';
import { useInternalArea } from '../area/InternalShell';
import { useSession } from '../area/session';
import { useWorkspacePermissions } from '../area/useWorkspacePermissions';
import { orgPath } from '../auth/organization';
import { activationLabel } from '../identity/labels';
import { STATUS_LABEL, STATUS_TONE } from './executions/format';
import { DateTimeText, ResourceStatusBadge, RouteLink } from './product/shared';

/** Quantos workspaces a página inicial consulta para saber se já há automações (os primeiros da lista visível). */
export const HOME_WORKSPACES = 5;
const HOME_ITEMS = 5;

type Load<T> = { status: 'loading' } | { status: 'ready'; items: T[] } | { status: 'error' };

/**
 * Automações dos primeiros workspaces ATIVOS visíveis (até {@link HOME_WORKSPACES}, {@link HOME_ITEMS} de cada) e as
 * execuções recentes. Só leitura, pelos endpoints da lista (L03 e L04). Qualquer consulta que falhar marca `error`: a
 * tela diz que não carregou, nunca mostra zero.
 */
function useActivity(workspaces: Workspace[] | null) {
  const { org, expired } = useSession();
  const [automations, setAutomations] = useState<Load<Automation>>({ status: 'loading' });
  const [executions, setExecutions] = useState<Load<Execution>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const key = workspaces?.map((w) => w.workspaceId).join(',') ?? null;

  useEffect(() => {
    if (key === null) return;
    let alive = true;
    const ids = key ? key.split(',') : [];
    setAutomations({ status: 'loading' });
    setExecutions({ status: 'loading' });
    const fail = (e: unknown, set: (v: Load<never>) => void) => {
      if (!alive) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      set({ status: 'error' });
    };
    Promise.all(ids.map((id) => listAutomations(org, id, { limit: HOME_ITEMS })))
      .then((pages) => alive && setAutomations({ status: 'ready', items: pages.flatMap((p) => p.items) }))
      .catch((e) => fail(e, setAutomations));
    listExecutions(org, { limit: HOME_ITEMS })
      .then((p) => alive && setExecutions({ status: 'ready', items: p.items }))
      .catch((e) => fail(e, setExecutions));
    return () => {
      alive = false;
    };
  }, [org, key, attempt, expired]);

  return { automations, executions, retry: () => setAttempt((n) => n + 1) };
}

/** Estado de ativação (022): o que significa, o que impede e quem ativa. Ausente (API anterior ao campo): nada. */
export function ActivationNotice() {
  const { me } = useSession();
  const state = me.organizationActivationState;
  if (!state) return null;
  const a = activationLabel(state);
  if (state === 'ATIVADA') {
    return (
      <Text variant="body-sm" color="secondary" className="pw-start__activation">
        <Badge tone={a.tone} dot>
          {a.label}
        </Badge>{' '}
        A organização já pode registrar Workers e executar automações, dentro da capacidade definida pela operação da Nekkora.
      </Text>
    );
  }
  return (
    <Alert tone="warning" title="Organização aguardando ativação">
      <Stack gap={2}>
        <span>
          Enquanto isso, nenhum Worker pode ser registrado e nenhuma automação executa: a capacidade de execução desta
          organização ainda é zero.
        </span>
        <span>
          A ativação é feita pela operação da Nekkora, não por esta tela. Você já pode preparar pessoas, workspaces e
          automações; elas ficam prontas para quando a organização for ativada.
        </span>
      </Stack>
    </Alert>
  );
}

/** Card do próximo passo: um título, uma frase e (quando a pessoa pode) a ação. */
function StepCard({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card variant="outlined" padding="lg" className="pw-start__step">
      <Stack gap={3}>
        <Text variant="overline" color="secondary">
          Próximo passo
        </Text>
        <Text as="h2" variant="h4">
          {title}
        </Text>
        <Text color="secondary">{children}</Text>
        {action && <div>{action}</div>}
      </Stack>
    </Card>
  );
}

/** "Criar primeira automação" no primeiro workspace ativo, se a permissão EFETIVA nele (P01 ∪ P02) permitir. */
function FirstAutomationStep({ workspace }: { workspace: Workspace }) {
  const { org } = useSession();
  const navigate = useNavigate();
  const perms = useWorkspacePermissions(workspace.workspaceId);
  const canManage = perms.status === 'ready' && perms.has('automation.manage');
  return (
    <StepCard
      title={canManage ? 'Criar primeira automação' : 'Ainda não há automações'}
      action={
        canManage ? (
          <Button leftIcon="plus" onClick={() => navigate(orgPath.workspace(org, workspace.workspaceId), { state: { openCreate: true } })}>
            Criar primeira automação
          </Button>
        ) : (
          <RouteLink to={orgPath.workspace(org, workspace.workspaceId)}>Abrir o workspace {workspace.name}</RouteLink>
        )
      }
    >
      {canManage
        ? `Os seus workspaces ainda não têm automações. Comece pelo workspace ${workspace.name}.`
        : perms.status === 'loading'
          ? 'Os seus workspaces ainda não têm automações.'
          : 'Os seus workspaces ainda não têm automações. Quem administra o workspace pode cadastrar a primeira.'}
    </StepCard>
  );
}

function Activity({ automations, executions }: { automations: Automation[]; executions: Load<Execution> }) {
  const { org } = useSession();
  return (
    <div className="pw-start__activity">
      <Card variant="surface" padding="lg">
        <Stack gap={3}>
          <Text as="h2" variant="h4">
            Automações
          </Text>
          <ul className="pw-start__list" aria-label="Automações">
            {automations.slice(0, HOME_ITEMS).map((a) => (
              <li key={a.automationId}>
                <RouteLink to={orgPath.automation(org, a.automationId)}>{a.name}</RouteLink>
                <span className="pw-start__meta">
                  <ResourceStatusBadge status={a.status} />
                  {a.latestPublishedVersion ? `versão ${a.latestPublishedVersion.versionNumber} publicada` : 'nenhuma versão publicada'}
                </span>
              </li>
            ))}
          </ul>
          <RouteLink to={orgPath.workspaces(org)}>Ver workspaces</RouteLink>
        </Stack>
      </Card>
      <Card variant="surface" padding="lg">
        <Stack gap={3}>
          <Text as="h2" variant="h4">
            Execuções recentes
          </Text>
          {executions.status === 'loading' && <Text color="secondary">Carregando execuções…</Text>}
          {executions.status === 'error' && <Text color="secondary">Não foi possível carregar as execuções recentes.</Text>}
          {executions.status === 'ready' && executions.items.length === 0 && <Text color="secondary">Nenhuma execução ainda.</Text>}
          {executions.status === 'ready' && executions.items.length > 0 && (
            <ul className="pw-start__list" aria-label="Execuções recentes">
              {executions.items.map((e) => (
                <li key={e.executionId}>
                  <RouteLink to={orgPath.execution(org, e.executionId)}>{e.automation.name}</RouteLink>
                  <span className="pw-start__meta">
                    <Badge tone={STATUS_TONE[e.status]} size="sm">
                      {STATUS_LABEL[e.status]}
                    </Badge>
                    <DateTimeText iso={e.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <RouteLink to={orgPath.executions(org)}>Ver execuções</RouteLink>
        </Stack>
      </Card>
    </div>
  );
}

/**
 * Próximo passo da organização (PLATFORM-LOCAL-002), na ordem: sem workspace → "Criar primeiro workspace" (com
 * `workspace.lifecycle`); workspace sem automações → "Criar primeira automação" (com `automation.manage` efetivo); com
 * automações → automações e execuções recentes como a API informou. Só apresenta: cada ação é decidida pela API.
 */
export function NextStep() {
  const { org } = useSession();
  const navigate = useNavigate();
  const { permissions, workspaces, reloadWorkspaces } = useInternalArea();
  const loaded = workspaces.status === 'ready' ? workspaces.items : null;
  const active = loaded ? loaded.filter((w) => w.status === 'active').slice(0, HOME_WORKSPACES) : null;
  const activity = useActivity(active && active.length > 0 ? active : null);

  if (workspaces.status === 'loading') return <StateView status="loading" title="Carregando workspaces…" />;
  if (workspaces.status === 'error') {
    return (
      <Alert
        tone="warning"
        title="Não foi possível carregar os seus workspaces."
        action={
          <Button size="sm" variant="secondary" onClick={reloadWorkspaces}>
            Tentar novamente
          </Button>
        }
      >
        Sem essa lista, a página inicial não consegue indicar o próximo passo.
      </Alert>
    );
  }

  if (workspaces.items.length === 0) {
    const canCreate = permissions.status === 'ready' && permissions.data.organization.permissions.includes('workspace.lifecycle');
    return (
      <StepCard
        title={canCreate ? 'Criar primeiro workspace' : 'Nenhum workspace ainda'}
        action={
          canCreate ? (
            <Button leftIcon="plus" onClick={() => navigate(orgPath.workspaces(org), { state: { openCreate: true } })}>
              Criar primeiro workspace
            </Button>
          ) : undefined
        }
      >
        {canCreate
          ? 'Workspaces organizam as automações e quem tem acesso a elas. Crie o primeiro para começar.'
          : permissions.status === 'error'
            ? 'Nenhum workspace visível para você. Não foi possível carregar as suas permissões para indicar se você pode criar um.'
            : 'Nenhum workspace visível para você. Quem administra a organização pode criar um workspace ou dar acesso a um existente.'}
      </StepCard>
    );
  }

  if (!active || active.length === 0) {
    return (
      <StepCard title="Nenhum workspace ativo" action={<RouteLink to={orgPath.workspaces(org)}>Ver workspaces</RouteLink>}>
        Os workspaces visíveis para você estão suspensos ou arquivados.
      </StepCard>
    );
  }

  const { automations, executions, retry } = activity;
  if (automations.status === 'loading') return <StateView status="loading" title="Carregando automações…" />;
  if (automations.status === 'error') {
    return (
      <Alert
        tone="warning"
        title="Não foi possível carregar as automações."
        action={
          <Button size="sm" variant="secondary" onClick={retry}>
            Tentar novamente
          </Button>
        }
      >
        A lista de workspaces carregou, mas a de automações não.
      </Alert>
    );
  }
  if (automations.items.length === 0) return <FirstAutomationStep workspace={active[0]} />;
  return <Activity automations={automations.items} executions={executions} />;
}
