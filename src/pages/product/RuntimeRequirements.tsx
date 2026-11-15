import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Heading, RadioGroup, Stack, Table, Text, Textarea, type TableColumn } from 'nekkora-lib';
import {
  analyzeRuntimeRequirements,
  declareRuntimeRequirements,
  getRuntimeRequirements,
  type RequirementLine,
  type RequirementSource,
  type RuntimeRequirements as View,
  type RuntimeRequirementsAnalysis,
} from '../../api/runtimeRequirements';
import { hasReason, isApiError } from '../../api/http';
import { useSession } from '../../area/session';
import { DateTimeText, LoadErrorState } from './shared';
import '../agents/agents.css';

/**
 * PLATFORM-CLIENT-EXECUCAO-REMOTA-001, T01c — dependências de execução de uma automação, declaradas na Platform. A leitura
 * do texto é feita pela API (estática, com as regras do aplicativo): a tela só mostra o que ela devolve. Nada é instalado,
 * o pacote publicado não muda, e declarar não autoriza execução.
 *
 * Numa Platform sem o recurso (404), a seção não aparece.
 */
const MAX_TEXT = 262_144;

const SOURCE: Record<RequirementSource, string> = {
  PACKAGE: 'Só as do pacote',
  NONE_CONFIRMED: 'Sem dependências externas (confirmado)',
  TEXT: 'Lista digitada',
  FILE: 'Arquivo requirements.txt',
};

/** A situação de cada linha, nas palavras do aplicativo. */
export const LINE_KIND: Record<RequirementLine['kind'], string> = {
  EXACT: 'Dependência com versão exata',
  DUPLICATE: 'Repetida com a mesma versão: usada uma vez',
  CONFLICT: 'A mesma dependência aparece com versões ou extras diferentes: deixe uma só',
  RANGE: 'Faixa de versões: é preciso a versão exata (nome==1.2.3)',
  NO_VERSION: 'Sem versão: é preciso a versão exata (nome==1.2.3)',
  MARKER: "Marcador de ambiente (texto depois de ';'): não é representado",
  REMOTE: 'Instalação por endereço remoto ou repositório: não é representada',
  LOCAL_PATH: 'Caminho local ou arquivo: não é representado',
  INCLUDE: 'Inclui outro arquivo (-r ou -c): inclusões não são seguidas; traga as linhas para cá',
  OPTION: 'Opção do pip: não é representada',
  HASH: 'Fixa um hash (--hash): não é registrado',
  UNKNOWN: 'Linha não reconhecida',
};

export const UNRESOLVED_TEXT = 'Há linhas que não podem ser usadas. Ajuste o texto e confira de novo. Nada foi gravado.';
export const CHANGED_TEXT = 'Outra pessoa declarou as dependências desta automação enquanto você editava. A tela foi atualizada; confira e declare de novo se ainda for o caso. Nada foi gravado.';

type Load = { status: 'loading' } | { status: 'ready'; view: View } | { status: 'absent' } | { status: 'error'; error: unknown };

