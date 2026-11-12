import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';
import { Alert, Button, Card, DescriptionList, Input, Link, RadioGroup, Stack, StateView, Text } from 'nekkora-lib';
import { ApiError, hasReason, isApiError } from '../../api/http';
import { ARTIFACT_MAX_BYTES, createAutomation, localSha256, readAutomationDraft, uploadDraftPackage, type LifecycleVersion, type UploadHandle } from '../../api/lifecycle';
import { NO_TAB_LOCK_TEXT, operations, opKey, type OpView } from '../../api/pendingOps';
import { getWorkspace, listAutomations } from '../../api/product';
import { useOperationScope } from '../../components/operationScope';
import { useSession } from '../../area/session';
import { useWorkspacePermissions } from '../../area/useWorkspacePermissions';
import { PermissionsUnverified } from '../../area/PermissionsUnverified';
import { orgPath } from '../../auth/organization';
import { useResource } from '../../hooks/useResource';
import { DateTimeText, LoadErrorState, NotFoundState, PageHeader, isMissing } from './shared';
import { uploadOutcome } from './uploadOutcome';
import { draftRefusal, mib, packageReason, PackageBrief } from './draftPackage';
import './shared.css';
import '../../identity/identity.css';

/**
 * PLATFORM-V2-001, T04 — criar automação com a primeira versão e o ZIP, no mesmo fluxo:
 *   só o nome (rascunho)  -> POST automação -> página da automação;
 *   nome + ZIP            -> POST automação -> PUT do ZIP no rascunho da automação (T09) -> metadados conferidos pela
 *                            Platform -> "Revisar e publicar" (página da versão). Nada é publicado nem executado aqui.
 * PLATFORM-AGENT-V2-002, T09: a versão só passa a existir quando a Platform ACEITA o ZIP (o PUT, sem expectativa de
 * rascunho, cria a versão DRAFT 1 com o pacote numa só transação). ZIP recusado: a automação (já criada) fica sem versão e
 * "Continuar" reenvia à MESMA automação. A automação criada fica guardada EM MEMÓRIA nesta aba: falha depois dela RETOMA
 * a mesma automação, inclusive ao sair e voltar à página. Nada vai para o armazenamento do navegador (§39/§40): depois de
 * recarregar, a automação continua na API (a página dela oferece "Nova versão"). Resultado desconhecido (sem resposta,
 * 5xx): a tela RECONCILIA lendo a API antes de permitir outra tentativa; nunca reenvia sozinha. A criação da automação usa
 * o registro de operações incertas (FRONT-V1-002, só resumo e estado): a incerteza sobrevive a recarga e a outra aba até a
 * pessoa conferir.
 */

type Mode = 'draft' | 'version';

interface Progress {
  name: string;
  mode: Mode;
  startedAt: number;
  automationId?: string;
}

type Step = 'automation' | 'upload';

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; step: Step; sent?: number; total?: number }
  /** Passo com resultado desconhecido: só a conferência (leitura da API) libera outra tentativa. */
  | { kind: 'uncertain'; step: Step }
  | { kind: 'refused'; text: string }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'checked'; text: string }
  /** A automação já tem um rascunho que não é o deste envio (outra aba ou pessoa): leva a ele, sem sobrescrever. */
  | { kind: 'foreign'; draft: LifecycleVersion }
  | { kind: 'done'; version: LifecycleVersion };

const NAME_MAX = 80;
const RECONCILE_SLACK_MS = 2 * 60_000;
/** Progresso por organização e workspace, só em memória (some ao recarregar ou sair da conta). */
const memory = new Map<string, Progress>();
const memoryKey = (org: string, ws: string) => `${org}:${ws}`;
const readProgress = (org: string, ws: string): Progress | null => memory.get(memoryKey(org, ws)) ?? null;
function writeProgress(org: string, ws: string, p: Progress | null) {
  if (p) memory.set(memoryKey(org, ws), p);
  else memory.delete(memoryKey(org, ws));
}
/** Só para testes: simula recarregar a página (memória limpa). */
export function resetNewAutomationMemoryForTest() {
  memory.clear();
}

