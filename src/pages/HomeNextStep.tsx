import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, Stack, StateView, Text } from 'nekkora-lib';
import { isApiError } from '../api/http';
import { listOrganizationAutomations } from '../api/product';
import type { Workspace } from '../api/v1';
import { useInternalArea } from '../area/InternalShell';
import { useSession } from '../area/session';
import { useWorkspacePermissions } from '../area/useWorkspacePermissions';
import { orgPath } from '../auth/organization';
import { activationLabel } from '../identity/labels';
import { RouteLink } from './product/shared';

/** Até quantos workspaces ativos a página inicial considera para o próximo passo (o primeiro recebe a ação). */
export const HOME_WORKSPACES = 5;

type Load = { status: 'loading' } | { status: 'ready'; any: boolean } | { status: 'error' };

/**
 * Já há alguma automação nos ambientes de trabalho visíveis? Só para decidir o próximo passo ("criar a primeira
 * automação"); a lista de automações da página é a do painel. Falha marca `error`, nunca zero.
 *
 * A1 (LICENCIAMENTO-002): UMA leitura (a lista da organização, um item, qualquer situação) no lugar de uma por workspace
 * (até cinco). A lista da organização cobre todos os ambientes com automation.read, não só os cinco primeiros ativos: uma
 * automação em outro ambiente visível também conta como "já há automações". A leitura é refeita quando a lista de
 * workspaces muda (inclusive ao trocar de organização, que remonta a área).
 */
function useActivity(workspaces: Workspace[] | null) {
  const { org, expired } = useSession();
  const [automations, setAutomations] = useState<Load>({ status: 'loading' });
  const key = workspaces?.map((w) => w.workspaceId).join(',') ?? null;

  useEffect(() => {
    if (key === null) return;
    let alive = true;
    setAutomations({ status: 'loading' });
    listOrganizationAutomations(org, { limit: 1 })
      .then((page) => alive && setAutomations({ status: 'ready', any: page.items.length > 0 }))
      .catch((e: unknown) => {
        if (!alive) return;
        if (isApiError(e, 'unauthenticated')) return expired();
        setAutomations({ status: 'error' });
      });
    return () => {
      alive = false;
    };
  }, [org, key, expired]);

  return { automations };
}

/**
 * Estado de ativação (022): o que significa, o que impede e quem ativa. Ausente (API anterior ao campo): nada. `onlyPending`
 * (Máquinas): só o aviso de "aguardando ativação", no modelo anterior; nada quando a organização já pode cadastrar máquinas.
 */
export function ActivationNotice({ onlyPending = false }: { onlyPending?: boolean } = {}) {
  const { me } = useSession();
  const state = me.organizationActivationState;
  if (!state) return null;
  if (onlyPending && (state === 'ATIVADA' || me.organizationLicenseModel === 'licensed')) return null;
  const a = activationLabel(state, me.organizationLicenseModel);
  if (me.organizationLicenseModel === 'licensed') {
    // modelo por licença: não há ativação a esperar. O aviso de "aguardando ativação" seria falso aqui
    return (
      <Text variant="body-sm" color="secondary" className="pw-start__activation">
        <Badge tone={a.tone} dot>
          {a.label}
        </Badge>{' '}
        {a.description}
      </Text>
    );
  }
  if (state === 'ATIVADA') {
    return (
      <Text variant="body-sm" color="secondary" className="pw-start__activation">
        <Badge tone={a.tone} dot>
          {a.label}
        </Badge>{' '}
        A organização já pode registrar máquinas e executar automações, dentro da capacidade definida pela operação da Nekkora.
      </Text>
    );
  }
  return (
    <Alert tone="warning" title="Organização aguardando ativação">
      <Stack gap={2}>
        <span>
          Enquanto isso, nenhuma máquina pode ser registrada e nenhuma automação executa: a capacidade de execução desta
          organização ainda é zero.
        </span>
        <span>
          A ativação é feita pela operação da Nekkora, não por esta tela. Você já pode preparar pessoas, ambientes de trabalho e
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
          <RouteLink to={orgPath.workspace(org, workspace.workspaceId)}>Abrir o ambiente de trabalho {workspace.name}</RouteLink>
        )
      }
    >
      {canManage
        ? `Os seus ambientes de trabalho ainda não têm automações. Comece pelo ambiente de trabalho ${workspace.name}.`
        : perms.status === 'loading'
          ? 'Os seus ambientes de trabalho ainda não têm automações.'
          : perms.status === 'unknown'
            ? // R1: falha ao conferir (429, rede) não é falta de permissão
              `Os seus ambientes de trabalho ainda não têm automações. Não foi possível verificar suas permissões no ambiente de trabalho ${workspace.name} agora; tente de novo.`
            : 'Os seus ambientes de trabalho ainda não têm automações. Quem administra o ambiente de trabalho pode cadastrar a primeira.'}
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

  if (workspaces.status === 'loading') return <StateView status="loading" title="Carregando ambientes de trabalho…" />;
  if (workspaces.status === 'error') {
    return (
      <Alert
        tone="warning"
        title="Não foi possível carregar os seus ambientes de trabalho."
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
        title={canCreate ? 'Criar primeiro ambiente de trabalho' : 'Nenhum ambiente de trabalho ainda'}
        action={
          canCreate ? (
            <Button leftIcon="plus" onClick={() => navigate(orgPath.workspaces(org), { state: { openCreate: true } })}>
              Criar primeiro ambiente de trabalho
            </Button>
          ) : undefined
        }
      >
        {canCreate
          ? 'Ambientes de trabalho organizam as automações e quem tem acesso a elas. Crie o primeiro para começar.'
          : permissions.status === 'error'
            ? 'Nenhum ambiente de trabalho visível para você. Não foi possível carregar as suas permissões para indicar se você pode criar um.'
            : 'Nenhum ambiente de trabalho visível para você. Quem administra a organização pode criar um ambiente de trabalho ou dar acesso a um existente.'}
      </StepCard>
    );
  }

  if (!active || active.length === 0) {
    return (
      <StepCard title="Nenhum ambiente de trabalho ativo" action={<RouteLink to={orgPath.workspaces(org)}>Ver ambientes de trabalho</RouteLink>}>
        Os ambientes de trabalho visíveis para você estão suspensos ou arquivados.
      </StepCard>
    );
  }

  // carregando ou com falha: quem informa é a seção de automações do painel (uma mensagem só, não duas)
  const { automations } = activity;
  if (automations.status !== 'ready') return null;
  if (!automations.any) return <FirstAutomationStep workspace={active[0]} />;
  // já há automações: o painel (métricas e cards) é o conteúdo da página
  return null;
}
