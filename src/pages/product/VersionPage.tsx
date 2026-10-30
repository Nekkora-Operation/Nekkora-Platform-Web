import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link as RouterLink, useParams } from 'react-router';
import { Alert, Badge, Button, Card, Checkbox, DescriptionList, Heading, Input, Link, Stack, StateView, Text, Textarea } from 'nekkora-lib';
import { ApiError, isApiError } from '../../api/http';
import {
  ARTIFACT_MAX_BYTES,
  getAutomationVersion,
  localSha256,
  PACKAGE_REASON,
  publishAutomationVersion,
  updateAutomationVersionDraft,
  uploadArtifact,
  type LifecycleVersion,
  type PackageRejectedReason,
  type UploadHandle,
} from '../../api/lifecycle';
import { getAutomation } from '../../api/product';
import { useSession } from '../../area/session';
import { useWorkspacePermissions } from '../../area/useWorkspacePermissions';
import { orgPath } from '../../auth/organization';
import { StepUpDialog } from '../../components/StepUpDialog';
import { useResource } from '../../hooks/useResource';
import { orgStepUp } from '../access/shared';
import { LocalRunAuthorizations } from '../agents/LocalRunAuthorizations';
import { DateTimeText, LoadErrorState, NotFoundState, PageHeader, isMissing } from './shared';
import { uploadOutcome } from './uploadOutcome';
import './shared.css';
import '../../identity/identity.css';

type Upload =
  | { phase: 'idle' }
  | { phase: 'sending'; sent: number; total: number }
  | { phase: 'done' }
  | { phase: 'refused'; text: string }
  | { phase: 'uncertain' }
  /** `unknown`: sem SHA-256 local (Web Crypto indisponível) não há como comparar; mostra o que a Platform tem. */
  | { phase: 'reconciled'; arrived: 'yes' | 'no' | 'unknown'; serverSha256?: string | null };

