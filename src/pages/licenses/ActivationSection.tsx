import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Checkbox, Input, Select, Stack, StateView, Table, Text, type TableColumn } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import {
  acceptActivationVersion,
  activateAutomation,
  getActivationOptions,
  renewActivation,
  type ActivationPending,
  type ActivationResult,
  type ActivationState,
  type AutomationActivation,
  type AutomationActivationList,
  type AutomationActivationOptions,
  type AutomationActivationOutcome,
} from '../../api/activations';
import { listWorkspaces } from '../../api/product';
import type { Workspace } from '../../api/v1';
import { useSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, orgStepUp } from '../access/shared';
import { DateTimeText } from '../product/shared';
import { LICENSE_NOT_CONSUMED, MachineStateBadge, machineName } from '../agents/machine';

/**
 * PLATFORM-FLUXO-002 — "Licenças e automações": a ativação unificada. Um passo (Ativar automação) escolhe o ambiente de
 * trabalho, a automação e os Workers (nenhuma vem marcada), mostra a licença que será usada, a versão publicada atual e os
 * Workers escolhidos, e confirma "Ativar execução e monitoramento". "Gerenciar ativação" acrescenta Workers, aceita uma
 * versão nova e renova as autorizações depois da renovação da licença, sem consumir outra licença. A API decide tudo.
 */

export const STATE_TEXT: Record<ActivationState, { label: string; tone: 'success' | 'warning' | 'info' | 'neutral' }> = {
  ACTIVE: { label: 'Ativa', tone: 'success' },
  CONFIGURATION_PENDING: { label: 'Configuração pendente', tone: 'warning' },
  RENEWAL_AVAILABLE: { label: 'Renovar autorizações', tone: 'info' },
  LICENSE_REQUIRED: { label: 'Sem licença', tone: 'warning' },
  LICENSE_EXPIRED: { label: 'Licença vencida', tone: 'warning' },
};

export function pendingText(p: ActivationPending, a: AutomationActivation): string {
  switch (p) {
    case 'NO_WORKER':
      return 'Nenhuma máquina escolhida: escolha onde a automação vai executar e ser monitorada.';
    case 'NO_PUBLISHED_VERSION':
      return 'A automação ainda não tem versão publicada: a execução fica pendente até a publicação. O monitoramento já vale.';
    case 'WORKER_WITHOUT_EXECUTION':
      return 'Alguma máquina ainda não tem a execução da versão aceita.';
    case 'WORKER_WITHOUT_MONITORING':
      return 'Alguma máquina ainda não tem o monitoramento.';
    case 'NEW_VERSION_AVAILABLE':
      return `Há uma versão publicada mais nova (versão ${a.currentVersion?.number ?? '?'}). Ela só executa depois de aceita.`;
    case 'RENEWAL_AVAILABLE':
      return 'A licença foi renovada: renove as autorizações das máquinas para valerem até a nova data.';
    case 'LICENSE_EXPIRED':
      return 'A licença desta automação está vencida: a renovação é feita pelo suporte da Nekkora.';
    case 'LICENSE_REQUIRED':
      return 'Esta automação ainda não tem licença.';
    default:
      return p;
  }
}

const FAILURE_TEXT: Record<string, string> = {
  license_unavailable: 'não há licença disponível',
  license_required: 'a automação não tem licença',
  license_expired: 'a licença está vencida',
  local_run_authorization_exists: 'já existe uma autorização vigente',
  activation_automation_inactive: 'a automação ou o ambiente de trabalho não está ativo',
  conflict: 'a máquina, a versão ou o ambiente de trabalho mudou',
  permission: 'sem permissão',
  step_up: 'a confirmação reforçada expirou',
};

const ACT_REFUSAL: Record<string, string> = {
  license_unavailable: 'Não há licença disponível para esta automação. Nada foi vinculado nem autorizado.',
  activation_worker_not_in_workspace: 'Uma das máquinas escolhidas não está mais autorizada neste ambiente de trabalho. Nada foi vinculado nem autorizado.',
  activation_automation_inactive: 'A automação ou o ambiente de trabalho não está ativo. Nada foi feito.',
  activation_without_workers: 'Esta ativação ainda não tem máquina. Acrescente uma máquina antes de aceitar uma versão.',
  activation_renewal_not_applicable: 'Esta organização ainda não exige licença: as autorizações valem pela data escolhida.',
  license_expired: 'A licença desta automação está vencida. A renovação é feita pelo suporte da Nekkora. Nada foi feito.',
};