export function RuntimeRequirements({ automationId, canManage }: { automationId: string; canManage: boolean }) {
  const { org, expired } = useSession();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState<RequirementSource>('PACKAGE');
  const [text, setText] = useState('');
  const [analysis, setAnalysis] = useState<{ of: string; result: RuntimeRequirementsAnalysis } | null>(null);
  const [busy, setBusy] = useState<'idle' | 'analyzing' | 'declaring'>('idle');
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const view = await getRuntimeRequirements(org, automationId);
      if (gen === generation.current) setLoad({ status: 'ready', view });
    } catch (e) {
      if (gen !== generation.current) return;
      if (isApiError(e, 'unauthenticated')) return expired();
      setLoad(isApiError(e, 'not_found') ? { status: 'absent' } : { status: 'error', error: e });
    }
  }, [org, automationId, expired]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);

  if (load.status === 'loading' || load.status === 'absent') return null;

  const withText = source === 'TEXT' || source === 'FILE';
  const tooLong = text.length > MAX_TEXT;
  const checked = analysis && analysis.of === text ? analysis.result : null;
  const canDeclare = busy === 'idle' && (!withText || (!!checked && checked.resolved && !tooLong));

  const analyze = async () => {
    setBusy('analyzing');
    setNotice(null);
    try {
      setAnalysis({ of: text, result: await analyzeRuntimeRequirements(org, automationId, text) });
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      setNotice({ tone: 'danger', text: 'Não foi possível conferir o texto. Tente de novo. Nada foi gravado.' });
    } finally {
      setBusy('idle');
    }
  };

  const declare = async (view: View) => {
    setBusy('declaring');
    setNotice(null);
    try {
      const next = await declareRuntimeRequirements(org, automationId, {
        source,
        ...(withText ? { text } : {}),
        ...(view.declared ? { expectedRevision: view.declared.revision } : {}),
      });
      setLoad({ status: 'ready', view: next });
      setEditing(false);
      setAnalysis(null);
      setText('');
      setNotice({ tone: 'success', text: `Dependências declaradas (revisão ${next.declared?.revision}). O pacote publicado não mudou.` });
    } catch (e) {
      if (isApiError(e, 'unauthenticated')) return expired();
      if (hasReason(e, 'conflict', 'runtime_requirements_unresolved')) {
        setAnalysis(null);
        setNotice({ tone: 'danger', text: UNRESOLVED_TEXT });
      } else if (hasReason(e, 'conflict', 'runtime_requirements_changed')) {
        setNotice({ tone: 'warning', text: CHANGED_TEXT });
        await reload();
      } else if (isApiError(e, 'not_found', 'forbidden')) {
        setNotice({ tone: 'danger', text: 'Você não tem permissão para declarar as dependências desta automação. Nada foi gravado.' });
      } else {
        setNotice({ tone: 'warning', text: 'Não foi possível confirmar se a declaração foi gravada. Atualize a página e confira antes de tentar de novo.' });
      }
    } finally {
      setBusy('idle');
    }
  };

  const columns: TableColumn<RequirementLine>[] = [
    { key: 'linha', header: 'Linha', render: (l) => l.number },
    { key: 'texto', header: 'Texto', render: (l) => <code className="pw-break">{l.text}</code> },
    {
      key: 'situacao',
      header: 'Situação',
      render: (l) => (
        <Stack gap={1}>
          <span>
            <Badge tone={l.problem ? 'warning' : 'success'}>{l.problem ? 'Impede declarar' : 'Aceita'}</Badge>
          </span>
          <Text variant="body-sm">{LINE_KIND[l.kind]}</Text>
        </Stack>
      ),
    },
  ];

  return (
    <section className="pw-prod__section" aria-labelledby="dependencias-titulo">
      <Heading level={2} id="dependencias-titulo" className="pw-prod__section-title">
        Dependências de execução
      </Heading>
      <Text variant="body-sm" color="secondary">
        As bibliotecas que esta automação precisa para ser executada a pedido da Platform. Nada é instalado por aqui e o pacote
        publicado não muda: a declaração só diz o que a máquina precisa ter.
      </Text>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {load.status === 'error' && <LoadErrorState error={load.error} onRetry={() => void reload()} />}
      {load.status === 'ready' && (
        <Card variant="outlined" padding="lg">
          <Stack gap={3}>
            {load.view.declared ? (
              <Text>
                Declarado: <strong>{SOURCE[load.view.declared.source]}</strong> · revisão {load.view.declared.revision} ·{' '}
                <DateTimeText iso={load.view.declared.declaredAt} />
              </Text>
            ) : (
              <Alert tone="info" title="Ainda não declarado.">
                Ninguém disse quais dependências esta automação tem. Sem uma declaração, ela não poderá ser executada a pedido da
                Platform. Executar pelo aplicativo, no próprio computador, continua como está.
              </Alert>
            )}
            <Text variant="body-sm" color="secondary">
              {load.view.published
                ? `Pacote publicado (versão ${load.view.published.versionNumber}): ${
                    load.view.published.dependencies.length === 0 ? 'não declara dependências.' : `${load.view.published.dependencies.length} no manifesto.`
                  }`
                : 'Esta automação ainda não tem versão publicada.'}
            </Text>
            {load.view.effective.conflicts.length > 0 && (
              <Alert tone="warning" title="Há conflito com o pacote publicado.">
                <ul className="pw-plain-list" aria-label="Conflitos com o pacote publicado">
                  {load.view.effective.conflicts.map((c) => (
                    <li key={c.name}>
                      <code>{c.declared}</code> foi declarada, mas o pacote publicado traz <code>{c.published}</code>. Vale a do pacote. Ajuste a
                      declaração para poder executar a pedido da Platform.
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {load.view.effective.dependencies.length === 0 ? (
              <Text variant="body-sm">Nenhuma dependência efetiva.</Text>
            ) : (
              <div>
                <Text variant="body-sm" weight="semibold">
                  Efetivo (pacote publicado mais o declarado)
                </Text>
                <ul className="pw-plain-list" aria-label="Dependências efetivas">
                  {load.view.effective.dependencies.map((d) => (
                    <li key={d}>
                      <code>{d}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {canManage && !editing && (
              <div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSource(load.view.declared?.source ?? 'PACKAGE');
                    setText('');
                    setAnalysis(null);
                    setNotice(null);
                    setEditing(true);
                  }}
                >
                  {load.view.declared ? 'Declarar de novo' : 'Declarar dependências'}
                </Button>
              </div>
            )}
            {canManage && editing && (
              <Stack gap={3}>
                <RadioGroup
                  legend="O que declarar"
                  value={source}
                  onChange={(v) => {
                    setSource(v as RequirementSource);
                    setAnalysis(null);
                  }}
                  options={[
                    { value: 'PACKAGE', label: SOURCE.PACKAGE, description: 'Valem as dependências do manifesto do pacote publicado; nada é acrescentado.' },
                    { value: 'NONE_CONFIRMED', label: 'Sem dependências externas', description: 'Você confirma que a automação não precisa de bibliotecas além das do pacote.' },
                    { value: 'TEXT', label: SOURCE.TEXT, description: 'Uma por linha, com a versão exata: nome==1.2.3.' },
                    { value: 'FILE', label: SOURCE.FILE, description: 'O conteúdo do arquivo é lido como texto. Nada é instalado e inclusões (-r) não são seguidas.' },
                  ]}
                />
                {source === 'FILE' && (
                  <label className="pw-form__field">
                    <Text variant="body-sm" weight="semibold">
                      Arquivo requirements.txt
                    </Text>
                    <input
                      type="file"
                      accept=".txt,text/plain"
                      aria-label="Arquivo requirements.txt"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        setAnalysis(null);
                        if (!file) return setText('');
                        if (file.size > MAX_TEXT) {
                          setText('');
                          return setNotice({ tone: 'danger', text: 'O arquivo é grande demais (o limite é 256 KB). Nada foi lido.' });
                        }
                        void file.text().then(setText);
                      }}
                    />
                  </label>
                )}
                {withText && (
                  <Textarea
                    label={source === 'FILE' ? 'Conteúdo lido do arquivo' : 'Lista de dependências'}
                    fullWidth
                    rows={8}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    hint="Só nome==versão é aceito (extras permitidos: nome[extra]==1.2.3). Comentários e linhas em branco são ignorados."
                    error={tooLong ? 'O texto passa de 256 KB.' : undefined}
                  />
                )}
                {withText && checked && (
                  <>
                    {checked.lines.length === 0 ? (
                      <Text variant="body-sm">O texto não declara nenhuma dependência (só comentários ou vazio).</Text>
                    ) : (
                      <div className="pw-prod__scroll" role="region" aria-label="Linhas conferidas" tabIndex={0}>
                        <Table columns={columns} data={checked.lines} rowKey="number" size="sm" caption="Situação de cada linha do texto." />
                      </div>
                    )}
                    {!checked.resolved && <Alert tone="warning">{UNRESOLVED_TEXT}</Alert>}
                  </>
                )}
                <div className="pw-form__row">
                  {withText && (
                    <Button variant="secondary" loading={busy === 'analyzing'} disabled={busy !== 'idle' || tooLong} onClick={() => void analyze()}>
                      Conferir o texto
                    </Button>
                  )}
                  <Button loading={busy === 'declaring'} disabled={!canDeclare} onClick={() => void declare(load.view)}>
                    Declarar
                  </Button>
                  <Button variant="ghost" disabled={busy !== 'idle'} onClick={() => setEditing(false)}>
                    Cancelar
                  </Button>
                </div>
                {withText && !checked && (
                  <Text variant="body-sm" color="secondary">
                    Confira o texto antes de declarar: cada linha é lida e a tela mostra o que será usado.
                  </Text>
                )}
              </Stack>
            )}
          </Stack>
        </Card>
      )}
    </section>
  );
}
