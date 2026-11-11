import { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, RadioGroup, Stack, Text } from 'nekkora-lib';
import { createPairingCode, createRotationCode, revokeAgent, type AgentCode } from '../../api/agents';
import { isApiError } from '../../api/http';
import { useSession } from '../../area/session';
import { StepUpDialog } from '../../components/StepUpDialog';
import { accessRefusal, orgStepUp } from '../access/shared';
import { DateTimeText } from '../product/shared';
import '../../identity/identity.css';
import './agents.css';

/**
 * PLATFORM-AGENT-V2-002, T07 — atos sobre a máquina vinculada a um Worker (vincular, renovar a credencial, revogar o
 * vínculo) e o código de uso único. Compartilhados pela tela de Workers, que é a entrada única do fluxo.
 */

/**
 * Código de uso único (pareamento ou rotação): exibido SÓ na resposta de criação, copiado por gesto explícito, com o
 * prazo visível. Sai da memória ao concluir ou sair da tela; a listagem nunca o devolve (não há recuperação).
 */
export function OneTimeCode({ code, onCancel, onDone }: { code: AgentCode; onCancel?: () => Promise<void>; onDone: () => void }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [now, setNow] = useState(Date.now());
  const [cancelState, setCancelState] = useState<'idle' | 'busy' | 'done' | string>('idle');
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((new Date(code.expiresAt).getTime() - now) / 1000));
  const expired = left === 0;

  return (
    <Card variant="outlined" padding="lg">
      <Stack gap={3}>
        <Alert tone="warning" title="Este código aparece só agora.">
          Use-o no Agent da máquina ({'"'}Parear com a Platform{'"'}). Ele é temporário e de uso único; ao sair desta tela ele não
          pode ser exibido de novo — se perder, cancele e gere outro.
        </Alert>
        <code className="pw-break pw-hash pw-code" aria-label="Código de uso único">
          {code.code}
        </code>
        <Text variant="body-sm" aria-live="off">
          {expired ? 'Prazo vencido: gere outro código.' : `Vale por mais ${Math.floor(left / 60)} min ${String(left % 60).padStart(2, '0')} s (até `}
          {!expired && (
            <>
              <DateTimeText iso={code.expiresAt} />)
            </>
          )}
        </Text>
        <div className="pw-form__row">
          <Button
            variant="secondary"
            leftIcon="copy"
            disabled={expired}
            onClick={() =>
              navigator.clipboard.writeText(code.code).then(
                () => setCopied('ok'),
                () => setCopied('fail'),
              )
            }
          >
            Copiar código
          </Button>
          {onCancel && cancelState !== 'done' && (
            <Button
              variant="ghost"
              loading={cancelState === 'busy'}
              onClick={() => {
                setCancelState('busy');
                onCancel().then(
                  () => setCancelState('done'),
                  (e) =>
                    setCancelState(
                      isApiError(e, 'conflict') ? 'O código já foi usado ou cancelado.' : 'Não foi possível confirmar o cancelamento. Confira a lista de Workers.',
                    ),
                );
              }}
            >
              Cancelar código
            </Button>
          )}
          <Button variant="ghost" onClick={onDone}>
            Concluir
          </Button>
        </div>
        {copied === 'ok' && <Text variant="body-sm">Copiado. Cole no Agent; não guarde o código em outro lugar.</Text>}
        {copied === 'fail' && <Text variant="body-sm">Não foi possível copiar automaticamente. Selecione o código e copie manualmente.</Text>}
        {cancelState === 'done' && <Alert tone="success">Código cancelado: ele não pode mais ser usado. Nenhuma máquina foi registrada.</Alert>}
        {cancelState !== 'idle' && cancelState !== 'busy' && cancelState !== 'done' && <Alert tone="warning">{cancelState}</Alert>}
      </Stack>
    </Card>
  );
}

/** Worker sem Agent a que o código de pareamento se destina. */
export type FreeWorker = { workerId: string; name: string };
/** Máquina (Agent) vinculada a um Worker. */
export type LinkedAgent = { agentId: string; name: string; workerName: string };

/**
 * Vincular Agent: código de pareamento para ESTE Worker (`workerId`), sem cadastrar outro. Nenhuma máquina é registrada
 * até o Agent usar o código; cancelar ou deixar vencer não cria nada.
 */
