import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Alert, Button, Card, Input, Stack, StateView, Text, Textarea } from 'nekkora-lib';
import { hasReason, isApiError } from '../../api/http';
import { ARTIFACT_MAX_BYTES, localSha256, readAutomationDraft, uploadDraftPackage, type LifecycleVersion, type UploadHandle } from '../../api/lifecycle';
import { getAutomation } from '../../api/product';
import { useSession } from '../../area/session';
import { useWorkspacePermissions } from '../../area/useWorkspacePermissions';
import { orgPath } from '../../auth/organization';
import { useResource } from '../../hooks/useResource';
import { checkCommand, draftRefusal, mib, PackageBrief } from './draftPackage';
import { LoadErrorState, NotFoundState, PageHeader, isMissing } from './shared';
import { uploadOutcome } from './uploadOutcome';
import './shared.css';
import '../../identity/identity.css';

/**
 * PLATFORM-AGENT-V2-002, T09 — /o/{org}/automacoes/:automationId/nova-versao. Abrir e sair deste formulário não grava
 * nada: nenhum registro, nenhum artefato, nenhum número consumido. A versão (rascunho) passa a existir quando a Platform
 * ACEITA o ZIP (PUT do rascunho da automação, sem expectativa de rascunho): a partir daí já está salva, mesmo que a pessoa
 * volte, feche a aba ou perca a resposta. ZIP recusado: nada criado, campos mantidos. Resposta perdida: a tela reconcilia
 * lendo o rascunho da automação e comparando o SHA-256; nunca reenvia sozinha. Com um rascunho existente (no máximo um
 * por automação), a tela não oferece outro: leva a ele.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending'; sent: number; total: number }
  | { kind: 'refused'; text: string }
  /** Sem resposta (rede, 5xx): os bytes podem ter chegado; só a conferência libera outra tentativa. */
  | { kind: 'uncertain' }
  | { kind: 'checked'; text: string }
  /** Há um rascunho que não é o deste envio (outra aba ou pessoa; ou conferência sem SHA-256 local). */
  | { kind: 'superseded'; draft: LifecycleVersion; comparable: boolean };

export function NewVersionPage() {
  const { automationId = '' } = useParams();
  return <NewVersion key={automationId} automationId={automationId} />;
}

