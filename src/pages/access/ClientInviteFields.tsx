import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Fieldset, Select, Text } from 'nekkora-lib';
import { listClients } from '../../api/admin';
import { listClientShareOptions, type ClientRecord, type ClientShareOption } from '../../api/clientAccess';
import { ClientFormDialog, inviteSummary } from './clientShared';

/** O escopo do convite de Cliente, como o formulário o guarda. `workerId` vazio = todas as máquinas desta automação. */
export interface ClientInviteDraft {
  clientId: string;
  workspaceId: string;
  workerId: string;
  automationId: string;
  canReadLogs: boolean;
  canDownloadResults: boolean;
}

export const EMPTY_CLIENT_DRAFT: ClientInviteDraft = { clientId: '', workspaceId: '', workerId: '', automationId: '', canReadLogs: false, canDownloadResults: false };

export interface ClientInviteOptions {
  clients: ClientRecord[];
  automations: ClientShareOption[];
}

/** O que a confirmação mostra (nomes resolvidos das opções carregadas). */
export interface ClientInviteResolved {
  clientName: string;
  automationName: string;
  workspaceName: string;
  machineName: string | null;
}

export function resolveDraft(d: ClientInviteDraft, o: ClientInviteOptions): ClientInviteResolved | null {
  const a = o.automations.find((x) => x.automationId === d.automationId);
  const c = o.clients.find((x) => x.clientId === d.clientId);
  if (!a || !c) return null;
  const m = d.workerId ? a.machines.find((x) => x.workerId === d.workerId) : undefined;
  if (d.workerId && !m) return null;
  return { clientName: c.name, automationName: a.name, workspaceName: a.workspaceName, machineName: m?.name ?? null };
}

/**
 * PLATFORM-FLUXO-002 (070): campos do convite de Cliente. Ordem da missão: cliente (com cadastro em modal), ambiente de
 * trabalho, máquina (filtra as automações; "Todas as máquinas desta automação" explícito) e a automação, obrigatória. Registros
 * e resultados são permissões separadas, desligadas por padrão. O resumo aparece antes de enviar. O servidor confere tudo.
 */
export function ClientInviteFields({
  org,
  draft,
  onChange,
  errors,
  canCreateClient,
  onOptions,
  onUnauthenticated,
}: {
  org: string;
  draft: ClientInviteDraft;
  onChange: (d: ClientInviteDraft) => void;
  errors: { client?: string; automation?: string };
  canCreateClient: boolean;
  onOptions: (o: ClientInviteOptions) => void;
  onUnauthenticated: () => void;
}) {
  const [options, setOptions] = useState<ClientInviteOptions | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setLoadError(false);
    Promise.all([listClients(org, { status: ['active'], limit: 100 }), listClientShareOptions(org)])
      .then(([c, s]) => {
        if (!live) return;
        const o = { clients: c.items, automations: s.automations };
        setOptions(o);
        onOptions(o);
      })
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, reload]);

  const workspaces = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of options?.automations ?? []) seen.set(a.workspaceId, a.workspaceName);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [options]);
  const inWorkspace = (options?.automations ?? []).filter((a) => a.workspaceId === draft.workspaceId);
  const machines = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of inWorkspace) for (const m of a.machines) seen.set(m.workerId, m.name);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [inWorkspace]);
  const automations = inWorkspace.filter((a) => !draft.workerId || a.machines.some((m) => m.workerId === draft.workerId));
  const resolved = options ? resolveDraft(draft, options) : null;

  if (loadError)
    return (
      <Alert tone="warning">
        Não foi possível carregar clientes e automações.{' '}
        <Button size="sm" variant="ghost" onClick={() => setReload((n) => n + 1)}>
          Tentar de novo
        </Button>
      </Alert>
    );
  if (!options) return <Text color="secondary">Carregando clientes e automações…</Text>;

  return (
    <>
      <div className="pw-people__client-row">
        <Select
          label="Cliente"
          required
          fullWidth
          value={draft.clientId}
          placeholder={options.clients.length ? 'Escolha o cliente atendido' : 'Nenhum cliente ativo cadastrado'}
          onChange={(e) => onChange({ ...draft, clientId: e.target.value })}
          options={options.clients.map((c) => ({ value: c.clientId, label: c.name }))}
          error={errors.client}
        />
        {canCreateClient && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(true)}>
            Cadastrar cliente
          </Button>
        )}
      </div>
      <Select
        label="Ambiente de trabalho"
        required
        fullWidth
        value={draft.workspaceId}
        placeholder="Onde está a automação compartilhada"
        onChange={(e) => onChange({ ...draft, workspaceId: e.target.value, workerId: '', automationId: '' })}
        options={workspaces}
        hint={workspaces.length === 0 ? 'Nenhuma automação ativa em ambiente de trabalho ativo.' : undefined}
      />
      <Select
        label="Máquina"
        fullWidth
        value={draft.workerId}
        disabled={!draft.workspaceId}
        onChange={(e) => {
          const w = e.target.value;
          const keep = !w || automations.some((a) => a.automationId === draft.automationId && a.machines.some((m) => m.workerId === w));
          onChange({ ...draft, workerId: w, automationId: keep ? draft.automationId : '' });
        }}
        options={[{ value: '', label: 'Todas as máquinas desta automação' }, ...machines]}
        hint="Escolher uma máquina restringe o acompanhamento a ela e filtra as automações; não dá acesso às outras automações que ela executa."
      />
      <Select
        label="Automação"
        required
        fullWidth
        value={draft.automationId}
        disabled={!draft.workspaceId}
        placeholder={automations.length ? 'Escolha a automação compartilhada' : 'Nenhuma automação para este filtro'}
        onChange={(e) => onChange({ ...draft, automationId: e.target.value })}
        options={automations.map((a) => ({ value: a.automationId, label: a.name }))}
        error={errors.automation}
      />
      <Fieldset legend="Além das execuções, a pessoa pode" description="Cada acesso é concedido separadamente.">
        <Checkbox label="Consultar os registros" checked={draft.canReadLogs} onChange={(e) => onChange({ ...draft, canReadLogs: e.target.checked })} />
        <Checkbox
          label="Baixar os arquivos de resultado"
          checked={draft.canDownloadResults}
          onChange={(e) => onChange({ ...draft, canDownloadResults: e.target.checked })}
        />
      </Fieldset>
      {resolved && (
        <Alert tone="info" role="status">
          {inviteSummary(resolved.automationName, resolved.workspaceName, resolved.machineName)}
        </Alert>
      )}
      <details className="pw-people__details">
        <summary>O que o cliente pode e não pode fazer</summary>
        <Text variant="body-sm" color="secondary">
          Acompanha só esta automação: consulta as execuções e, se marcado, os registros e os resultados. Não cria nem altera nada,
          não solicita execuções, não vê outras automações do ambiente de trabalho nem outras atividades da máquina. O convite não
          consome licença nem autoriza execução na máquina. O acesso só começa quando a pessoa aceita com a identidade Nekkora do
          mesmo e-mail.
        </Text>
      </details>
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
    </>
  );
}