const refusal = (e: unknown) => {
  const reason = isApiError(e, 'conflict') ? (e as { reason?: string }).reason : undefined;
  return reason && ACT_REFUSAL[reason] ? ACT_REFUSAL[reason] : accessRefusal(e);
};

const kindText = (r: ActivationResult) => (r.kind === 'execution' ? 'execução' : 'monitoramento');

/** O que cada ato da ativação fez, com o que ficou pendente dito exatamente. */
export function OutcomeSummary({ outcome, workers }: { outcome: AutomationActivationOutcome; workers: Map<string, string> }) {
  const failed = outcome.results.filter((r) => r.outcome === 'failed');
  const issued = outcome.results.filter((r) => r.outcome === 'issued').length;
  const already = outcome.results.filter((r) => r.outcome === 'already').length;
  return (
    <Stack gap={2}>
      {outcome.licenseConsumedNow === true && <Text>Uma licença foi vinculada a esta automação.</Text>}
      {outcome.licenseConsumedNow === false && <Text>A automação já tinha licença: nenhuma outra foi consumida.</Text>}
      <Text>
        {issued === 0 && already === 0 && failed.length === 0
          ? 'Nenhuma autorização precisou ser emitida.'
          : `${issued} autorização(ões) emitida(s)${already ? `, ${already} já estava(m) vigente(s)` : ''}.`}
      </Text>
      {failed.length > 0 && (
        <Alert tone="warning" title="Ficou pendente:">
          <ul aria-label="O que ficou pendente">
            {failed.map((r) => (
              <li key={`${r.workerId}-${r.kind}`}>
                {kindText(r)} em {workers.get(r.workerId) ?? 'uma máquina'}: {FAILURE_TEXT[r.reason ?? ''] ?? `motivo ${r.reason ?? 'desconhecido'}`}
              </li>
            ))}
          </ul>
          Use “Gerenciar ativação” para concluir. Concluir não consome outra licença.
        </Alert>
      )}
    </Stack>
  );
}

type Load<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: unknown };

/** Data escolhida (modelo anterior) → instante do fim do dia, local. */
const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : undefined);
const validLegacyDate = (d: string) => {
  if (!d) return false;
  const t = new Date(`${d}T23:59:59`).getTime();
  return t > Date.now() && t <= Date.now() + 366 * 86_400_000;
};

/** As máquinas (Workers) como caixas de marcar: nenhuma vem marcada. */
type MachineOption = AutomationActivationOptions['workers'][number];
type ActivationMachine = AutomationActivation['workers'][number];

/**
 * O que uma máquina que não é oferecida de novo JÁ TEM nesta automação, pelo estado das autorizações, nunca pela origem:
 * a autorização pode ter sido emitida pela ativação ou pela rota anterior (autorização avulsa), e a Platform trata as duas
 * do mesmo jeito. Sem o detalhe (lista ainda não lida), diz só o que se sabe.
 */
export function alreadyAuthorizedText(m: ActivationMachine | undefined): string {
  if (!m) return 'já tem autorização registrada nesta automação';
  const execution = m.execution?.status === 'active';
  const monitoring = m.monitoring?.status === 'active';
  if (execution && monitoring) return 'já autorizada nesta automação: execução e monitoramento';
  if (execution) return 'já autorizada nesta automação: só execução';
  if (monitoring) return 'já autorizada nesta automação: só monitoramento';
  return 'a autorização desta máquina nesta automação não está mais vigente';
}

/** Máquina com execução E monitoramento vigentes: não há o que emitir. Parcial ou vencida: pode ser escolhida para completar. */
const fullyAuthorized = (m: ActivationMachine | undefined) => !m || (m.execution?.status === 'active' && m.monitoring?.status === 'active');

