import { DescriptionList, Text } from 'nekkora-lib';
import { copyrightLine, PRODUCT_VERSION, productLine } from '../app/product';
import { buildInfo, channelOf, UNKNOWN, type BuildInfo } from '../app/version';

/**
 * Rodapé do menu (PLATFORM-INICIO-001): a versão OFICIAL do produto e os direitos. Nada técnico aqui: commits, branch e
 * versões da lib e da API ficam em "Sobre esta versão" ({@link VersionDetails}).
 */
export function ProductFooter({ now }: { now?: Date }) {
  return (
    <div className="pw-shell__product">
      <span className="pw-shell__product-label">Versão</span>
      <span className="pw-shell__product-name">{productLine()}</span>
      <span className="pw-shell__product-rights">{copyrightLine(now)}</span>
    </div>
  );
}

/** Rodapé curto do trilho recolhido do menu (AppShell layout="header"); o completo aparece ao expandir. */
export function ProductFooterCompact({ now = new Date() }: { now?: Date }) {
  return (
    <span className="pw-shell__rail-version" aria-label={`${productLine()}. ${copyrightLine(now)}`}>
      v{PRODUCT_VERSION}
      <br />© {now.getFullYear()}
    </span>
  );
}

/**
 * "Sobre esta versão" (Minha conta e Segurança da conta): o diagnóstico completo, para informar num relato de problema -
 * a versão do produto e, à parte, o que está de fato rodando (commit e linha do frontend, API e Nekkora-lib).
 */
export function VersionDetails({ info = buildInfo() }: { info?: BuildInfo }) {
  const channel = channelOf(info);
  return (
    <>
      <DescriptionList
        items={[
          { key: 'produto', term: 'Nekkora Platform', description: PRODUCT_VERSION },
          { key: 'web', term: 'Platform Web', description: info.webCommit ? `${info.webCommit}${info.webDirty ? ' (com alterações locais)' : ''}` : UNKNOWN },
          { key: 'linha', term: 'Linha', description: channel.label },
          { key: 'api', term: 'Platform API', description: info.apiCommit ?? `${UNKNOWN} (o runner local informa o commit da API)` },
          { key: 'lib', term: 'Nekkora-lib', description: info.lib ?? UNKNOWN },
        ]}
      />
      {channel.candidate && (
        <Text variant="body-sm" color="secondary">
          Esta é uma versão candidata: ainda não foi integrada à main.
        </Text>
      )}
    </>
  );
}