function NewVersion({ automationId }: { automationId: string }) {
  const { org, expired } = useSession();
  const navigate = useNavigate();
  const automation = useResource(() => getAutomation(org, automationId), [org, automationId]);
  const existing = useResource(() => readAutomationDraft(org, automationId), [org, automationId]);
  const perms = useWorkspacePermissions(automation.status === 'ready' ? automation.data.workspaceId : undefined);

  const [runtime, setRuntime] = useState('');
  const [args, setArgs] = useState('');
  const [commandProblem, setCommandProblem] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [localHash, setLocalHash] = useState<string | null>(null);
  const [fileProblem, setFileProblem] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const running = useRef(false);
  const handle = useRef<UploadHandle | null>(null);
  // sair durante o envio interrompe no navegador; se a Platform já tiver aceitado, o rascunho está salvo
  useEffect(() => () => handle.current?.abort(), []);

  const gone = (automation.status === 'error' && isMissing(automation.error)) || (existing.status === 'error' && isMissing(existing.error));
  for (const r of [automation, existing]) {
    if (r.status === 'error' && isApiError(r.error, 'unauthenticated')) {
      expired();
      return null;
    }
  }
  if (gone) return <NotFoundState title="Automação não encontrada." back={{ to: orgPath.workspaces(org), label: 'Voltar para workspaces' }} />;
  if (automation.status === 'loading' || existing.status === 'loading' || perms.status === 'loading') return <StateView status="loading" title="Carregando automação…" />;
  if (automation.status === 'error') return <LoadErrorState error={automation.error} onRetry={automation.refresh} page />;
  if (existing.status === 'error') return <LoadErrorState error={existing.error} onRetry={existing.refresh} page />;

  const a = automation.data;
  const back = { to: orgPath.automation(org, automationId), label: `Voltar para ${a.name}` };
  const openDraft = (v: LifecycleVersion) => navigate(orgPath.version(org, v.automationVersionId!));

  // permissões não conferidas (ex.: 429 ou rede) não são "sem permissão": a pessoa pode tentar de novo
  if (perms.status === 'unknown') {
    return (
      <Stack gap={5}>
        <PageHeader title="Nova versão" subtitle={a.name} back={back} />
        <StateView
          status="warning"
          title="Não foi possível conferir suas permissões agora."
          description="Nada foi criado. Recarregue a página em alguns instantes para tentar de novo."
        />
      </Stack>
    );
  }
  if (perms.status !== 'ready' || !perms.has('automation.manage') || a.status !== 'active') {
    return (
      <Stack gap={5}>
        <PageHeader title="Nova versão" subtitle={a.name} back={back} />
        <StateView status="neutral" title={a.status !== 'active' ? 'A automação não está ativa.' : 'Você não tem permissão para criar versões nesta automação.'} />
      </Stack>
    );
  }

  // um rascunho por automação: com um existente (ou criado por outra aba enquanto a pessoa preenchia), leva a ele
  const other = phase.kind === 'superseded' ? phase.draft : phase.kind === 'idle' || phase.kind === 'checked' ? existing.data : null;
  if (other) {
    return (
      <Stack gap={5}>
        <PageHeader title="Nova versão" subtitle={a.name} back={back} />
        <Alert tone={phase.kind === 'superseded' ? 'warning' : 'info'} title={`Esta automação já tem um rascunho: a versão ${other.versionNumber ?? ''}.`}>
          <Stack gap={2}>
            <span>
              {phase.kind === 'superseded' && phase.comparable && (
                <>
                  O seu envio não criou outra versão nem sobrescreveu nada: enquanto você preenchia, outra aba ou pessoa criou
                  este rascunho.{' '}
                </>
              )}
              {phase.kind === 'superseded' && !phase.comparable && (
                <>Este navegador não calculou o SHA-256 do seu arquivo, então não dá para saber se o rascunho tem o seu pacote. </>
              )}
              Ele tem <PackageBrief artifact={other.artifact} />. Cada automação tem no máximo um rascunho: continue nele e, se
              quiser, envie lá o seu arquivo.
            </span>
            <span>
              <Button size="sm" onClick={() => openDraft(other)}>
                Continuar rascunho
              </Button>
            </span>
          </Stack>
        </Alert>
      </Stack>
    );
  }

  const busy = phase.kind === 'sending';
  const blocked = phase.kind === 'uncertain';
  const canSend = !!file && !fileProblem && !busy && !blocked;

  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(null);
    setLocalHash(null);
    setFileProblem(undefined);
    if (phase.kind === 'refused' || phase.kind === 'checked') setPhase({ kind: 'idle' });
    if (!f) return;
    // tamanho e tipo recusados antes de qualquer envio
    if (f.size === 0) return setFileProblem('O arquivo está vazio.');
    if (f.size > ARTIFACT_MAX_BYTES) return setFileProblem(`O arquivo tem ${mib(f.size)}; o limite é 50 MiB. Nada foi criado.`);
    if (!/\.zip$/i.test(f.name)) return setFileProblem('Escolha o arquivo .zip do pacote.');
    setFile(f);
    setLocalHash(await localSha256(f).catch(() => null));
  };

  const accepted = (v: LifecycleVersion) => navigate(orgPath.version(org, v.automationVersionId!), { replace: true, state: { draftCreated: true } });

  /** O rascunho que existe agora: é o deste envio (mesmo SHA-256)? */
  const settle = (draft: LifecycleVersion | null, none: string) => {
    if (!draft) return setPhase({ kind: 'checked', text: none });
    if (localHash && draft.artifact?.sha256 === localHash) return accepted(draft);
    setPhase({ kind: 'superseded', draft, comparable: !!localHash });
  };

  const send = async () => {
    if (running.current || !canSend || !file) return;
    const command = checkCommand(runtime, args);
    if (!command.ok) return setCommandProblem(command.text);
    setCommandProblem(null);
    running.current = true;
    setPhase({ kind: 'sending', sent: 0, total: file.size });
    // sem expectativa de rascunho: o ZIP aceito cria a versão; existindo um rascunho, a API recusa (409) sem sobrescrever
    const h = uploadDraftPackage(org, automationId, file, { runtime: command.runtime, arguments: command.arguments }, (sent, total) =>
      setPhase({ kind: 'sending', sent, total }),
    );
    handle.current = h;
    try {
      accepted(await h.promise);
    } catch (e) {
      const outcome = uploadOutcome(e);
      if (outcome === 'expired') return expired();
      if (hasReason(e, 'conflict', 'draft_changed')) {
        try {
          return settle(await readAutomationDraft(org, automationId), 'O envio não foi aplicado e a automação não tem rascunho agora. Nada foi criado; você pode enviar de novo.');
        } catch (re) {
          if (isApiError(re, 'unauthenticated')) return expired();
          return setPhase({ kind: 'refused', text: 'Outra aba ou pessoa mudou o rascunho desta automação; o seu envio não foi aplicado. Volte à automação e confira.' });
        }
      }
      setPhase(outcome === 'uncertain' ? { kind: 'uncertain' } : { kind: 'refused', text: draftRefusal(e, 'nothing') });
    } finally {
      handle.current = null;
      running.current = false;
    }
  };

  /** Resposta perdida: lê o rascunho da automação; é o deste envio se o SHA-256 do servidor for o dos bytes locais. */
  const reconcile = async () => {
    try {
      settle(await readAutomationDraft(org, automationId), 'Conferido: o pacote não chegou e nenhuma versão foi criada. Você pode enviar de novo.');
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      // a leitura falhou: continua sem saber; nada é liberado
    }
  };

  const pct = phase.kind === 'sending' ? Math.round((phase.sent / Math.max(phase.total, 1)) * 100) : 0;

  return (
    <Stack gap={5}>
      <PageHeader title="Nova versão" subtitle={a.name} back={back} />
      <Text color="secondary">
        Abrir ou sair desta página não cria nada. A versão passa a existir quando a Platform aceita o pacote: a partir daí ela já
        está salva como rascunho, mesmo que você volte ou feche a aba. Nada é publicado nem executado aqui.
      </Text>
      <Card variant="outlined" padding="lg">
        <form
          className="pw-identity__form"
          noValidate
          aria-busy={busy || undefined}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {commandProblem && <Alert tone="danger">{commandProblem}</Alert>}
          <Input label="Ambiente de execução" value={runtime} onChange={(e) => setRuntime(e.target.value)} hint="Formato python3.N. Em branco: python3.12." readOnly={busy} />
          <Textarea label="Argumentos (um por linha)" value={args} onChange={(e) => setArgs(e.target.value)} hint="Até 20, cada um com até 200 caracteres." readOnly={busy} />
          {/* campo de arquivo com as classes do Field da lib (o Input da lib controla `value`, proibido em type=file) */}
          <div className="nk-field">
            <label className="nk-field__label" htmlFor="pw-nova-versao-pacote">
              Arquivo .zip do pacote
            </label>
            <input
              id="pw-nova-versao-pacote"
              className="pw-file"
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => void choose(e)}
              // com resultado desconhecido, escolher outro arquivo reabriria o envio sem a conferência
              disabled={busy || blocked}
              aria-invalid={fileProblem ? true : undefined}
              aria-describedby="pw-nova-versao-pacote-message"
            />
            <p id="pw-nova-versao-pacote-message" className={fileProblem ? 'nk-field__message nk-field__message--error' : 'nk-field__message'}>
              {fileProblem ?? 'Até 50 MiB. Escolher o arquivo não envia nada; a Platform confere o pacote quando você enviar.'}
            </p>
          </div>
          {file && (
            <Text variant="body-sm">
              {file.name} · {mib(file.size)}
            </Text>
          )}
          {phase.kind === 'sending' && (
            <div className="pw-upload" role="status">
              <span>Enviando o pacote…</span>
              <progress aria-label="Envio do pacote" max={phase.total} value={phase.sent}>
                {pct}%
              </progress>
              <span aria-live="polite">{pct}%</span>
              <Button size="sm" variant="ghost" onClick={() => handle.current?.abort()}>
                Interromper
              </Button>
            </div>
          )}
          {phase.kind === 'refused' && <Alert tone="danger">{phase.text}</Alert>}
          {phase.kind === 'checked' && <Alert tone="info">{phase.text}</Alert>}
          {phase.kind === 'uncertain' && (
            <Alert tone="warning" title="Não foi possível confirmar o resultado.">
              <Stack gap={2}>
                <span>Os bytes do pacote podem ter chegado e criado o rascunho. Nada é reenviado automaticamente: confira antes de tentar de novo.</span>
                <span>
                  <Button size="sm" variant="secondary" onClick={() => void reconcile()}>
                    Conferir agora
                  </Button>
                </span>
              </Stack>
            </Alert>
          )}
          <div>
            <Button type="submit" disabled={!canSend} loading={busy}>
              Enviar o pacote e criar o rascunho
            </Button>
          </div>
        </form>
      </Card>
    </Stack>
  );
}