function WorkerChoice({ workers, chosen, onToggle, legend, already }: { workers: MachineOption[]; chosen: Set<string>; onToggle: (id: string) => void; legend: string; already?: Map<string, ActivationMachine | undefined> }) {
  if (workers.length === 0)
    return <Alert tone="info">Nenhuma máquina autorizada neste ambiente de trabalho. A ativação pode ser feita agora e as máquinas escolhidas depois.</Alert>;
  return (
    <fieldset className="pw-lic__choice">
      <legend>
        <Text as="span" variant="body-sm">
          {legend}
        </Text>
      </legend>
      {workers.map((w) => (
        <div key={w.workerId} className="pw-lic__machine">
          {already?.has(w.workerId) && fullyAuthorized(already.get(w.workerId)) ? (
            <Text variant="body-sm" color="secondary">
              {machineName(w.name, w.computerName)} ({alreadyAuthorizedText(already.get(w.workerId))})
            </Text>
          ) : already?.has(w.workerId) ? (
            // parcial (ex.: só a execução, autorizada antes pela rota anterior) ou vencida: escolher emite só o que falta
            <Checkbox
              label={machineName(w.name, w.computerName)}
              hint={`${alreadyAuthorizedText(already.get(w.workerId))}. Escolher emite só o que falta; o que está vigente é mantido.`}
              checked={chosen.has(w.workerId)}
              onChange={() => onToggle(w.workerId)}
            />
          ) : (
            <Checkbox label={machineName(w.name, w.computerName)} checked={chosen.has(w.workerId)} onChange={() => onToggle(w.workerId)} />
          )}
          <MachineStateBadge state={w.machineState} lastContactAt={w.lastContactAt} />
        </div>
      ))}
      <Text variant="body-sm" color="secondary">
        {LICENSE_NOT_CONSUMED} Uma máquina sem contato agora recebe as autorizações quando voltar a se conectar.
      </Text>
    </fieldset>
  );
}