export function PairAgentDialog({ worker, onDone, onClose }: { worker: FreeWorker | null; onDone: (code: AgentCode) => void; onClose: () => void }) {
  const { org, expired } = useSession();
  const [agentName, setAgentName] = useState('');
  const [minutes, setMinutes] = useState('15');
  const workerId = worker?.workerId;
  useEffect(() => {
    if (!worker) return;
    setAgentName(worker.name);
    setMinutes('15');
    // só ao abrir para um Worker (o nome digitado não é sobrescrito enquanto o diálogo está aberto)
  }, [workerId]);
  const ready = agentName.trim().length > 0 && agentName.trim().length <= 80 && Number(minutes) >= 5 && Number(minutes) <= 60;

  return (
    <StepUpDialog<AgentCode>
      open={!!worker}
      title={worker ? `Vincular Agent a ${worker.name}` : ''}
      guard={{ operation: 'agent.pairing-code', target: workerId }}
      confirmLabel="Gerar código"
      ready={ready}
      stepUp={orgStepUp(org)}
      action={() =>
        worker ? createPairingCode(org, { workerId: worker.workerId, agentName: agentName.trim(), expiresInMinutes: Number(minutes) }) : Promise.reject()
      }
      onDone={onDone}
      onClose={onClose}
      refusalText={(e) =>
        accessRefusal(e, {
          conflict: 'Este Worker já tem um Agent vinculado. Atualize a lista.',
          forbidden: 'O código não foi gerado: faltam permissões (Agents, credenciais, vínculo de Workers) ou a organização ainda não foi ativada.',
        })
      }
      uncertainText="Não foi possível confirmar se o código foi gerado. Feche: se foi, ele não pode ser exibido de novo e vence sozinho; gere outro."
      onUnauthenticated={expired}
    >
      <Text>
        O código vincula a máquina a este Worker, sem cadastrar outro. A máquina só aparece na lista depois que o Agent usar o
        código; cancelar o código ou deixá-lo vencer não registra máquina nenhuma.
      </Text>
      <Input
        label="Nome da máquina"
        required
        fullWidth
        maxLength={80}
        value={agentName}
        onChange={(e) => setAgentName(e.target.value)}
        hint="Nome lógico informado por você; nada é coletado da máquina."
      />
      <Input label="Validade do código (minutos)" type="number" min={5} max={60} value={minutes} onChange={(e) => setMinutes(e.target.value)} hint="De 5 a 60." />
    </StepUpDialog>
  );
}

/** Renovar credencial: código de rotação. A credencial anterior cai quando o Agent resgatar o código. */
export function RotateCredentialDialog({ agent, onDone, onClose }: { agent: LinkedAgent | null; onDone: (code: AgentCode) => void; onClose: () => void }) {
  const { org, expired } = useSession();
  return (
    <StepUpDialog<AgentCode>
      open={!!agent}
      title={agent ? `Renovar a credencial de ${agent.name}?` : ''}
      guard={{ operation: 'agent.rotation-code', target: agent?.agentId }}
      confirmLabel="Gerar código"
      stepUp={orgStepUp(org)}
      action={() => (agent ? createRotationCode(org, agent.agentId) : Promise.reject())}
      onDone={onDone}
      onClose={onClose}
      refusalText={(e) => accessRefusal(e, { notFound: 'A máquina não está mais vinculada a este Worker.' })}
      uncertainText="Não foi possível confirmar se o código foi gerado. Feche e gere outro se precisar."
      onUnauthenticated={expired}
    >
      <Text>O Agent resgata o código apresentando a credencial atual; nesse momento a credencial anterior deixa de valer. O vínculo com o Worker continua.</Text>
    </StepUpDialog>
  );
}

/**
 * Revogar vínculo: credencial revogada, códigos abertos cancelados e o Worker LIVRE na Platform, no mesmo ato. O Worker,
 * as autorizações de workspace e o histórico ficam. A máquina não é contatada.
 */
export function RevokeLinkDialog({
  agent,
  onDone,
  onClose,
  onUncertain,
}: {
  agent: LinkedAgent | null;
  onDone: () => void;
  onClose: () => void;
  onUncertain?: () => void;
}) {
  const { org, expired } = useSession();
  const [reason, setReason] = useState<'COMPROMISED' | 'ADMINISTRATIVE'>('ADMINISTRATIVE');
  return (
    <StepUpDialog
      open={!!agent}
      title={agent ? `Revogar o vínculo de ${agent.name} com ${agent.workerName}?` : ''}
      guard={{ operation: 'agent.revoke', target: agent?.agentId }}
      confirmLabel="Revogar vínculo"
      tone="danger"
      stepUp={orgStepUp(org)}
      action={() => (agent ? revokeAgent(org, agent.agentId, reason) : Promise.reject())}
      onDone={onDone}
      onClose={onClose}
      refusalText={(e) => accessRefusal(e, { conflict: 'O vínculo já foi revogado.' })}
      uncertainText="Não foi possível confirmar a revogação. Feche e confira a lista de Workers."
      onUnauthenticated={expired}
      onOutcome={(k) => k === 'uncertain' && onUncertain?.()}
    >
      <Text>
        A credencial da máquina é revogada e os códigos abertos são cancelados. O Worker fica livre na Platform e continua
        existindo, com as autorizações de workspace e o histórico. Para usar uma máquina de novo, será preciso vincular um
        Agent (novo pareamento).
      </Text>
      <Text>A máquina em si não é contatada: um processo que já esteja rodando numa máquina sem conexão não é interrompido.</Text>
      <RadioGroup
        legend="Motivo"
        value={reason}
        onChange={(v) => setReason(v as 'COMPROMISED' | 'ADMINISTRATIVE')}
        options={[
          { value: 'ADMINISTRATIVE', label: 'Administrativo (máquina desativada, troca de equipamento)' },
          { value: 'COMPROMISED', label: 'Suspeita de comprometimento' },
        ]}
      />
    </StepUpDialog>
  );
}
