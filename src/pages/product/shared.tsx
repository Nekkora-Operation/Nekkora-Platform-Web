import { useEffect, type ReactNode } from 'react';
import { Link as RouterLink, useLocation } from 'react-router';
import { Badge, Button, Heading, Link, StateView, Text, type LinkProps } from 'nekkora-lib';
import { isApiError } from '../../api/http';
import type { Workspace } from '../../api/v1';
import { ContractViolation } from '../../api/validate';
import { commonMessage } from '../../auth/messages';
import { useSession } from '../../area/session';
import type { ResourceState } from '../../hooks/useResource';
import { formatDateTime, offsetLabel } from '../executions/format';
import './shared.css';

/**
 * Data recebida da API, no fuso do navegador e com o deslocamento quando ele difere do atual. Valor aceito pelo contrato
 * e não representável pelo Date (segundo bissexto) aparece como recebido (F4-R1). Nulo = "—" acessível.
 */
export function DateTimeText({ iso, empty = '—' }: { iso: string | null | undefined; empty?: ReactNode }) {
  if (!iso) return typeof empty === 'string' ? <span aria-label="não informado">{empty}</span> : <>{empty}</>;
  const d = formatDateTime(iso);
  const current = offsetLabel(new Date());
  return (
    <time dateTime={iso} title={d.asReceived ? `${iso} (horário como recebido, sem conversão de fuso)` : iso}>
      {d.text}
      {(d.asReceived || d.offset !== current) && d.offset && <span className="pw-prod__offset"> {d.offset}</span>}
    </time>
  );
}

export const RESOURCE_STATUS_LABEL: Record<Workspace['status'], string> = { active: 'Ativo', suspended: 'Suspenso', archived: 'Arquivado' };
const RESOURCE_STATUS_TONE: Record<Workspace['status'], 'success' | 'warning' | 'neutral'> = { active: 'success', suspended: 'warning', archived: 'neutral' };

export function ResourceStatusBadge({ status }: { status: Workspace['status'] }) {
  return (
    <Badge tone={RESOURCE_STATUS_TONE[status]} size="sm">
      {RESOURCE_STATUS_LABEL[status]}
    </Badge>
  );
}

/**
 * Link de rota com o visual do Link da lib (um <a href> de verdade: teclado, nova aba, copiar endereço) e estado de
 * navegação opcional (ex.: endereço da lista com filtros, para o "Voltar").
 */
export function RouteLink({ to, state, children, ...rest }: { to: string; state?: unknown; children: ReactNode } & Omit<LinkProps, 'as' | 'href' | 'to' | 'children'>) {
  const routerProps = { to, state };
  return (
    <Link as={RouterLink} {...rest} {...(routerProps as object)}>
      {children}
    </Link>
  );
}

/** Para onde "Voltar" leva: o endereço (com filtros) de onde a pessoa veio, se o link o informou; senão o padrão. */
export function useBackTarget(fallback: string): string {
  const state = useLocation().state as { back?: unknown } | null;
  return state && typeof state.back === 'string' && state.back.startsWith('/o/') ? state.back : fallback;
}

/** Estado de navegação que os links de lista passam para o detalhe (endereço atual, com os filtros). */
export function useBackState() {
  const { pathname, search } = useLocation();
  return { back: pathname + search };
}

export function PageHeader({
  title,
  subtitle,
  back,
  onRefresh,
  refreshing,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: { to: string; label: string };
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Ações da página (ex.: criar), ao lado de "Atualizar". */
  actions?: ReactNode;
}) {
  return (
    <header className="pw-prod__header">
      {back && (
        <Link as={RouterLink} to={back.to} leftIcon="arrow-left" size="sm" variant="subtle">
          {back.label}
        </Link>
      )}
      <div className="pw-prod__header-row">
        <div className="pw-prod__header-text">
          <Heading level={1} className="pw-prod__title">
            {title}
          </Heading>
          {subtitle != null && (
            <Text variant="body-sm" color="secondary">
              {subtitle}
            </Text>
          )}
        </div>
        {(onRefresh || actions) && (
          <div className="pw-prod__header-actions">
            {actions}
            {onRefresh && (
              <Button variant="secondary" size="sm" leftIcon="refresh" loading={refreshing} onClick={onRefresh}>
                Atualizar
              </Button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

/** O mesmo estado para inexistente, de outra organização ou sem acesso (a API não distingue; a tela também não). */
export function NotFoundState({ title, back }: { title: string; back: { to: string; label: string } }) {
  return (
    <StateView
      status="neutral"
      title={<PageTitle>{title}</PageTitle>}
      description="O endereço pode estar errado, o item pode não existir ou você pode não ter acesso a ele."
      actions={
        <Link as={RouterLink} to={back.to} arrow>
          {back.label}
        </Link>
      }
    />
  );
}

/** Erro de leitura que não é 404/401: título e descrição seguros, tentativa só por ação. */
export function errorText(e: unknown): { title: string; description?: string } {
  if (e instanceof ContractViolation) {
    return { title: 'A resposta do servidor veio fora do formato esperado.', description: 'Nada foi exibido a partir dela. Tente novamente; se continuar, avise o suporte.' };
  }
  const m = commonMessage(e);
  return { title: m.title, description: m.description };
}

/** `page`: o erro ocupa a página inteira (o título vira o h1 dela); senão é o erro de uma seção. */
export function LoadErrorState({ error, onRetry, page = false }: { error: unknown; onRetry: () => void; page?: boolean }) {
  const t = errorText(error);
  return (
    <StateView
      status="error"
      title={page ? <PageTitle>{t.title}</PageTitle> : t.title}
      description={t.description}
      actions={<Button onClick={onRetry}>Tentar novamente</Button>}
    />
  );
}

/** Título de estado que ocupa a página: o StateView o põe num <p>, então o cabeçalho é um span com papel de h1. */
function PageTitle({ children }: { children: ReactNode }) {
  return (
    <span role="heading" aria-level={1}>
      {children}
    </span>
  );
}

/** Erro de um recurso único, ou nada (para observar o 401 de cada requisição separadamente). */
export const errorOf = <T,>(r: ResourceState<T>): unknown => (r.status === 'error' ? r.error : undefined);

/**
 * 401 de QUALQUER leitura da página encerra a sessão, independentemente do erro escolhido para a apresentação (um 500
 * do detalhe não pode encobrir o 401 da lista). `expired` é idempotente: vários 401 aplicam o fluxo uma vez só.
 */
export function useExpiresOn(...errors: unknown[]) {
  const { expired } = useSession();
  const unauthenticated = errors.some((e) => isApiError(e, 'unauthenticated'));
  useEffect(() => {
    if (unauthenticated) expired();
  }, [unauthenticated, expired]);
}

/**
 * Perda de acesso descoberta por uma consulta subordinada (eventos, automações, versões): 404 nela significa que o
 * recurso da página não existe mais para quem consulta. Só `not_found`: cursor recusado chega como `invalid_request`
 * e continua oferecendo recomeço; falha transitória mantém os dados.
 */
export const isSubordinateGone = (e: unknown) => isApiError(e, 'not_found');

/** 404, e também endereço com identificador malformado (400 no caminho): nada a mostrar. */
export const isMissing = (e: unknown) => isApiError(e, 'not_found') || isApiError(e, 'invalid_request');