/** "Ativar automação": ambiente de trabalho → automação → Workers → conferência → "Ativar execução e monitoramento". */
function ActivateDialog({ open, onClose, onDone, activations }: { open: boolean; onClose: () => void; onDone: (o: AutomationActivationOutcome, names: Map<string, string>) => void; activations?: AutomationActivation[] }) {
  const { org, expired } = useSession();
  const [workspaces, setWorkspaces] = useState<Load<Workspace[]>>({ status: 'loading' });
  const [workspaceId, setWorkspaceId] = useState('');
  const [options, setOptions] = useState<Load<AutomationActivationOptions> | null>(null);
  const [automationId, setAutomationId] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [until, setUntil] = useState('');

  useEffect(() => {
    if (!open) return;
    setWorkspaceId('');
    setOptions(null);
    setAutomationId('');
    setChosen(new Set());
    setUntil('');
    setWorkspaces({ status: 'loading' });
    listWorkspaces(org, { limit: 100 })
      .then((p) => setWorkspaces({ status: 'ready', data: p.items.filter((w) => w.status === 'active') }))
      .catch((e) => (isApiError(e, 'unauthenticated') ? expired() : setWorkspaces({ status: 'error', error: e })));
  }, [open, org, expired]);

  const chooseWorkspace = (id: string) => {
    setWorkspaceId(id);
    setAutomationId('');
    setChosen(new Set());
    if (!id) return setOptions(null);
    setOptions({ status: 'loading' });
    getActivationOptions(org, id)
      .then((d) => setOptions({ status: 'ready', data: d }))
      .catch((e) => (isApiError(e, 'unauthenticated') ? expired() : setOptions({ status: 'error', error: e })));
  };

  const opt = options?.status === 'ready' ? options.data : null;
  const automation = opt?.automations.find((a) => a.automationId === automationId);
  const existing = activations?.find((a) => a.automationId === automationId);
  const already = new Map((automation?.workerIds ?? []).map((id) => [id, existing?.workers.find((w) => w.workerId === id)] as const));
  const names = useMemo(() => new Map((opt?.workers ?? []).map((w) => [w.workerId, machineName(w.name, w.computerName)])), [opt]);
  const legacy = opt?.model === 'legacy';
  const needsLicense = !!automation && !automation.licensed;
  const blockedNoLicense = !!opt && needsLicense && !legacy && !opt.nextLicense;
  const legacyDateOk = !legacy || chosen.size === 0 || validLegacyDate(until);
  const ready = !!automation && !blockedNoLicense && legacyDateOk;
  const toggle = (id: string) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <StepUpDialog
      open={open}
      title="Ativar automação"
      confirmLabel="Ativar execução e monitoramento"
      guard={{ operation: 'automation.activate', target: automationId || undefined }}
      stepUp={orgStepUp(org)}
      ready={ready}
      action={() => activateAutomation(org, automationId, [...chosen], legacy ? endOfDay(until) : undefined)}
      onDone={(o) => onDone(o, names)}
      onClose={onClose}
      refusalText={refusal}
      uncertainText="Não foi possível confirmar a ativação. Feche e confira a lista de automações antes de tentar de novo: repetir não consome outra licença."
      onUnauthenticated={expired}
    >
      <Stack gap={4}>
        {workspaces.status === 'loading' && <Text color="secondary">Carregando os ambientes de trabalho…</Text>}
        {workspaces.status === 'error' && <Alert tone="warning">Não foi possível carregar os ambientes de trabalho. Feche e tente de novo.</Alert>}
        {workspaces.status === 'ready' && (
          <Select
            label="1. Ambiente de trabalho"
            fullWidth
            value={workspaceId}
            onChange={(e) => chooseWorkspace(e.target.value)}
            options={[{ value: '', label: 'Escolha o ambiente de trabalho' }, ...workspaces.data.map((w) => ({ value: w.workspaceId, label: w.name }))]}
          />
        )}
        {options?.status === 'loading' && <Text color="secondary">Carregando as automações e as máquinas…</Text>}
        {options?.status === 'error' && <Alert tone="warning">Não foi possível carregar as automações deste ambiente de trabalho.</Alert>}
        {opt &&
          (opt.automations.length === 0 ? (
            <Alert tone="info">Este ambiente de trabalho ainda não tem automação ativa.</Alert>
          ) : (
            <Select
              label="2. Automação"
              fullWidth
              value={automationId}
              onChange={(e) => {
                setAutomationId(e.target.value);
                setChosen(new Set());
              }}
              options={[
                { value: '', label: 'Escolha a automação' },
                ...opt.automations.map((a) => ({ value: a.automationId, label: `${a.name}${a.licensed ? ` · ${STATE_TEXT[a.state].label}` : ''}` })),
              ]}
            />
          ))}
        {opt && automation && (
          <>
            <WorkerChoice workers={opt.workers} chosen={chosen} onToggle={toggle} legend="3. Máquinas que vão executar e monitorar (nenhuma vem marcada)" already={already} />
            {legacy && chosen.size > 0 && (
              <Input
                label="Validade das autorizações"
                type="date"
                fullWidth
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                hint="Esta organização ainda não exige licença: escolha até quando as autorizações valem (até 366 dias)."
                error={until && !validLegacyDate(until) ? 'Escolha uma data futura dentro de 366 dias.' : undefined}
              />
            )}
            <section aria-label="Conferência da ativação" className="pw-lic__review">
              <Text as="h3" variant="h4">
                4. Conferir
              </Text>
              <ul>
                <li>
                  <strong>Licença: </strong>
                  {automation.licensed ? (
                    'a automação já tem licença; nenhuma outra será consumida.'
                  ) : opt.nextLicense ? (
                    <>
                      será usada a licença nº {opt.nextLicense.number}
                      {opt.nextLicense.validUntil ? (
                        <>
                          , válida até <DateTimeText iso={opt.nextLicense.validUntil} />
                        </>
                      ) : null}
                      . Uma licença cobre execução e monitoramento desta automação em todas as máquinas.
                    </>
                  ) : legacy ? (
                    'esta organização ainda não exige licença; não há licença disponível para vincular agora.'
                  ) : (
                    'não há licença disponível.'
                  )}
                </li>
                <li>
                  <strong>Versão publicada atual: </strong>
                  {automation.currentVersion
                    ? `versão ${automation.currentVersion.number}. Versões futuras não são autorizadas sozinhas: cada uma é aceita em "Gerenciar ativação".`
                    : 'nenhuma. A execução fica pendente até a publicação; o monitoramento já vale.'}
                </li>
                <li>
                  <strong>Máquinas: </strong>
                  {chosen.size === 0
                    ? 'nenhuma escolhida. A ativação fica com “Configuração pendente” até você escolher.'
                    : [...chosen].map((w) => names.get(w) ?? w).join(', ')}
                </li>
              </ul>
            </section>
            {blockedNoLicense && (
              <Alert tone="warning" title="Não há licença disponível para ativar esta automação.">
                Todas as licenças vigentes já atendem outras automações. Para ativar esta, é preciso contratar mais uma licença: a contratação e a
                transferência são feitas pelo suporte da Nekkora. Nada será vinculado nem autorizado.
              </Alert>
            )}
          </>
        )}
      </Stack>
    </StepUpDialog>
  );
}

