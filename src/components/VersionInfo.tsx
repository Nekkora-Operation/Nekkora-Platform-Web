import { DescriptionList, Text } from 'nekkora-lib';
import { buildInfo, channelOf, UNKNOWN, versionLine, type BuildInfo } from '../app/version';

/** Rodapé discreto: qual versão está rodando (Web, situação da branch e API). */
export function VersionFooter({ info = buildInfo() }: { info?: BuildInfo }) {
  return (
    <span className="pw-shell__footer-version" aria-label={`Versão em execução: ${versionLine(info)}`}>
      {versionLine(info)}
    </span>
  );
}

/** "Sobre esta versão" (Minha conta): detalhes completos, para informar num relato de problema. */
export function VersionDetails({ info = buildInfo() }: { info?: BuildInfo }) {
  const channel = channelOf(info);
  return (
    <>
      <DescriptionList
        items={[
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