const uncertainError = (e: unknown) => e instanceof ApiError && (e.code === 'network' || e.code === 'unexpected' || e.code === 'internal_error' || e.code === 'gateway');

function refusalText(step: Step, e: unknown): string {
  if (step === 'upload') {
    const reason = packageReason(e);
    if (reason)
      return `O pacote foi recusado pela conferência da Platform: ${reason}. A automação foi criada, mas nenhuma versão: a versão só passa a existir quando a Platform aceita o pacote. Escolha o arquivo corrigido e continue: o envio vai para esta mesma automação.`;
    return draftRefusal(e, 'nothing');
  }
  if (isApiError(e, 'conflict')) return 'O workspace não está ativo. Nada foi criado.';
  if (isApiError(e, 'forbidden', 'not_found')) return 'Você não tem permissão para criar automações neste workspace. Nada foi criado.';
  if (isApiError(e, 'rate_limited')) return 'Muitas tentativas em pouco tempo. Aguarde e tente de novo. Nada foi criado.';
  if (isApiError(e, 'invalid_request')) return 'O pedido não foi aceito. Confira o nome. Nada foi criado.';
  return 'A automação não foi criada.';
}

export function NewAutomationPage() {
  const { org, expired } = useSession();
  const { workspaceId = '' } = useParams();
  const navigate = useNavigate();
  const workspace = useResource(() => getWorkspace(org, workspaceId), [org, workspaceId]);
  const perms = useWorkspacePermissions(workspaceId);

  const [progress, setProgressState] = useState<Progress | null>(() => readProgress(org, workspaceId));
  const [name, setName] = useState(progress?.name ?? '');
  const [mode, setMode] = useState<Mode>(progress?.mode ?? 'version');
  const [file, setFile] = useState<File | null>(null);
  const [localHash, setLocalHash] = useState<string | null>(null);
  const [fileProblem, setFileProblem] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const running = useRef(false);
  const upload = useRef<UploadHandle | null>(null);
  useEffect(() => () => upload.current?.abort(), []);

  // registro da criação (FRONT-V1-002): mesma operação do diálogo anterior, por pessoa, organização e workspace
  const scope = useOperationScope();
  const [guard, setGuard] = useState<{ key: string; view: OpView | null } | 'no-locks' | 'unavailable' | null>(null);
  useEffect(() => {
    if (!operations().exclusive()) return setGuard('no-locks');
    let current = true;
    let key: string | null = null;
    const refresh = async () => {
      if (!key) {
        const subject = await scope.subject();
        if (!current) return;
        if (!subject) return setGuard('unavailable');
        key = await opKey({ subject, org: scope.org, operation: 'automation.create', target: workspaceId });
      }
      const view = await operations().inspect(key);
      if (current) setGuard({ key, view });
    };
    void refresh();
    const stop = operations().subscribe(() => void refresh());
    return () => {
      current = false;
      stop();
    };
  }, [scope, workspaceId]);

  const setProgress = (p: Progress | null) => {
    writeProgress(org, workspaceId, p);
    setProgressState(p);
  };

  if (workspace.status === 'loading' || perms.status === 'loading') return <StateView status="loading" title="Carregando workspace…" />;
  if (workspace.status === 'error') {
    if (isApiError(workspace.error, 'unauthenticated')) {
      expired();
      return null;
    }
    if (isMissing(workspace.error)) return <NotFoundState title="Workspace não encontrado." back={{ to: orgPath.workspaces(org), label: 'Voltar para workspaces' }} />;
    return <LoadErrorState error={workspace.error} onRetry={workspace.refresh} page />;
  }
  const w = workspace.data;
  const back = { to: orgPath.workspace(org, workspaceId), label: `Voltar para ${w.name}` };
  // permissões não conferidas (429, rede) não são "sem permissão": diz que não conferiu e deixa tentar de novo
  if (perms.status === 'unknown' && w.status === 'active') {
    return (
      <Stack gap={5}>
        <PageHeader title="Nova automação" subtitle={w.name} back={back} />
        <PermissionsUnverified actions="O formulário de criação e o envio do pacote" onRetry={perms.retry} />
      </Stack>
    );
  }
  if (perms.status !== 'ready' || !perms.has('automation.manage') || w.status !== 'active') {
    return (
      <Stack gap={5}>
        <PageHeader title="Nova automação" subtitle={w.name} back={back} />
        <StateView status="neutral" title={w.status !== 'active' ? 'O workspace não está ativo.' : 'Você não tem permissão para criar automações neste workspace.'} />
      </Stack>
    );
  }

  const trimmed = name.trim();
  const nameOk = trimmed.length > 0 && [...trimmed].length <= NAME_MAX;
  const locked = !!progress?.automationId; // depois do primeiro passo confirmado, nome e caminho ficam fixos
  const busy = phase.kind === 'working';
  const recorded = guard && typeof guard === 'object' ? guard.view : null;
  // incerteza registrada (outra aba, ou antes de recarregar) sem o progresso desta tela: só a conferência explícita libera
  const recordBlocks = !progress?.automationId && phase.kind !== 'working' && (recorded?.state === 'unknown' || recorded?.state === 'pending');
  const guardBlocks = !progress?.automationId && (guard === null || guard === 'no-locks' || guard === 'unavailable');
  const blocked = phase.kind === 'uncertain' || phase.kind === 'ambiguous' || phase.kind === 'foreign' || recordBlocks || guardBlocks;
  const needsFile = mode === 'version';
  const canStart = nameOk && !busy && !blocked && phase.kind !== 'done' && (!needsFile || (!!file && !fileProblem));

  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(null);
    setLocalHash(null);
    setFileProblem(undefined);
    if (phase.kind === 'refused' || phase.kind === 'checked') setPhase({ kind: 'idle' });
    if (!f) return;
    // recusa de tamanho e de tipo ANTES de qualquer gravação
    if (f.size === 0) return setFileProblem('O arquivo está vazio.');
    if (f.size > ARTIFACT_MAX_BYTES) return setFileProblem(`O arquivo tem ${mib(f.size)}; o limite é 50 MiB. Nada foi criado.`);
    if (!/\.zip$/i.test(f.name)) return setFileProblem('Escolha o arquivo .zip do pacote.');
    setFile(f);
    setLocalHash(await localSha256(f).catch(() => null));
  };

  /** Executa os passos que faltam, a partir do que já está confirmado. Um passo por vez; nunca repete sozinho. */
  const run = async () => {
    if (running.current || !canStart) return;
    running.current = true;
    let p: Progress = progress ?? { name: trimmed, mode, startedAt: Date.now() };
    try {
      if (!p.automationId) {
        if (!guard || typeof guard !== 'object') return;
        const begun = await operations().begin(guard.key);
        if (!begun.ok) return setPhase({ kind: 'refused', text: begun.reason === 'storage'
          ? 'Este navegador não permitiu registrar a operação antes do envio. Nada foi enviado.'
          : begun.reason === 'no-locks' ? NO_TAB_LOCK_TEXT : 'Há uma tentativa anterior desta criação sem resultado confirmado. Confira antes de tentar de novo.' });
        setProgress(p); // a intenção fica registrada ANTES do envio: o resultado desconhecido é reconciliado depois
        setPhase({ kind: 'working', step: 'automation' });
        try {
          const a = await createAutomation(org, workspaceId, p.name);
          begun.finish('confirmed');
          p = { ...p, automationId: a.automationId! };
          setProgress(p);
        } catch (e) {
          begun.finish(uncertainError(e) ? 'unknown' : 'refused');
          return fail('automation', e);
        }
        if (p.mode === 'draft') {
          setProgress(null);
          navigate(orgPath.automation(org, p.automationId!));
          return;
        }
      }
      if (!file) return setPhase({ kind: 'idle' });
      setPhase({ kind: 'working', step: 'upload', sent: 0, total: file.size });
      // sem expectativa de rascunho: o ZIP aceito cria a versão 1; existindo um rascunho, a API recusa (409) sem sobrescrever
      const h = uploadDraftPackage(org, p.automationId!, file, {}, (sent, total) => setPhase({ kind: 'working', step: 'upload', sent, total }));
      upload.current = h;
      try {
        const v = await h.promise;
        setProgress(null);
        setPhase({ kind: 'done', version: v });
      } catch (e) {
        const outcome = uploadOutcome(e);
        if (outcome === 'expired') return expired();
        if (outcome === 'uncertain') return setPhase({ kind: 'uncertain', step: 'upload' });
        if (hasReason(e, 'conflict', 'draft_changed')) {
          const draft = await readAutomationDraft(org, p.automationId!).catch(() => undefined);
          if (draft !== undefined) return settle(draft, 'O envio não foi aplicado e a automação continua sem versão. Você pode enviar de novo.');
        }
        setFile(null);
        setLocalHash(null);
        return setPhase({ kind: 'refused', text: refusalText('upload', e) });
      } finally {
        upload.current = null;
      }
    } finally {
      running.current = false;
    }
  };

  const fail = (step: 'automation', e: unknown) => {
    if (isApiError(e, 'unauthenticated')) return expired();
    if (uncertainError(e)) return setPhase({ kind: 'uncertain', step });
    setProgress(null); // recusa documentada: nada criado, nada a retomar
    setPhase({ kind: 'refused', text: refusalText(step, e) });
  };

  /** O rascunho que a automação tem agora: é o deste envio (mesmo SHA-256)? Nunca sobrescreve outro. */
  const settle = (draft: LifecycleVersion | null, none: string) => {
    if (!draft) return setPhase({ kind: 'checked', text: none });
    if (localHash && draft.artifact?.sha256 === localHash) {
      setProgress(null);
      return setPhase({ kind: 'done', version: draft });
    }
    setPhase({ kind: 'foreign', draft });
  };

  /** Conferência do passo com resultado desconhecido, pela leitura da API. */
  const reconcile = async () => {
    if (phase.kind !== 'uncertain' || !progress) return;
    const step = phase.step;
    try {
      if (step === 'automation') {
        const found: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await listAutomations(org, workspaceId, { limit: 100, cursor });
          for (const a of page.items ?? [])
            if (a.name === progress.name && a.createdAt && Date.parse(a.createdAt) >= progress.startedAt - RECONCILE_SLACK_MS) found.push(a.automationId!);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (found.length > 1) return setPhase({ kind: 'ambiguous', count: found.length });
        if (guard && typeof guard === 'object') operations().acknowledge(guard.key);
        if (found.length === 1) {
          const p = { ...progress, automationId: found[0] };
          setProgress(p);
          if (p.mode === 'draft') {
            setProgress(null);
            navigate(orgPath.automation(org, found[0]));
            return;
          }
          return setPhase({ kind: 'checked', text: 'Conferido: a automação foi criada. Continue para enviar o pacote; a versão 1 nasce quando a Platform aceitá-lo.' });
        }
        return setPhase({ kind: 'checked', text: 'Conferido: a automação não foi criada. Você pode tentar de novo.' });
      }
      // envio sem resposta: o rascunho da automação, se houver, é o deste envio quando o SHA-256 confere
      return settle(await readAutomationDraft(org, progress.automationId!), 'Conferido: o pacote não chegou e nenhuma versão foi criada. Você pode enviar de novo.');
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      // a leitura falhou: continua sem saber; nada é liberado
    }
  };

  const discard = () => {
    setProgress(null);
    setPhase({ kind: 'idle' });
    setName('');
    setFile(null);
    setLocalHash(null);
  };

  const pct = phase.kind === 'working' && phase.total ? Math.round(((phase.sent ?? 0) / Math.max(phase.total, 1)) * 100) : 0;
  const stepText = phase.kind === 'working' ? { automation: 'Criando a automação…', upload: 'Enviando o pacote…' }[phase.step] : null;

  if (phase.kind === 'done') {
    const v = phase.version;
    const a = v.artifact;
    return (
      <Stack gap={5}>
        <PageHeader title="Nova automação" subtitle={w.name} back={back} />
        <Alert tone="success" title="Pacote recebido e conferido pela Platform.">
          A automação e a versão {v.versionNumber} estão em rascunho. Nada foi publicado nem executado.
        </Alert>
        <Card variant="outlined" padding="lg">
          <Stack gap={3}>
            <DescriptionList
              items={[
                { key: 'nome', term: 'Automação', description: progress?.name ?? trimmed },
                { key: 'versao', term: 'Versão na Platform', description: `Versão ${v.versionNumber ?? 1} (rascunho)` },
                { key: 'tipo', term: 'Tipo do pacote', description: a?.packageKind === 'EXTERNAL_PYTHON' ? 'Python externo (sem framework Nekkora)' : 'Formato Studio' },
                ...(a?.packageKind === 'EXTERNAL_PYTHON'
                  ? [
                      { key: 'proj', term: 'Versão declarada pelo projeto', description: `${a.packageName ?? '—'} ${a.packageVersion ?? ''}`.trim() },
                      { key: 'py', term: 'Python exigido (declarado)', description: a.pythonRequirement ?? '—' },
                    ]
                  : [{ key: 'man', term: 'Manifesto do Studio', description: a?.manifestVersion ?? '—' }]),
                { key: 'entrada', term: 'Arquivo de entrada', description: v.entrypoint ?? '—' },
                { key: 'arqs', term: 'Arquivos', description: a?.filesCount ?? '—' },
                { key: 'recebido', term: 'Recebido em', description: <DateTimeText iso={a?.receivedAt} /> },
              ]}
            />
            <Text variant="body-sm" color="secondary">
              Esses dados vêm da conferência da Platform: não é preciso digitá-los. A versão na Platform é a numeração desta
              automação; a versão declarada é a que o projeto informa no pacote.
            </Text>
            <div>
              <Button onClick={() => navigate(orgPath.version(org, v.automationVersionId!))}>Revisar e publicar</Button>
            </div>
          </Stack>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack gap={5}>
      <PageHeader title="Nova automação" subtitle={w.name} back={back} />
      {recordBlocks && guard && typeof guard === 'object' && (
        <Alert tone="warning" title="Resultado não confirmado">
          <Stack gap={2}>
            <span>
              Uma tentativa de criar automação neste workspace, às {new Date(recorded!.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })},
              ficou sem resposta confirmada (nesta ou em outra aba). Nada é repetido automaticamente. Confira as automações do
              workspace antes de criar de novo.
            </span>
            <span>
              <Link as={RouterLink} to={orgPath.workspace(org, workspaceId)}>
                Abrir o workspace
              </Link>
              {' · '}
              <Button size="sm" variant="secondary" onClick={() => operations().acknowledge(guard.key)}>
                Já conferi o estado atual; liberar nova tentativa
              </Button>
            </span>
          </Stack>
        </Alert>
      )}
      {guard === 'no-locks' && !progress?.automationId && <Alert tone="warning">{NO_TAB_LOCK_TEXT}</Alert>}
      {locked && phase.kind !== 'working' && (
        <Alert tone="info" title={`Rascunho em andamento: ${progress!.name}`}>
          <Stack gap={2}>
            <span>
              A automação já foi criada, ainda sem versão. Escolha o arquivo .zip e continue: o envio vai para esta mesma
              automação, e a versão 1 passa a existir quando a Platform aceitar o pacote.
            </span>
            <span>
              <Link as={RouterLink} to={orgPath.automation(org, progress!.automationId!)}>
                Abrir a automação
              </Link>
              {' · '}
              <Button size="sm" variant="ghost" onClick={discard}>
                Começar outra automação
              </Button>
            </span>
          </Stack>
        </Alert>
      )}
      <Card variant="outlined" padding="lg">
        <form
          className="pw-identity__form"
          noValidate
          aria-busy={busy || undefined}
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <Input
            label="Nome da automação"
            required
            fullWidth
            maxLength={NAME_MAX}
            value={name}
            onChange={(e) => setName(e.target.value)}
            hint="Até 80 caracteres."
            readOnly={locked || busy}
          />
          <RadioGroup
            legend="Como criar"
            value={mode}
            onChange={(v) => !locked && !busy && setMode(v as Mode)}
            options={[
              { value: 'version', label: 'Nome e primeira versão, com o pacote .zip (segue para revisar e publicar)' },
              { value: 'draft', label: 'Só o nome, como rascunho (o pacote fica para depois)' },
            ]}
          />
          {mode === 'version' && (
            <div className="nk-field">
              <label className="nk-field__label" htmlFor="pw-nova-pacote">
                Arquivo .zip do pacote
              </label>
              <input
                id="pw-nova-pacote"
                className="pw-file"
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => void choose(e)}
                disabled={busy || blocked}
                aria-invalid={fileProblem ? true : undefined}
                aria-describedby="pw-nova-pacote-message"
              />
              <p id="pw-nova-pacote-message" className={fileProblem ? 'nk-field__message nk-field__message--error' : 'nk-field__message'}>
                {fileProblem ?? 'Até 50 MiB. Formato Studio ou Python externo; a Platform confere o pacote e mostra o que ele declara.'}
              </p>
            </div>
          )}
          {file && (
            <Text variant="body-sm">
              {file.name} · {mib(file.size)}
            </Text>
          )}
          {phase.kind === 'working' && (
            <div className="pw-upload" role="status">
              <span>{stepText}</span>
              {phase.step === 'upload' && (
                <>
                  <progress aria-label="Envio do pacote" max={phase.total} value={phase.sent}>
                    {pct}%
                  </progress>
                  <span aria-live="polite">{pct}%</span>
                </>
              )}
            </div>
          )}
          {phase.kind === 'refused' && <Alert tone="danger">{phase.text}</Alert>}
          {phase.kind === 'checked' && <Alert tone="info">{phase.text}</Alert>}
          {phase.kind === 'foreign' && (
            <Alert tone="warning" title={`A automação já tem um rascunho: a versão ${phase.draft.versionNumber ?? ''}.`}>
              <Stack gap={2}>
                <span>
                  {localHash
                    ? 'Ele não tem o pacote deste arquivo (outra aba ou pessoa o criou). '
                    : 'Este navegador não calculou o SHA-256 do arquivo, então não dá para saber se o rascunho tem o seu pacote. '}
                  Ele tem <PackageBrief artifact={phase.draft.artifact} />. Nada foi sobrescrito: continue nele.
                </span>
                <span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setProgress(null);
                      navigate(orgPath.version(org, phase.draft.automationVersionId!));
                    }}
                  >
                    Continuar rascunho
                  </Button>
                </span>
              </Stack>
            </Alert>
          )}
          {phase.kind === 'uncertain' && (
            <Alert tone="warning" title="Não foi possível confirmar o resultado.">
              <Stack gap={2}>
                <span>
                  {phase.step === 'automation' ? 'A automação pode ter sido criada.' : 'Os bytes do pacote podem ter chegado e criado a versão.'}{' '}
                  Nada é repetido automaticamente: confira antes de tentar de novo.
                </span>
                <span>
                  <Button size="sm" variant="secondary" onClick={() => void reconcile()}>
                    Conferir agora
                  </Button>
                </span>
              </Stack>
            </Alert>
          )}
          {phase.kind === 'ambiguous' && (
            <Alert tone="warning" title="Há mais de um registro possível.">
              Encontramos {phase.count} registros com este nome criados agora há pouco. Abra o workspace e confira qual usar; esta tela não escolhe por você.
            </Alert>
          )}
          <div>
            <Button type="submit" disabled={!canStart} loading={busy}>
              {mode === 'draft' ? 'Salvar rascunho' : locked ? 'Continuar' : 'Criar e enviar o pacote'}
            </Button>
          </div>
        </form>
      </Card>
    </Stack>
  );
}
