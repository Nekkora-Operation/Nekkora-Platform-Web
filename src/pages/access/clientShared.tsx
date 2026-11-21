import { useEffect, useState } from 'react';
import { Input, Select, Text } from 'nekkora-lib';
import { createClient, updateClient, type ClientRecord } from '../../api/clientAccess';
import { hasReason, isApiError } from '../../api/http';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal } from './shared';

/** PLATFORM-FLUXO-002 (070/071): textos e peças comuns de clientes e acessos de cliente. */

export const CLIENT_STATUS_LABEL: Record<ClientRecord['status'], string> = { active: 'Ativo', suspended: 'Suspenso', archived: 'Arquivado' };

/** Alcance por máquina, sempre explícito. */
export const machineScopeText = (machineName: string | null | undefined) =>
  machineName ? `as execuções da máquina ${machineName}` : 'as execuções de todas as máquinas dessa automação';

/** O que o compartilhamento mostra (071): dashboard de execução e/ou arquivos de retorno. Registros técnicos nunca. */
export function permissionsText(canViewDashboard: boolean, canDownloadResults: boolean): string {
  if (canViewDashboard && canDownloadResults) return 'Dashboard de execução e arquivos de retorno';
  if (canViewDashboard) return 'Só o dashboard de execução';
  if (canDownloadResults) return 'Só os arquivos de retorno';
  return 'Nenhum conteúdo';
}

/** O resumo antes de enviar. */
export function inviteSummary(automation: string, workspace: string, machineName: string | null, person?: string): string {
  return `Você está compartilhando a automação ${automation} (ambiente de trabalho ${workspace})${person ? ` com ${person}` : ''}, considerando ${machineScopeText(machineName).replace(/^as /, '')}.`;
}

/** O que a pessoa de fora vê e não vê (071). */
export const CLIENT_SEES =
  'A pessoa vê só esta automação: o dashboard de execução (indicadores e o estado de cada execução em linguagem simples) e, se marcado, os arquivos de retorno para ver ou baixar. Não vê registros técnicos, código, pacotes, configurações, máquinas nem o ambiente de trabalho, e não executa nem altera nada. O compartilhamento não consome licença. O acesso só começa quando a pessoa aceita com a identidade Nekkora do mesmo e-mail.';

/** Recusas próprias dos atos de cliente (070); as demais pelo texto comum. */
export function clientRefusal(e: unknown, conflict?: string): string {
  const nothing = 'Nada foi alterado.';
  if (hasReason(e, 'conflict', 'client_invitation_internal_member'))
    return `Esta pessoa já é membro interno da organização. Um convite de Cliente não reduziria os acessos dela; os perfis atuais continuam valendo. ${nothing}`;
  if (hasReason(e, 'conflict', 'client_invitation_legacy_account'))
    return `Já existe uma conta de cliente antiga com este e-mail, sem identidade Nekkora. Ela não é ligada automaticamente; a migração exige um procedimento de comprovação. ${nothing}`;
  if (hasReason(e, 'conflict', 'client_invitation_other_client'))
    return `Esta pessoa já é cliente desta organização por outro cadastro de cliente. Uma conta atende um cliente. ${nothing}`;
  if (hasReason(e, 'conflict', 'client_grant_exists'))
    return `Essa automação (com essa máquina) já está compartilhada com a pessoa, ou há um pedido aguardando aprovação. ${nothing}`;
  if (hasReason(e, 'conflict', 'client_scope_unavailable'))
    return `O cliente, a automação, o ambiente de trabalho ou a máquina não está mais disponível. Atualize e confira. ${nothing}`;
  if (hasReason(e, 'conflict', 'client_grant_widening_requires_request'))
    return `Ligar o dashboard ou os arquivos de retorno é um pedido novo, aprovado por outra pessoa. ${nothing}`;
  if (isApiError(e, 'forbidden'))
    return accessRefusal(e, {
      forbidden: 'O ato não foi permitido. Aprovar exige outra pessoa (quem pediu não aprova) e a confirmação recente; compartilhar exige a permissão nesse ambiente de trabalho.',
    });
  return accessRefusal(e, { conflict });
}

/** Cadastrar ou editar um cliente (nome e situação). Nada é apagado; arquivar ou suspender barra a área do cliente. */
export function ClientFormDialog({
  org,
  open,
  client,
  onClose,
  onSaved,
  onUnauthenticated,
}: {
  org: string;
  open: boolean;
  client: ClientRecord | null;
  onClose: () => void;
  onSaved: (c: ClientRecord) => void;
  onUnauthenticated: () => void;
}) {
  const [name, setName] = useState('');
  const [status, setStatus] = useState<ClientRecord['status']>('active');
  useEffect(() => {
    if (!open) return;
    setName(client?.name ?? '');
    setStatus(client?.status ?? 'active');
  }, [open, client]);
  const trimmed = name.trim();
  const changed = client ? trimmed !== client.name || status !== client.status : trimmed.length > 0;
  return (
    <StepUpDialog
      open={open}
      title={client ? `Editar ${client.name}` : 'Cadastrar cliente'}
      confirmLabel={client ? 'Salvar' : 'Cadastrar'}
      ready={trimmed.length > 0 && trimmed.length <= 200 && changed}
      guard={{ operation: client ? 'client.update' : 'client.create', target: client?.clientId ?? trimmed.toLowerCase() }}
      action={() =>
        client
          ? updateClient(org, client.clientId, { ...(trimmed !== client.name ? { name: trimmed } : {}), ...(status !== client.status ? { status } : {}) })
          : createClient(org, trimmed)
      }
      onDone={onSaved}
      onClose={onClose}
      refusalText={(e) => clientRefusal(e)}
      uncertainText="Não foi possível confirmar o cadastro. Feche e confira a lista de clientes antes de tentar de novo."
      onUnauthenticated={onUnauthenticated}
    >
      <Input label="Nome do cliente" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} fullWidth required />
      {client && (
        <Select
          label="Situação"
          value={status}
          onChange={(e) => setStatus(e.target.value as ClientRecord['status'])}
          options={(['active', 'suspended', 'archived'] as const).map((s) => ({ value: s, label: CLIENT_STATUS_LABEL[s] }))}
          hint="Suspenso ou arquivado: as pessoas desse cliente deixam de ver o que foi compartilhado. Nada é apagado."
          fullWidth
        />
      )}
      <Text variant="body-sm" color="secondary">
        O cadastro identifica a empresa ou pessoa atendida. Vincular alguém a ele não dá acesso a nada por si só.
      </Text>
    </StepUpDialog>
  );
}
