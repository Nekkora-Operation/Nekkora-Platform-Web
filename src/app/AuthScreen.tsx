import type { ReactNode } from 'react';
import { AuthContextBadge, AuthLayout, Text, type IconName } from 'nekkora-lib';
import { organizationName, shortOrganizationId } from '../auth/organization';
import './AuthScreen.css';

export interface AuthScreenProps {
  /** Organização resolvida pela URL (exibida de forma discreta e não editável). */
  org?: string;
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  /** Chave da etapa: ao mudar, o foco vai para o título (leitores de tela anunciam a nova etapa). */
  stepKey?: string;
  focusTitle?: boolean;
  children?: ReactNode;
}

const PILLARS = ['Execution', 'Knowledge', 'Observability', 'Reliability', 'Automation'];

/** Painel institucional (telas largas): headline, descrição curta e a assinatura dos pilares. */
function BrandPanel() {
  return (
    <div className="pw-brand">
      <Text as="p" variant="overline" className="pw-brand__eyebrow">
        Nekkora Platform
      </Text>
      <Text as="p" variant="display" className="pw-brand__headline">
        Automação com clareza, <span className="pw-brand__accent">operação com confiança.</span>
      </Text>
      <Text as="p" color="secondary" className="pw-brand__description">
        Orquestre automações, acompanhe execuções e mantenha o conhecimento da operação em um só lugar — com
        acesso protegido por verificação em duas etapas.
      </Text>
      <ul className="pw-brand__pillars" aria-label="Pilares da Nekkora">
        {PILLARS.map((p) => (
          <li key={p}>
            <span>
              <span className="pw-brand__initial">{p[0]}</span>
              {p.slice(1)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Organização vinda da URL: nome humano quando o contrato permitir; senão, o identificador abreviado. */
function OrganizationContext({ org }: { org: string }) {
  const name = organizationName(org);
  return (
    <AuthContextBadge
      label="Organização"
      value={
        name ? (
          <span title={org}>{name}</span>
        ) : (
          <span className="pw-org-id" title={org}>
            {shortOrganizationId(org)}
          </span>
        )
      }
    />
  );
}

/** Todas as telas de autenticação usam esta mesma estrutura (AuthLayout da nekkora-lib). */
export function AuthScreen({ org, title, description, icon, actions, stepKey, focusTitle, children }: AuthScreenProps) {
  return (
    <AuthLayout
      title={title}
      description={description}
      icon={icon}
      actions={actions}
      stepKey={stepKey}
      focusTitle={focusTitle}
      context={org ? <OrganizationContext org={org} /> : undefined}
      aside={<BrandPanel />}
      footer={<span>Acesso protegido · Nekkora Platform</span>}
    >
      {children}
    </AuthLayout>
  );
}
