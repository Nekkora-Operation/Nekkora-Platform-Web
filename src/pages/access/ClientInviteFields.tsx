import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Fieldset, Select, Text } from 'nekkora-lib';
import { listClients } from '../../api/admin';
import { listClientShareOptions, type ClientRecord, type ClientShareOption } from '../../api/clientAccess';
import { CLIENT_SEES, ClientFormDialog, inviteSummary } from './clientShared';

/**
 * O compartilhamento como o formulário o guarda (071). `workerId` vazio = todas as máquinas desta automação; `clientId` vazio = o
 * cliente interno é criado (ou reutilizado) pelo servidor com o nome da pessoa, sem etapa para quem compartilha.
 */
export interface ClientInviteDraft {
  name: string;
  workspaceId: string;
  automationId: string;
  workerId: string;
  canViewDashboard: boolean;
  canDownloadResults: boolean;
  clientId: string;
}

export const EMPTY_CLIENT_DRAFT: ClientInviteDraft = {
  name: '',
  workspaceId: '',
  automationId: '',
  workerId: '',
  canViewDashboard: true,
  canDownloadResults: false,
  clientId: '',
};

export interface ClientInviteOptions {
  mode: 'invite' | 'request';
  clients: ClientRecord[];
  automations: ClientShareOption[];
}

/** O que a confirmação mostra (nomes resolvidos das opções carregadas). */
export interface ClientInviteResolved {
  clientName: string | null;
  automationName: string;
  workspaceName: string;
  machineName: string | null;
}

export function resolveDraft(d: ClientInviteDraft, o: ClientInviteOptions): ClientInviteResolved | null {
  const a = o.automations.find((x) => x.automationId === d.automationId);
  if (!a) return null;
  const c = d.clientId ? o.clients.find((x) => x.clientId === d.clientId) : undefined;
  if (d.clientId && !c) return null;
  const m = d.workerId ? a.machines.find((x) => x.workerId === d.workerId) : undefined;
  if (d.workerId && !m) return null;
  return { clientName: c?.name ?? null, automationName: a.name, workspaceName: a.workspaceName, machineName: m?.name ?? null };
}

/** Problemas do rascunho, na ordem da tela. */
export function draftErrors(d: ClientInviteDraft): { name?: string; automation?: string; content?: string } {
  const name = d.name.trim();
  return {
    name: !name ? 'Informe o nome da pessoa.' : [...name].length > 200 ? 'Use no máximo 200 caracteres.' : undefined,
    automation: d.automationId ? undefined : 'Escolha a automação compartilhada.',
    content: d.canViewDashboard || d.canDownloadResults ? undefined : 'Escolha ao menos um conteúdo.',
  };
}

/**
 * PLATFORM-FLUXO-002 (070/071): o que se compartilha com uma pessoa de fora. Ambiente de trabalho (filtra), automação
 * (obrigatória) e os conteúdos — dashboard de execução e arquivos de retorno; relatórios personalizados ainda não existem. Em
 * "Opções adicionais" (recolhido): a máquina (restringe e filtra as automações) e, para quem administra, um cliente cadastrado
 * (opcional). Membro com client_share.request (modo pedido) só vê as automações dos ambientes dele e só os conteúdos que ele
 * mesmo pode ver. O servidor confere tudo de novo.
 */
