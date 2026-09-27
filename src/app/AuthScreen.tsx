import type { ReactNode } from 'react';
import { AuthContextBadge, AuthLayout, Logo, Text, type IconName } from 'nekkora-lib';
import { shortOrganizationId } from '../auth/organization';
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

function BrandAside() {
  return (
    <div className="pw-aside">
      <Logo variant="symbol" size={44} />
      <Text as="p" variant="h2" className="pw-aside__statement">
        Automação com clareza,
        <br />
        <span className="pw-aside__accent">operação com confiança.</span>
      </Text>
      <ul className="pw-aside__pillars" aria-label="Pilares da Nekkora">
        {PILLARS.map((p) => (
          <li key={p}>{p}.</li>
        ))}
      </ul>
    </div>
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
      context={
        org ? (
          <AuthContextBadge
            label="Acessando a organização"
            value={
              <span className="pw-org-id" title={org}>
                {shortOrganizationId(org)}
              </span>
            }
          />
        ) : undefined
      }
      aside={<BrandAside />}
      footer={<span>Acesso protegido · Nekkora Platform</span>}
    >
      {children}
    </AuthLayout>
  );
}