type ManageAct = { kind: 'workers' } | { kind: 'version' } | { kind: 'renew' };

/** "Gerenciar ativação": acrescentar Workers, aceitar a versão nova, renovar autorizações. Nada consome outra licença. */
function ManageDialog({ activation, act, onClose, onDone }: { activation: AutomationActivation; act: ManageAct; onClose: () => void; onDone: (o: AutomationActivationOutcome, names: Map<string, string>) => void }) {
  const { org, expired } = useSession();
  const [options, setOptions] = useState<Load<AutomationActivationOptions>>({ status: 'loading' });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [until, setUntil] = useState('');
  useEffect(() => {
    getActivationOptions(org, activation.workspaceId)
      .then((d) => setOptions({ status: 'ready', data: d }))
      .catch((e) => (isApiError(e, 'unauthenticated') ? expired() : setOptions({ status: 'error', error: e })));
  }, [org, activation.workspaceId, expired]);
  const opt = options.status === 'ready' ? options.data : null;
  const legacy = opt?.model === 'legacy';
  const names = useMemo(() => new Map([...(opt?.workers ?? []), ...activation.workers].map((w) => [w.workerId, machineName(w.name, w.computerName)])), [opt, activation.workers]);
  const inActivation = new Map(activation.workers.map((w) => [w.workerId, w] as const));
  const toggle = (id: string) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const legacyNeedsDate = legacy && (act.kind === 'version' || (act.kind === 'workers' && chosen.size > 0));
  const dateOk = !legacyNeedsDate || validLegacyDate(until);
  const titles: Record<ManageAct['kind'], string> = {
    workers: `Acrescentar máquinas a ${activation.name}`,
    version: `Aceitar a versão ${activation.currentVersion?.number ?? ''} de ${activation.name}`,
    renew: `Renovar autorizações de ${activation.name}`,
  };
  const labels: Record<ManageAct['kind'], string> = { workers: 'Acrescentar máquinas', version: 'Aceitar versão', renew: 'Renovar autorizações' };
  const ready = !!opt && dateOk && (act.kind !== 'workers' || chosen.size > 0) && (act.kind !== 'version' || !!activation.currentVersion);
  return (
    <StepUpDialog
      open
      title={titles[act.kind]}
      confirmLabel={labels[act.kind]}
      guard={{ operation: `automation.activation.${act.kind}`, target: activation.automationId }}
      stepUp={orgStepUp(org)}
      ready={ready}
      action={() =>
        act.kind === 'workers'
          ? activateAutomation(org, activation.automationId, [...chosen], legacy ? endOfDay(until) : undefined)
          : act.kind === 'version'
            ? acceptActivationVersion(org, activation.automationId, activation.currentVersion!.versionId, legacy ? endOfDay(until) : undefined)
            : renewActivation(org, activation.automationId)
      }
      onDone={(o) => onDone(o, names)}
      onClose={onClose}
      refusalText={refusal}
      uncertainText="Não foi possível confirmar o resultado. Feche e confira a lista antes de tentar de novo: repetir não duplica nem consome licença."
      onUnauthenticated={expired}
    >
      <Stack gap={3}>
        {options.status === 'loading' && <Text color="secondary">Carregando…</Text>}
        {options.status === 'error' && <Alert tone="warning">Não foi possível carregar as máquinas deste ambiente de trabalho.</Alert>}
        {opt && act.kind === 'workers' && (
          <>
            <WorkerChoice workers={opt.workers} chosen={chosen} onToggle={toggle} legend="Máquinas a acrescentar (nenhuma vem marcada)" already={inActivation} />
            <Text>
              As máquinas escolhidas recebem a execução da versão {activation.acceptedVersion ? activation.acceptedVersion.number : 'publicada atual'} e o monitoramento.
              Nenhuma outra licença é consumida.
            </Text>
          </>
        )}
        {opt && act.kind === 'version' && (
          <Text>
            A versão {activation.currentVersion?.number} passa a poder executar nas máquinas desta ativação:{' '}
            {activation.workers.map((w) => w.name).join(', ') || 'nenhum'}. O monitoramento já autorizado continua valendo. Nenhuma outra licença é
            consumida.
          </Text>
        )}
        {opt && act.kind === 'renew' && (
          <>
            <Text>
              Licença renovada até <DateTimeText iso={activation.license?.coverageUntil} />. As autorizações novas valem a partir de agora até essa data,
              para as mesmas máquinas e a versão já aceita
              {activation.acceptedVersion ? ` (versão ${activation.acceptedVersion.number})` : ''}: {activation.workers.map((w) => w.name).join(', ')}.
            </Text>
            <Text variant="body-sm" color="secondary">
              Não inclui máquinas novas nem autorizações retiradas por alguém, não troca para uma versão mais nova e não cobre períodos anteriores. As
              anteriores ficam no histórico. Nenhuma licença é consumida e nenhuma máquina precisa ser vinculada de novo.
            </Text>
          </>
        )}
        {legacyNeedsDate && (
          <Input
            label="Validade das autorizações"
            type="date"
            fullWidth
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            hint="Esta organização ainda não exige licença: escolha até quando as autorizações valem (até 366 dias)."
            error={until && !validLegacyDate(until) ? 'Escolha uma data futura dentro de 366 dias.' : undefined}
          />
        )}
      </Stack>
    </StepUpDialog>
  );
}