export function ClientInviteFields({
  org,
  draft,
  onChange,
  errors,
  onOptions,
  onUnauthenticated,
  lockAutomationId,
}: {
  org: string;
  draft: ClientInviteDraft;
  onChange: (d: ClientInviteDraft) => void;
  errors: { automation?: string; content?: string };
  onOptions: (o: ClientInviteOptions) => void;
  onUnauthenticated: () => void;
  /** Compartilhar a partir da página da automação: ela já vem escolhida. */
  lockAutomationId?: string;
}) {
  const [options, setOptions] = useState<ClientInviteOptions | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  // o rascunho mais recente: as opções chegam depois, e a pessoa pode já ter digitado (nome, e-mail) nesse meio-tempo
  const latest = useRef(draft);
  latest.current = draft;

  useEffect(() => {
    let live = true;
    setLoadError(false);
    listClientShareOptions(org)
      .then(async (s) => {
        const clients = s.mode === 'invite' ? (await listClients(org, { status: ['active'], limit: 100 })).items : [];
        if (!live) return;
        const o: ClientInviteOptions = { mode: s.mode, clients, automations: s.automations };
        setOptions(o);
        onOptions(o);
        if (lockAutomationId) {
          const a = s.automations.find((x) => x.automationId === lockAutomationId);
          if (a)
            onChange({
              ...latest.current,
              workspaceId: a.workspaceId,
              automationId: a.automationId,
              canViewDashboard: a.canShareDashboard,
              canDownloadResults: false,
            });
        }
      })
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, reload, lockAutomationId]);

  const workspaces = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of options?.automations ?? []) seen.set(a.workspaceId, a.workspaceName);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [options]);
  const inWorkspace = (options?.automations ?? []).filter((a) => a.workspaceId === draft.workspaceId);
  const automations = inWorkspace.filter((a) => !draft.workerId || a.machines.some((m) => m.workerId === draft.workerId));
  const chosen = inWorkspace.find((a) => a.automationId === draft.automationId);
  const machines = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of chosen ? [chosen] : inWorkspace) for (const m of a.machines) seen.set(m.workerId, m.name);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [inWorkspace, chosen]);
  const resolved = options ? resolveDraft(draft, options) : null;
  const canDashboard = !chosen || chosen.canShareDashboard;
  const canFiles = !chosen || chosen.canShareFiles;

  if (loadError)
    return (
      <Alert tone="warning">
        Não foi possível carregar as automações que você pode compartilhar.{' '}
        <Button size="sm" variant="ghost" onClick={() => setReload((n) => n + 1)}>
          Tentar de novo
        </Button>
      </Alert>
    );
  if (!options) return <Text color="secondary">Carregando automações…</Text>;

  const pick = (automationId: string) => {
    const a = inWorkspace.find((x) => x.automationId === automationId);
    onChange({
      ...draft,
      automationId,
      canViewDashboard: a ? draft.canViewDashboard && a.canShareDashboard : draft.canViewDashboard,
      canDownloadResults: a ? draft.canDownloadResults && a.canShareFiles : draft.canDownloadResults,
    });
  };

  return (
    <>
      {!lockAutomationId && (
        <>
          <Select
            label="Ambiente de trabalho"
            required
            fullWidth
            value={draft.workspaceId}
            placeholder="Onde está a automação"
            onChange={(e) => onChange({ ...draft, workspaceId: e.target.value, workerId: '', automationId: '' })}
            options={workspaces}
            hint={workspaces.length === 0 ? 'Nenhuma automação ativa que você possa compartilhar.' : 'Só delimita o compartilhamento; a pessoa não vê o ambiente de trabalho.'}
          />
          <Select
            label="Automação"
            required
            fullWidth
            value={draft.automationId}
            disabled={!draft.workspaceId}
            placeholder={automations.length ? 'Escolha a automação compartilhada' : 'Nenhuma automação para este filtro'}
            onChange={(e) => pick(e.target.value)}
            options={automations.map((a) => ({ value: a.automationId, label: a.name }))}
            error={errors.automation}
          />
        </>
      )}
      <Fieldset legend="O que a pessoa poderá ver" description="Cada conteúdo é escolhido separadamente. Registros técnicos não são compartilhados.">
        <Checkbox
          label="Dashboard de execução"
          hint={canDashboard ? 'Indicadores e o estado de cada execução, em linguagem simples.' : undefined}
          checked={draft.canViewDashboard}
          disabled={!canDashboard}
          onChange={(e) => onChange({ ...draft, canViewDashboard: e.target.checked })}
        />
        <Checkbox
          label="Arquivos de retorno"
          hint={canFiles ? 'Ver e baixar os resultados, identificados pela automação e pela data da execução.' : undefined}
          checked={draft.canDownloadResults}
          disabled={!canFiles}
          onChange={(e) => onChange({ ...draft, canDownloadResults: e.target.checked })}
        />
        {(!canDashboard || !canFiles) && (
          <Text variant="body-sm" color="secondary">
            Você só pode compartilhar o que você mesmo pode ver nesta automação.
          </Text>
        )}
        <Text variant="body-sm" color="secondary">
          Relatórios personalizados: ainda não disponíveis.
        </Text>
        {errors.content && (
          <Text variant="body-sm" color="danger" role="alert">
            {errors.content}
          </Text>
        )}
      </Fieldset>
      <details className="pw-people__details">
        <summary>Opções adicionais</summary>
        <div className="pw-people__details-body">
          <Select
            label="Máquina"
            fullWidth
            value={draft.workerId}
            disabled={!draft.workspaceId}
            onChange={(e) => {
              const w = e.target.value;
              const keep = !w || automations.some((a) => a.automationId === draft.automationId && a.machines.some((m) => m.workerId === w));
              onChange({ ...draft, workerId: w, automationId: keep || lockAutomationId ? draft.automationId : '' });
            }}
            options={[{ value: '', label: 'Todas as máquinas desta automação' }, ...machines]}
            hint="Restringe o que a pessoa vê às execuções desta máquina. A pessoa não vê o nome da máquina nem as outras automações que ela executa."
          />
          {options.mode === 'invite' && (
            <div className="pw-people__client-row">
              <Select
                label="Cliente cadastrado (opcional)"
                fullWidth
                value={draft.clientId}
                onChange={(e) => onChange({ ...draft, clientId: e.target.value })}
                options={[{ value: '', label: 'Nenhum: criar com o nome da pessoa' }, ...options.clients.map((c) => ({ value: c.clientId, label: c.name }))]}
                hint="Só organiza o cadastro interno; não dá acesso a nada por si."
              />
              <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(true)}>
                Cadastrar cliente
              </Button>
            </div>
          )}
        </div>
      </details>
      {resolved && (
        <Alert tone="info" role="status">
          {inviteSummary(resolved.automationName, resolved.workspaceName, resolved.machineName, draft.name.trim() || undefined)}
        </Alert>
      )}
      <details className="pw-people__details">
        <summary>O que a pessoa pode e não pode fazer</summary>
        <Text variant="body-sm" color="secondary">
          {CLIENT_SEES}
        </Text>
      </details>
      {options.mode === 'invite' && (
        <ClientFormDialog
          org={org}
          open={creating}
          client={null}
          onClose={() => setCreating(false)}
          onSaved={(c) => {
            setCreating(false);
            const o = { ...options, clients: [...options.clients, c].sort((x, y) => x.name.localeCompare(y.name)) };
            setOptions(o);
            onOptions(o);
            onChange({ ...draft, clientId: c.clientId });
          }}
          onUnauthenticated={onUnauthenticated}
        />
      )}
    </>
  );
}
