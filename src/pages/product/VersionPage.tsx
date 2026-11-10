import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link as RouterLink, useLocation, useParams } from 'react-router';
import { Alert, Badge, Button, Card, DescriptionList, Heading, Input, Link, Stack, StateView, Text, Textarea } from 'nekkora-lib';
import { hasReason, isApiError } from '../../api/http';
import {
  ARTIFACT_MAX_BYTES,
  getAutomationVersion,
  localSha256,
  publishAutomationVersion,
  updateAutomationVersionDraft,
  uploadDraftPackage,
  type LifecycleVersion,
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
import { compareTechnical, PublishSummary, type Reviewed } from './PublishSummary';
import { uploadOutcome } from './uploadOutcome';
import { checkCommand, draftRefusal, mib, PackageBrief } from './draftPackage';
import './shared.css';
import '../../identity/identity.css';

type Upload =
  | { phase: 'idle' }
  | { phase: 'sending'; sent: number; total: number }
  | { phase: 'done' }
  | { phase: 'refused'; text: string }
  | { phase: 'uncertain' }
  /** `unknown`: sem SHA-256 local (Web Crypto indisponível) não há como comparar; mostra o que a Platform tem. */
  | { phase: 'reconciled'; arrived: 'yes' | 'no' | 'unknown'; serverSha256?: string | null }
  /** T09: o rascunho mudou desde a leitura (outra aba ou pessoa enviou, ou foi publicado): nada sobrescrito. */
  | { phase: 'changed'; fresh: LifecycleVersion | null };

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
  const sending = useRef(false);
  /** Chegada da página "Nova versão" (T09): o rascunho acabou de nascer com o pacote aceito. */
  const created = (useLocation().state as { draftCreated?: boolean } | null)?.draftCreated === true;
  const [runtime, setRuntime] = useState('');
  const [args, setArgs] = useState('');
  const [draftMsg, setDraftMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /**
   * Pacote conferido, fixado ao abrir a publicação (T05): é exatamente o que vai na expectativa do POST; a API recusa (409)
   * se o rascunho mudar até lá. Os dados de apresentação ficam fixados junto, para o diálogo não mudar sob a pessoa.
   */
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  /** "Conferir identificação técnica": fechado por padrão; só para quem precisa comparar o arquivo. */
  const [technical, setTechnical] = useState(false);
  const [compare, setCompare] = useState('');
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

  /**
   * T09: o pacote vai pelo PUT do rascunho da automação com a expectativa do que esta tela mostra (este rascunho e o
   * SHA-256 do pacote atual, ou nenhum): se outra aba ou pessoa trocou o pacote, ou publicou, a API recusa (409
   * draft_changed) e nada é sobrescrito. Um envio por vez; nunca reenvia sozinho.
   */
  const send = () => {
    if (!file || sending.current || version.refreshing) return;
    sending.current = true;
    const expected = { draftVersionId: versionId, sha256: art?.sha256 ?? null };
    setUpload({ phase: 'sending', sent: 0, total: file.size });
    const h = uploadDraftPackage(org, data.automationId!, file, expected, (sent, total) => setUpload({ phase: 'sending', sent, total }));
    handle.current = h;
    h.promise
      .then(() => {
        setUpload({ phase: 'done' });
        version.refresh();
      })
      .catch(async (e) => {
        const outcome = uploadOutcome(e);
        if (outcome === 'expired') return expired();
        if (hasReason(e, 'conflict', 'draft_changed')) {
          // relê o rascunho para mostrar qual pacote ficou; a expectativa do próximo envio passa a ser a dele
          const fresh = await getAutomationVersion(org, versionId).catch(() => null);
          version.refresh();
          return setUpload({ phase: 'changed', fresh });
        }
        setUpload(outcome === 'uncertain' ? { phase: 'uncertain' } : { phase: 'refused', text: draftRefusal(e, art?.sha256 ? 'previous' : 'empty') });
      })
      .finally(() => {
        handle.current = null;
        sending.current = false;
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
    const command = checkCommand(runtime, args);
    if (!command.ok) return setDraftMsg({ tone: 'danger', text: command.text });
    setSavingDraft(true);
    setDraftMsg(null);
    try {
      await updateAutomationVersionDraft(org, versionId, { ...(command.runtime ? { runtime: command.runtime } : {}), arguments: command.arguments });
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

  const comparison = compareTechnical(compare, reviewed);
  const openPublish = () => {
    if (!art?.sha256 || !art?.fingerprint) return;
    setReviewed({
      sha256: art.sha256,
      fingerprint: art.fingerprint,
      fingerprintRule: art.fingerprintRule ?? null,
      kind: art.packageKind === 'EXTERNAL_PYTHON' ? 'EXTERNAL_PYTHON' : 'STUDIO',
      sizeBytes: art.sizeBytes ?? null,
      filesCount: art.filesCount ?? null,
      packageName: art.packageName ?? null,
      packageVersion: art.packageVersion ?? null,
      receivedAt: art.receivedAt ?? null,
      // nome do arquivo só quando é, comprovadamente, o que este navegador enviou (mesmo SHA-256)
      fileName: file && localHash && localHash === art.sha256 ? file.name : null,
    });
    setTechnical(false);
    setCompare('');
    setPublishMsg(null);
    setPublishing(true);
  };

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

      {created && draft && upload.phase === 'idle' && (
        <Alert tone="success" title="Rascunho criado com o pacote conferido pela Platform.">
          A versão {data.versionNumber} passou a existir quando a Platform aceitou o pacote e já está salva, mesmo que você
          saia desta página. Nada foi publicado nem executado: revise abaixo e publique quando quiser.
        </Alert>
      )}

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
        {upload.phase === 'changed' && (
          <Alert tone="warning" title="O rascunho mudou desde que você abriu esta página. Nada foi sobrescrito.">
            {!upload.fresh ? (
              'Outra aba ou pessoa alterou este rascunho e o seu envio não foi aplicado. Atualize a página para ver o pacote atual antes de decidir.'
            ) : upload.fresh.status !== 'DRAFT' ? (
              'A versão foi publicada em outra aba ou por outra pessoa, e o seu envio não foi aplicado. Para mudar o pacote, crie uma nova versão na automação.'
            ) : (
              <>
                Outra aba ou pessoa enviou um pacote a este rascunho; o seu envio não foi aplicado. Ficou na Platform{' '}
                <PackageBrief artifact={upload.fresh.artifact} />. Confira abaixo e, se ainda quiser trocar pelo seu arquivo, envie
                de novo: o próximo envio considera o pacote que ficou.
              </>
            )}
          </Alert>
        )}
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
                  { key: 'tipo', term: 'Tipo do pacote', description: art.packageKind === 'EXTERNAL_PYTHON' ? 'Python externo (sem framework Nekkora)' : 'Formato Studio' },
                  ...(art.packageKind === 'EXTERNAL_PYTHON'
                    ? [
                        { key: 'pkg', term: 'Projeto (declarado)', description: `${art.packageName ?? '—'} ${art.packageVersion ?? ''}` },
                        { key: 'py', term: 'Python exigido', description: art.pythonRequirement ?? '—' },
                        { key: 'deps', term: 'Dependências (versão exata)', description: art.dependencies?.length ? art.dependencies.join(', ') : 'nenhuma', wide: true },
                      ]
                    : [
                        { key: 'fw', term: 'Framework', description: art.framework ?? '—' },
                        { key: 'modo', term: 'Modo de execução', description: art.executionMode ?? '—' },
                      ]),
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
                {art && ' O pacote atual continua valendo até a Platform aceitar o novo; um arquivo recusado não muda nada.'}
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
                    : upload.serverSha256
                      ? 'Conferido: o pacote deste arquivo não chegou; o rascunho continua com o pacote mostrado acima. Nada é reenviado sozinho: você pode enviar de novo.'
                      : 'Conferido: o pacote deste arquivo não chegou; o rascunho continua sem pacote. Nada é reenviado sozinho: você pode enviar de novo.'}
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
                <Button onClick={send} disabled={!file || upload.phase === 'sending' || upload.phase === 'uncertain' || version.refreshing} loading={upload.phase === 'sending'}>
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
                <Button disabled={!art?.sha256 || !art?.fingerprint} onClick={openPublish}>
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
        title={`Publicar a versão ${data.versionNumber ?? ''} de ${name}?`}
        guard={{ operation: 'version.publish', target: versionId }}
        confirmLabel="Publicar"
        ready={!!reviewed && comparison.status !== 'mismatch' && comparison.status !== 'malformed'}
        stepUp={orgStepUp(org)}
        action={() => publishAutomationVersion(org, versionId, { sha256: reviewed!.sha256, fingerprint: reviewed!.fingerprint })}
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
          <PublishSummary
            automation={name}
            versionNumber={data.versionNumber}
            reviewed={reviewed}
            technical={technical}
            onToggleTechnical={() => setTechnical((t) => !t)}
            compare={compare}
            onCompare={setCompare}
            comparison={comparison}
          />
        )}
      </StepUpDialog>
    </Stack>
  );
}