const authText = (x: AutomationActivation['workers'][number]['execution']): ReactNode =>
  !x ? 'pendente' : x.status === 'active' ? <>até <DateTimeText iso={x.validUntil} /></> : x.status === 'expired' ? 'vencida' : 'substituída';

/** A seção da ativação dentro de "Licenças e automações". */
export function ActivationSection({ data, onChanged, canActivate }: { data: AutomationActivationList | null; onChanged: () => void; canActivate: boolean }) {
  const [activating, setActivating] = useState(false);
  const [managing, setManaging] = useState<{ a: AutomationActivation; act: ManageAct } | null>(null);
  const [outcome, setOutcome] = useState<{ o: AutomationActivationOutcome; names: Map<string, string> } | null>(null);
  const done = useCallback(
    (o: AutomationActivationOutcome, names: Map<string, string>) => {
      setActivating(false);
      setManaging(null);
      setOutcome({ o, names });
      onChanged();
    },
    [onChanged],
  );
  const items = data?.items ?? [];
  const columns: TableColumn<AutomationActivation>[] = [
    {
      key: 'automacao',
      header: 'Automação',
      render: (a) => (
        <Stack gap={1}>
          <span>{a.name}</span>
          <Text variant="body-sm" color="secondary">
            {a.workspaceName}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'licenca',
      header: 'Licença e validade',
      render: (a) =>
        a.license ? (
          <Stack gap={1}>
            <span>nº {a.license.number}</span>
            <Text variant="body-sm" color="secondary">
              {a.license.coverageUntil ? (
                <>
                  até <DateTimeText iso={a.license.coverageUntil} />
                </>
              ) : (
                'sem cobertura agora'
              )}
            </Text>
          </Stack>
        ) : (
          <Text color="secondary">sem licença</Text>
        ),
    },
    {
      key: 'workers',
      header: 'Máquinas',
      render: (a) =>
        a.workers.length === 0 ? (
          <Text color="secondary">nenhum</Text>
        ) : (
          <ul className="pw-lic__names" aria-label={`máquinas de ${a.name}`}>
            {a.workers.map((w) => (
              <li key={w.workerId}>
                <Text variant="body-sm">
                  {machineName(w.name, w.computerName)}: execução {authText(w.execution)}; monitoramento {authText(w.monitoring)}
                </Text>
                <MachineStateBadge state={w.machineState} lastContactAt={w.lastContactAt} />
              </li>
            ))}
          </ul>
        ),
    },
    { key: 'versao', header: 'Versão aceita', render: (a) => (a.acceptedVersion ? `versão ${a.acceptedVersion.number}` : '—') },
    {
      key: 'situacao',
      header: 'Situação',
      render: (a) => (
        <Stack gap={1}>
          <Badge tone={STATE_TEXT[a.state].tone} dot>
            {STATE_TEXT[a.state].label}
          </Badge>
          {a.pending.map((p) => (
            <Text key={p} variant="body-sm" color="secondary">
              {pendingText(p, a)}
            </Text>
          ))}
        </Stack>
      ),
    },
    {
      key: 'acoes',
      header: 'Gerenciar ativação',
      render: (a) =>
        a.automationStatus !== 'active' ? null : (
          <Stack gap={1}>
            {a.pending.includes('RENEWAL_AVAILABLE') && (
              <Button size="sm" onClick={() => setManaging({ a, act: { kind: 'renew' } })} aria-label={`Renovar autorizações de ${a.name}`}>
                Renovar autorizações
              </Button>
            )}
            {a.pending.includes('NEW_VERSION_AVAILABLE') && a.workers.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setManaging({ a, act: { kind: 'version' } })} aria-label={`Aceitar a versão nova de ${a.name}`}>
                Aceitar versão {a.currentVersion?.number}
              </Button>
            )}
            {a.license?.state !== 'LICENSE_EXPIRED' && (
              <Button size="sm" variant="secondary" onClick={() => setManaging({ a, act: { kind: 'workers' } })} aria-label={`Acrescentar máquinas a ${a.name}`}>
                {a.workers.length === 0 ? 'Escolher máquinas' : 'Acrescentar máquinas'}
              </Button>
            )}
          </Stack>
        ),
    },
  ];
  return (
    <section aria-labelledby="pw-lic-ativacao">
      <Stack gap={4}>
        <div className="pw-lic__head">
          <Text as="h2" variant="h3" id="pw-lic-ativacao">
            Automações atendidas
          </Text>
          {canActivate && (
            <Button leftIcon="plus" onClick={() => setActivating(true)}>
              Ativar automação
            </Button>
          )}
        </div>
        <Text color="secondary">
          Ativar uma automação libera, em um passo, a execução e o monitoramento nas máquinas escolhidas. Uma licença atende a automação inteira, em
          qualquer número de máquinas; máquinas não consomem licença. Versões novas só executam depois de aceitas aqui.
        </Text>
        {outcome && (
          <Alert tone={outcome.o.results.some((r) => r.outcome === 'failed') ? 'warning' : 'success'} title={`${outcome.o.activation.name}: ${STATE_TEXT[outcome.o.activation.state].label}.`}>
            <OutcomeSummary outcome={outcome.o} workers={outcome.names} />
          </Alert>
        )}
        {data === null ? (
          <StateView status="loading" title="Carregando as automações atendidas…" />
        ) : items.length === 0 ? (
          <StateView status="neutral" title="Nenhuma automação ativada ainda." description="Use “Ativar automação” para escolher o ambiente de trabalho, a automação e as máquinas." />
        ) : (
          <div className="pw-prod__scroll" role="region" aria-label="Lista de automações atendidas" tabIndex={0}>
            <Table columns={columns} data={items} rowKey="automationId" size="sm" caption="Automações com licença ou ativação, pelo nome." />
          </div>
        )}
      </Stack>
      <ActivateDialog open={activating} onClose={() => setActivating(false)} onDone={done} activations={data?.items} />
      {managing && <ManageDialog activation={managing.a} act={managing.act} onClose={() => setManaging(null)} onDone={done} />}
    </section>
  );
}

