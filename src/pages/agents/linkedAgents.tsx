import { useEffect, useState } from 'react';
import { Alert, Button, Stack, StateView, Text, type TableColumn } from 'nekkora-lib';
import { cancelAgentCode, listAgents, type Agent, type AgentCode } from '../../api/agents';
import { isApiError } from '../../api/http';
import { useSession } from '../../area/session';
import { ForbiddenState } from '../admin/shared';
import { DateTimeText, LoadErrorState } from '../product/shared';
import { OneTimeCode, RevokeLinkDialog, RotateCredentialDialog, type LinkedAgent } from './agentDialogs';
import { ResponsiveTable } from './ResponsiveTable';
import { CommunicationCell, FreshnessNotice, LinkBadge, PRESENCE_TEXT, useLiveList } from './presence';

/** Explicação para quem administra Agents sem administrar Workers. */
export const AGENTS_ONLY_TEXT =
  'Você administra os Agents desta organização, mas não os Workers. Aqui ficam as ações sobre as máquinas vinculadas: renovar a credencial e revogar o vínculo. Criar Workers, autorizá-los em workspaces e vincular um Agent a um Worker exigem a permissão de administrar Workers.';

/**
 * PLATFORM-AGENT-V2-002 R1 — a tela de Workers para quem tem `agent.manage` SEM `worker.manage`. A lista de Workers exige
 * `worker.manage` na API; a de Agents, `agent.manage`. Antes da T07 essa pessoa usava a tela de Agents (listar, renovar a
 * credencial, revogar). Ela continua com as mesmas ações, agora em Workers, cada uma pela permissão que a API exige:
 * renovar (`agent_credential.manage`) e revogar (`agent.manage`). O Worker aparece pelo identificador, porque os nomes
 * vêm da lista de Workers.
 */
export function LinkedAgentsView({ has }: { has: (p: string) => boolean }) {
  const { org, expired } = useSession();
  // T11: releitura a cada 30 s com a página visível; falha mantém os dados como não confirmados
  const { list, freshness, load, refresh } = useLiveList(async () => (await listAgents(org)).items, [org], expired);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [rotating, setRotating] = useState<LinkedAgent | null>(null);
  const [revoking, setRevoking] = useState<LinkedAgent | null>(null);
  const [code, setCode] = useState<{ code: AgentCode; purpose: string } | null>(null);
  useEffect(() => () => setCode(null), []);

  if (list.status === 'error' && isApiError(list.error, 'forbidden')) return <ForbiddenState area="os Agents" onRetry={() => void load()} />;

  const canRotate = has('agent_credential.manage');
  const canRevoke = has('agent.manage');
  const name = (a: Agent) => a.name ?? `Agent ${a.agentId!.slice(0, 8)}…`;
  const worker = (a: Agent) => (a.workerId ? `Worker ${a.workerId.slice(0, 8)}…` : 'Sem Worker');
  const linked = (a: Agent): LinkedAgent => ({ agentId: a.agentId!, name: name(a), workerName: worker(a) });
  const columns: TableColumn<Agent>[] = [
    // o nome sozinho (título do cartão no modo estreito); situação, versão e validade ficam na coluna Agent
    { key: 'maquina', header: 'Máquina', align: 'center', render: (a) => <span className="pw-break">{name(a)}</span> },
    {
      key: 'agent',
      header: 'Agent',
      align: 'center',
      render: (a) => (
        <Stack gap={1}>
          <LinkBadge status={a.status} endedBy={a.endedBy} />
          <Text variant="body-sm" color="secondary">
            Versão do Agent: {a.agentVersion ?? 'não informada'}
          </Text>
          <Text variant="body-sm" color="secondary">
            Credencial vale até <DateTimeText iso={a.credentialExpiresAt} />
          </Text>
        </Stack>
      ),
    },
    { key: 'worker', header: 'Worker', align: 'center', render: (a) => <span title={a.workerId ?? undefined}>{worker(a)}</span> },
    {
      key: 'comunicacao',
      header: 'Comunicação',
      align: 'center',
      render: (a) => <CommunicationCell status={a.status} connectivity={a.connectivity} lastHeartbeatAt={a.lastHeartbeatAt} freshness={freshness} endedBy={a.endedBy} />,
    },
    {
      key: 'acoes',
      header: 'Ações',
      align: 'center',
      render: (a) =>
        a.status === 'REVOKED' ? (
          <Text variant="body-sm" color="secondary">
            Nenhuma: vínculo revogado
          </Text>
        ) : (
          <div className="pw-workers__actions">
            {canRotate && (
              <Button size="sm" variant="ghost" onClick={() => setRotating(linked(a))} aria-label={`Renovar credencial de ${name(a)}`}>
                Renovar credencial
              </Button>
            )}
            {canRevoke && a.workerId && (
              <Button size="sm" variant="ghost" onClick={() => setRevoking(linked(a))} aria-label={`Revogar vínculo de ${name(a)} com ${worker(a)}`}>
                Revogar vínculo
              </Button>
            )}
          </div>
        ),
    },
  ];

  return (
    <Stack gap={4}>
      <Alert tone="info">{AGENTS_ONLY_TEXT}</Alert>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {list.status === 'ready' && <FreshnessNotice freshness={freshness} onRetry={() => void refresh()} />}
      {code && (
        <section aria-label={code.purpose}>
          <Stack gap={2}>
            <Text weight="semibold">{code.purpose}</Text>
            <OneTimeCode
              key={code.code.enrollmentId}
              code={code.code}
              onCancel={() => cancelAgentCode(org, code.code.enrollmentId)}
              onDone={() => {
                setCode(null);
                void load();
              }}
            />
          </Stack>
        </section>
      )}
      {list.status === 'loading' && <StateView status="loading" title="Carregando máquinas vinculadas…" />}
      {list.status === 'error' && <LoadErrorState error={list.error} onRetry={() => void load()} />}
      {list.status === 'ready' &&
        (list.items.length === 0 ? (
          <StateView status="neutral" title="Nenhuma máquina vinculada." description="Uma máquina aparece aqui depois que o Agent dela resgata um código de pareamento." />
        ) : (
          // mesma lista responsiva da T08: tabela quando cabe, cartões quando não cabe, com as mesmas colunas e permissões
          <ResponsiveTable
            className="pw-prod__scroll pw-workers"
            label="Máquinas vinculadas"
            columns={columns}
            data={list.items}
            rowKey="agentId"
            title="maquina"
            caption="Máquinas vinculadas da organização."
          />
        ))}
      {list.status === 'ready' && list.items.length > 0 && (
        <Text variant="body-sm" color="secondary">
          {PRESENCE_TEXT}
        </Text>
      )}

      <RotateCredentialDialog
        agent={rotating}
        onDone={(c) => {
          const a = rotating;
          setRotating(null);
          setCode({ code: c, purpose: `Código de renovação da credencial de ${a?.name ?? 'a máquina'}` });
        }}
        onClose={() => setRotating(null)}
      />
      <RevokeLinkDialog
        agent={revoking}
        onDone={() => {
          const a = revoking;
          setRevoking(null);
          setNotice({
            tone: 'success',
            text: `Vínculo revogado: ${a?.workerName ?? 'o Worker'} está livre, com os workspaces e o histórico mantidos. A máquina precisa ser pareada de novo para voltar a executar. Isso não prova que um processo já em execução numa máquina desconectada parou.`,
          });
          void load();
        }}
        onClose={() => setRevoking(null)}
        onUncertain={() => setNotice({ tone: 'warning', text: 'O resultado da revogação não foi confirmado. Confira a lista.' })}
      />
    </Stack>
  );
}