const mib = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MiB`;

function uploadRefusal(e: unknown): string {
  if (e instanceof ApiError && e.code === 'package_rejected') {
    const reason = e.reason ? PACKAGE_REASON[e.reason as PackageRejectedReason] : undefined;
    return `O pacote foi recusado pela conferência da Platform: ${reason ?? 'motivo não informado'}. A versão continua como estava.`;
  }
  if (isApiError(e, 'service_unavailable'))
    return 'O armazenamento de pacotes não está disponível neste ambiente (ou está temporariamente fora). Nada foi gravado; tente mais tarde ou procure a operação.';
  if (isApiError(e, 'conflict')) return 'Esta versão já foi publicada e não aceita pacote novo. Crie uma nova versão.';
  if (isApiError(e, 'forbidden', 'not_found')) return 'Você não tem permissão para enviar pacotes nesta automação. Nada foi gravado.';
  if (isApiError(e, 'rate_limited')) return 'Muitas tentativas em pouco tempo. Aguarde antes de enviar de novo.';
  if (e instanceof ApiError && e.status === 413) return 'O arquivo passa do limite aceito (50 MiB). Nada foi gravado.';
  return 'O envio não foi aceito. A versão continua como estava.';
}

/** Linha "valor técnico" (hash, impressão): monoespaçado, quebrável, copiável por seleção. */
function Hash({ value }: { value: string | null | undefined }) {
  return value ? <code className="pw-break pw-hash">{value}</code> : <span className="pw-prod__muted">—</span>;
}

/**
 * /o/{org}/versoes/:versionId — versão da automação (detalhe do ciclo de vida). Rascunho: comando, pacote e publicação.
 * Publicada: imutável (mudança = nova versão). Publicar NÃO executa nem autoriza execução.
 */
export function VersionPage() {
  const { org, expired } = useSession();
  const { versionId = '' } = useParams();
  const version = useResource(() => getAutomationVersion(org, versionId), [org, versionId]);
  const v = version.status === 'ready' ? version.data : undefined;
  const automation = useResource(() => (v ? getAutomation(org, v.automationId!) : new Promise<never>(() => {})), [org, v?.automationId]);
  const perms = useWorkspacePermissions(v?.workspaceId);
  const can = (p: 'automation.manage' | 'automation.publish') => perms.status === 'ready' && perms.has(p);

  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | undefined>();
  const [localHash, setLocalHash] = useState<string | null>(null);
  const [upload, setUpload] = useState<Upload>({ phase: 'idle' });
  const handle = useRef<UploadHandle | null>(null);
  const [runtime, setRuntime] = useState('');
  const [args, setArgs] = useState('');
  const [draftMsg, setDraftMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reviewed, setReviewed] = useState<{ sha256: string; fingerprint: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [expectedFp, setExpectedFp] = useState('');
  const [publishMsg, setPublishMsg] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    if (!v) return;
    setRuntime(v.runtime ?? '');
    setArgs((v.arguments ?? []).join('\n'));
  }, [v?.automationVersionId, v?.runtime, v?.arguments?.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps

  // sair da página interrompe o envio no navegador (o resultado pode ser conferido ao voltar)
  useEffect(() => () => handle.current?.abort(), []);

  if (version.status === 'loading') return <StateView status="loading" title="Carregando versão…" />;
  if (version.status === 'error') {
    if (isApiError(version.error, 'unauthenticated')) {
      expired();
      return null;
    }
    if (isMissing(version.error)) return <NotFoundState title="Versão não encontrada." back={{ to: orgPath.workspaces(org), label: 'Voltar para workspaces' }} />;
    return <LoadErrorState error={version.error} onRetry={version.refresh} page />;
  }

  const data = version.data;
  const draft = data.status === 'DRAFT';
  const art = data.artifact ?? null;
  const name = automation.status === 'ready' ? automation.data.name : 'Automação';
  const back = { to: orgPath.automation(org, data.automationId!), label: `Voltar para ${name}` };

  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setUpload({ phase: 'idle' });
    setLocalHash(null);
    setFile(null);
    setFileProblem(undefined);
    if (!f) return;
    if (f.size === 0) return setFileProblem('O arquivo está vazio.');
    if (f.size > ARTIFACT_MAX_BYTES) return setFileProblem(`O arquivo tem ${mib(f.size)}; o limite é 50 MiB.`);
    if (!/\.zip$/i.test(f.name)) return setFileProblem('Escolha o arquivo .zip do pacote.');
    setFile(f);
    setLocalHash(await localSha256(f).catch(() => null));
  };

  const send = () => {
    if (!file || upload.phase === 'sending') return;
    setUpload({ phase: 'sending', sent: 0, total: file.size });
    const h = uploadArtifact(org, versionId, file, (sent, total) => setUpload({ phase: 'sending', sent, total }));
    handle.current = h;
    h.promise
      .then(() => {
        setUpload({ phase: 'done' });
        version.refresh();
      })
      .catch((e) => {
        const outcome = uploadOutcome(e);
        if (outcome === 'expired') return expired();
        setUpload(outcome === 'uncertain' ? { phase: 'uncertain' } : { phase: 'refused', text: uploadRefusal(e) });
      })
      .finally(() => {
        handle.current = null;
      });
  };

  /** Conferência depois de envio interrompido: lê a versão de novo; chegou se o sha256 do servidor for o dos bytes locais. */
  const reconcile = async () => {
    try {
      const fresh = await getAutomationVersion(org, versionId);
      version.refresh();
      const serverSha256 = fresh.artifact?.sha256 ?? null;
      const arrived = !localHash ? 'unknown' : serverSha256 === localHash ? 'yes' : 'no';
      setUpload({ phase: 'reconciled', arrived, serverSha256 });
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      setUpload({ phase: 'uncertain' });
    }
  };

  const saveDraft = async () => {
    const list = args
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean);
    if (runtime && !/^python3\.[0-9]{1,2}$/.test(runtime)) return setDraftMsg({ tone: 'danger', text: 'Use o formato python3.N (por exemplo, python3.12).' });
    if (list.length > 20 || list.some((a) => a.length > 200)) return setDraftMsg({ tone: 'danger', text: 'Até 20 argumentos, cada um com até 200 caracteres.' });
    setSavingDraft(true);
    setDraftMsg(null);
    try {
      await updateAutomationVersionDraft(org, versionId, { ...(runtime ? { runtime } : {}), arguments: list });
      setDraftMsg({ tone: 'success', text: 'Rascunho atualizado.' });
      version.refresh();
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      setDraftMsg(
        isApiError(e, 'conflict')
          ? { tone: 'danger', text: 'A versão já foi publicada e não pode mudar. Crie uma nova versão.' }
          : isApiError(e, 'network', 'unexpected', 'internal_error')
            ? { tone: 'warning', text: 'Não foi possível confirmar se o rascunho foi salvo. Atualize a página e confira.' }
            : { tone: 'danger', text: 'O rascunho não foi aceito. Confira os campos.' },
      );
    } finally {
      setSavingDraft(false);
    }
  };

  const fpMismatch = !!expectedFp.trim() && !!reviewed && expectedFp.trim().toLowerCase() !== reviewed.fingerprint;

  return (
    <Stack gap={6}>
      <PageHeader title={`${name} — versão ${data.versionNumber ?? ''}`} subtitle="Versão da automação" back={back} onRefresh={version.refresh} refreshing={version.refreshing} />

      <Card variant="surface" padding="lg">
        <DescriptionList
          items={[
            {
              key: 'estado',
              term: 'Estado',
              description: draft ? (
                <Badge tone="neutral">Rascunho</Badge>
              ) : (
                <Badge tone="success" dot>
                  Publicada (imutável)
                </Badge>
              ),
            },
            { key: 'publicada', term: 'Publicada em', description: <DateTimeText iso={data.publishedAt} empty="Não publicada" /> },
            { key: 'runtime', term: 'Ambiente de execução', description: data.runtime ?? '—' },
            { key: 'entrada', term: 'Arquivo de entrada', description: data.entrypoint ?? '—' },
            { key: 'args', term: 'Argumentos', description: data.arguments?.length ? data.arguments.join(' ') : 'Nenhum', wide: true },
            { key: 'criada', term: 'Criada em', description: <DateTimeText iso={data.createdAt} /> },
          ]}
        />
      </Card>

      {!draft && (
        <Alert tone="info" title="Versão publicada: não muda mais.">
          Para alterar comando ou pacote, crie uma nova versão na automação. Publicar não executa nada nem autoriza
          execução: a execução local depende de uma autorização para um Worker, no workspace (
          <Link as={RouterLink} to={orgPath.workspace(org, data.workspaceId!)}>
            abrir o workspace
          </Link>
          ), e do início confirmado pela pessoa no Agent.
        </Alert>
      )}

      <section className="pw-prod__section" aria-labelledby="pacote-titulo">
        <Heading level={2} id="pacote-titulo" className="pw-prod__section-title">
          Pacote
        </Heading>
        {art ? (
          <Card variant="outlined" padding="lg">
            <Stack gap={3}>
              <DescriptionList
                items={[
                  { key: 'sha', term: 'SHA-256 dos bytes do ZIP', description: <Hash value={art.sha256} />, wide: true },
                  { key: 'fp', term: `Impressão do pacote (${art.fingerprintRule ?? 'regra não informada'})`, description: <Hash value={art.fingerprint} />, wide: true },
                  { key: 'tam', term: 'Tamanho', description: art.sizeBytes !== undefined ? mib(art.sizeBytes) : '—' },
                  { key: 'arqs', term: 'Arquivos', description: art.filesCount ?? '—' },
                  { key: 'man', term: 'Manifesto', description: art.manifestVersion ?? '—' },
                  { key: 'fw', term: 'Framework', description: art.framework ?? '—' },
                  { key: 'modo', term: 'Modo de execução', description: art.executionMode ?? '—' },
                  {
                    key: 'gerador',
                    term: 'Gerador (declarado)',
                    description: art.declaredGenerator ? `${art.declaredGenerator} — declarado no manifesto, não verificado` : 'Não declarado',
                  },
                  { key: 'recebido', term: 'Recebido em', description: <DateTimeText iso={art.receivedAt} /> },
                ]}
              />
              <Text variant="body-sm" color="secondary">
                O SHA-256 mede os bytes do arquivo ZIP. A impressão do pacote mede o conteúdo pela regra do Agent e é a que a
                autorização de execução local usa. São medidas diferentes: um ZIP refeito com o mesmo conteúdo pode ter
                outro SHA-256 e a mesma impressão. A origem do gerador é só declarada, não uma assinatura.
              </Text>
            </Stack>
          </Card>
        ) : (
          <StateView status="neutral" title="Esta versão ainda não tem pacote." />
        )}

        {draft && can('automation.manage') && (
          <Card variant="outlined" padding="lg">
            <Stack gap={3}>
              <Text as="h3" variant="h4">
                {art ? 'Substituir o pacote' : 'Enviar o pacote'}
              </Text>
              <Text variant="body-sm" color="secondary">
                O Studio gera uma pasta com o pacote. Compacte o CONTEÚDO dela num arquivo .zip (o manifest.json na raiz) e
                envie aqui. A Platform confere o manifesto e o hash de cada arquivo; o navegador não abre nem executa o
                pacote. O Studio não publica automaticamente.
              </Text>
              {/* campo de arquivo composto com as classes do Field da lib (o Field não é exportado e o Input da lib
                  controla `value`, o que o navegador proíbe em type=file) — encaminhado à equipe da lib */}
              <div className="nk-field">
                <label className="nk-field__label" htmlFor="pw-pacote">
                  Arquivo .zip do pacote
                </label>
                <input
                  id="pw-pacote"
                  className="pw-file"
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(e) => void choose(e)}
                  // com resultado desconhecido, escolher outro arquivo reabriria o envio sem a conferência
                  disabled={upload.phase === 'sending' || upload.phase === 'uncertain'}
                  aria-invalid={fileProblem ? true : undefined}
                  aria-describedby="pw-pacote-message"
                />
                <p id="pw-pacote-message" className={fileProblem ? 'nk-field__message nk-field__message--error' : 'nk-field__message'}>
                  {fileProblem ?? 'Até 50 MiB.'}
                </p>
              </div>
              {file && (
                <Text variant="body-sm">
                  {file.name} · {mib(file.size)}
                  {localHash && (
                    <>
                      {' · '}SHA-256 calculado no navegador (auxiliar): <Hash value={localHash} />
                    </>
                  )}
                </Text>
              )}
              {upload.phase === 'sending' && (
                <div className="pw-upload">
                  <label htmlFor="pw-upload-progress">Enviando…</label>
                  <progress id="pw-upload-progress" max={upload.total} value={upload.sent}>
                    {Math.round((upload.sent / Math.max(upload.total, 1)) * 100)}%
                  </progress>
                  <span aria-live="polite">{Math.round((upload.sent / Math.max(upload.total, 1)) * 100)}%</span>
                  <Button size="sm" variant="ghost" onClick={() => handle.current?.abort()}>
                    Interromper
                  </Button>
                </div>
              )}
              {upload.phase === 'done' && <Alert tone="success">Pacote recebido e conferido pela Platform.</Alert>}
              {upload.phase === 'refused' && <Alert tone="danger">{upload.text}</Alert>}
              {upload.phase === 'uncertain' && (
                <Alert tone="warning" title="O envio foi interrompido ou ficou sem resposta.">
                  <Stack gap={2}>
                    <span>Os bytes podem ter chegado. Nada é reenviado automaticamente: confira a versão antes de decidir.</span>
                    <span>
                      <Button size="sm" variant="secondary" onClick={() => void reconcile()}>
                        Conferir a versão
                      </Button>
                    </span>
                  </Stack>
                </Alert>
              )}
              {upload.phase === 'reconciled' && upload.arrived !== 'unknown' && (
                <Alert tone={upload.arrived === 'yes' ? 'success' : 'info'}>
                  {upload.arrived === 'yes'
                    ? 'Conferido: a Platform tem o pacote com o mesmo SHA-256 do arquivo escolhido.'
                    : 'A versão não tem o pacote deste arquivo. Você pode enviar de novo.'}
                </Alert>
              )}
              {upload.phase === 'reconciled' && upload.arrived === 'unknown' && (
                <Alert tone="warning" title="Não foi possível comparar com o arquivo escolhido.">
                  {upload.serverSha256 ? (
                    <>
                      Este navegador não calculou o SHA-256 do arquivo. A Platform tem um pacote com SHA-256 <Hash value={upload.serverSha256} />:
                      compare com o do seu arquivo antes de enviar de novo.
                    </>
                  ) : (
                    'A versão ainda não tem pacote. Você pode enviar de novo.'
                  )}
                </Alert>
              )}
              <div>
                <Button onClick={send} disabled={!file || upload.phase === 'sending' || upload.phase === 'uncertain'} loading={upload.phase === 'sending'}>
                  Enviar pacote
                </Button>
              </div>
            </Stack>
          </Card>
        )}
      </section>

      {draft && can('automation.manage') && (
        <section className="pw-prod__section" aria-labelledby="comando-titulo">
          <Heading level={2} id="comando-titulo" className="pw-prod__section-title">
            Comando do rascunho
          </Heading>
          <Card variant="outlined" padding="lg">
            <div className="pw-identity__form">
              {draftMsg && <Alert tone={draftMsg.tone}>{draftMsg.text}</Alert>}
              <Input label="Ambiente de execução" value={runtime} onChange={(e) => setRuntime(e.target.value)} hint="Formato python3.N. Em branco: python3.12." />
              <Textarea label="Argumentos (um por linha)" value={args} onChange={(e) => setArgs(e.target.value)} hint="Até 20, cada um com até 200 caracteres." />
              <div>
                <Button variant="secondary" loading={savingDraft} onClick={() => void saveDraft()}>
                  Salvar rascunho
                </Button>
              </div>
            </div>
          </Card>
        </section>
      )}

      {draft && can('automation.publish') && (
        <section className="pw-prod__section" aria-labelledby="publicar-titulo">
          <Heading level={2} id="publicar-titulo" className="pw-prod__section-title">
            Publicação
          </Heading>
          <Card variant="outlined" padding="lg">
            <Stack gap={3}>
              {publishMsg && <Alert tone={publishMsg.tone}>{publishMsg.text}</Alert>}
              <Text>
                Publicar fixa esta versão com o pacote conferido: depois disso ela não muda. Publicar não executa nada nem
                autoriza execução.
              </Text>
              <div>
                <Button
                  disabled={!art?.sha256 || !art?.fingerprint}
                  onClick={() => {
                    setReviewed({ sha256: art!.sha256!, fingerprint: art!.fingerprint! });
                    setChecked(false);
                    setExpectedFp('');
                    setPublishMsg(null);
                    setPublishing(true);
                  }}
                >
                  Publicar versão
                </Button>
              </div>
              {!art && <Text variant="body-sm" color="secondary">Envie o pacote antes de publicar.</Text>}
            </Stack>
          </Card>
        </section>
      )}

      {!draft && (
        <LocalRunAuthorizations
          workspaceId={data.workspaceId!}
          version={{ automationVersionId: data.automationVersionId!, versionNumber: data.versionNumber, fingerprint: data.agentPackage?.fingerprint ?? art?.fingerprint }}
          canExecute={perms.status === 'ready' && perms.has('automation.execute')}
        />
      )}

      <StepUpDialog<LifecycleVersion>
        open={publishing}
        title={`Publicar a versão ${data.versionNumber ?? ''}?`}
        guard={{ operation: 'version.publish', target: versionId }}
        confirmLabel="Publicar"
        ready={checked && !fpMismatch}
        stepUp={orgStepUp(org)}
        action={() => publishAutomationVersion(org, versionId, reviewed!)}
        onDone={() => {
          setPublishing(false);
          setPublishMsg({ tone: 'success', text: 'Versão publicada. Ela não muda mais.' });
          version.refresh();
        }}
        onClose={() => setPublishing(false)}
        refusalText={(e) => {
          if (isApiError(e, 'conflict')) {
            version.refresh();
            return 'A publicação foi recusada: o pacote mudou depois da sua conferência (ou a versão já foi publicada com outro pacote). Nada foi publicado. Feche, confira os valores atuais e decida de novo.';
          }
          return isApiError(e, 'forbidden')
            ? 'A publicação não foi permitida (permissão ou confirmação de identidade). Nada foi publicado.'
            : 'A publicação não foi concluída. Nada foi publicado.';
        }}
        uncertainText="Não foi possível confirmar a publicação. Feche e atualize a versão: repetir com os mesmos valores é seguro (a API devolve a versão já publicada), mas confira antes."
        onUnauthenticated={expired}
        onOutcome={(k) => k === 'uncertain' && setPublishMsg({ tone: 'warning', text: 'O resultado da publicação não foi confirmado. Atualize a versão e confira.' })}
      >
        {reviewed && (
          <>
            <Text>A publicação usa exatamente o pacote que você conferiu:</Text>
            <DescriptionList
              items={[
                { key: 'sha', term: 'SHA-256 dos bytes', description: <Hash value={reviewed.sha256} />, wide: true },
                { key: 'fp', term: 'Impressão do pacote', description: <Hash value={reviewed.fingerprint} />, wide: true },
              ]}
            />
            <Input
              label="Impressão esperada (opcional)"
              hint="Cole a impressão informada pelo Studio ou pelo Agent para comparar."
              value={expectedFp}
              onChange={(e) => setExpectedFp(e.target.value)}
              error={fpMismatch ? 'Diferente da impressão do pacote recebido. Não publique: confira o pacote.' : undefined}
              spellCheck={false}
            />
            <Checkbox label="Conferi o pacote desta versão." checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          </>
        )}
      </StepUpDialog>
    </Stack>
  );
}
