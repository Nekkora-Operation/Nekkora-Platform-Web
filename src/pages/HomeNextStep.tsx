import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, Stack, StateView, Text } from 'nekkora-lib';
import { isApiError } from '../api/http';
import { listAutomations } from '../api/product';
import type { Automation, Workspace } from '../api/v1';
import { useInternalArea } from '../area/InternalShell';
import { useSession } from '../area/session';
import { useWorkspacePermissions } from '../area/useWorkspacePermissions';
import { orgPath } from '../auth/organization';
import { activationLabel } from '../identity/labels';
import { RouteLink } from './product/shared';

/** Quantos workspaces a página inicial consulta para saber se já há automações (os primeiros da lista visível). */
export const HOME_WORKSPACES = 5;
const HOME_ITEMS = 5;

type Load<T> = { status: 'loading' } | { status: 'ready'; items: T[] } | { status: 'error' };

/**
 * Há automações nos primeiros workspaces ATIVOS visíveis (até {@link HOME_WORKSPACES})? Só para decidir o próximo passo
 * ("criar a primeira automação"); a lista de automações da página é a do painel. Falha marca `error`, nunca zero.
 */
function useActivity(workspaces: Workspace[] | null) {
  const { org, expired } = useSession();
  const [automations, setAutomations] = useState<Load<Automation>>({ status: 'loading' });
  const key = workspaces?.map((w) => w.workspaceId).join(',') ?? null;

  useEffect(() => {
    if (key === null) return;
    let alive = true;
    const ids = key ? key.split(',') : [];
    setAutomations({ status: 'loading' });
    const fail = (e: unknown, set: (v: Load<never>) => void) => {
      if (!alive) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      set({ status: 'error' });
    };
    Promise.all(ids.map((id) => listAutomations(org, id, { limit: HOME_ITEMS })))
      .then((pages) => alive && setAutomations({ status: 'ready', items: pages.flatMap((p) => p.items) }))
      .catch((e) => fail(e, setAutomations));
    return () => {
      alive = false;
    };
  }, [org, key, expired]);

  return { automations };
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
        ) : perms.status === 'unknown' ? (
          <Button variant="secondary" onClick={perms.retry}>
            Tentar novamente
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
          : perms.status === 'unknown'
            ? // R1: falha ao conferir (429, rede) não é falta de permissão
              `Os seus workspaces ainda não têm automações. Não foi possível verificar suas permissões no workspace ${workspace.name} agora; tente de novo.`
            : 'Os seus workspaces ainda não têm automações. Quem administra o workspace pode cadastrar a primeira.'}
    </StepCard>
  );
}

/**
 * Próximo passo da organização (PLATFORM-LOCAL-002), na ordem: sem workspace → "Criar primeiro workspace" (com
 * `workspace.lifecycle`); workspace sem automações → "Criar primeira automação" (com `automation.manage` efetivo); com
 * automações → nada (o painel do Início é o conteúdo). Só apresenta: cada ação é decidida pela API.
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

  // carregando ou com falha: quem informa é a seção de automações do painel (uma mensagem só, não duas)
  const { automations } = activity;
  if (automations.status !== 'ready') return null;
  if (automations.items.length === 0) return <FirstAutomationStep workspace={active[0]} />;
  // já há automações: o painel (métricas e cards) é o conteúdo da página
  return null;
}
