import { Outlet, Route, Routes } from 'react-router';
import { features } from '../config';
import { IdentityFlowProvider } from '../auth/flow';
import { AccountPage, ReplaceFactorPage } from '../identity/AccountPages';
import { CreateOrganizationPage } from '../identity/CreateOrganizationPage';
import { OrganizationEntryPage, RecoverPasswordRoute, RootPage } from '../identity/EntryPages';
import { IdentityArea } from '../identity/IdentityArea';
import { LinkAccountPage } from '../identity/LinkAccountPage';
import { OrganizationsPage } from '../identity/OrganizationsPage';
import { SignupConfirmPage, SignupPage } from '../identity/SignupPages';
import { ForgotPasswordPage, ResendVerificationPage } from '../pages/EmailRequestPage';
import { AuthenticatedArea } from '../area/AuthenticatedArea';
import { ClientsPage } from '../pages/admin/ClientsPage';
import { GrantsPage } from '../pages/admin/GrantsPage';
import { MembersPage } from '../pages/admin/MembersPage';
import { ExecutionsPage } from '../pages/ExecutionsPage';
import { AutomationDetailPage } from '../pages/product/AutomationDetailPage';
import { ExecutionDetailPage } from '../pages/product/ExecutionDetailPage';
import { WorkspaceDetailPage } from '../pages/product/WorkspaceDetailPage';
import { WorkspacesPage } from '../pages/product/WorkspacesPage';
import { InternalHome } from '../pages/HomePage';
import { LoginPage } from '../pages/LoginPage';
import { MfaPage } from '../pages/MfaPage';
import { MfaSetupPage } from '../pages/MfaSetupPage';
import { ResetPasswordPage } from '../pages/ResetPasswordPage';
import { NoOrganizationPage, NotFoundInOrganizationPage } from '../pages/StatusPages';
import { VerifyEmailPage } from '../pages/VerifyEmailPage';
import { OrganizationRoute } from './organization';

/** Telas de entrada da identidade (mesmas páginas da entrada por organização, com o fluxo da identidade). */
function IdentityFlowOutlet() {
  return (
    <IdentityFlowProvider>
      <Outlet />
    </IdentityFlowProvider>
  );
}

/**
 * Duas portas de entrada, como a API:
 * - identidade Nekkora (fora de /o/{org}): cadastro, entrada geral, organizações, criação, vinculação e segurança da
 *   conta; a troca dá a sessão de organização;
 * - /o/:orgId: área da organização (sessão de organização) e a entrada antiga por conta de organização não vinculada.
 * Os caminhos dos links de e-mail são contrato da API: /cadastro/confirmar, /recuperar-senha, /o/{org}/recuperar-senha e
 * /o/{org}/convite. Nada de login corporativo nem "manter conectado".
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootPage />} />
      <Route element={<IdentityFlowOutlet />}>
        <Route path="/entrar" element={<LoginPage />} />
        <Route path="/entrar/verificacao" element={<MfaPage />} />
        <Route path="/entrar/configurar-autenticador" element={<MfaSetupPage />} />
      </Route>
      <Route path="/recuperar-senha" element={<RecoverPasswordRoute />} />
      <Route path="/cadastro" element={<SignupPage />} />
      <Route path="/cadastro/confirmar" element={<SignupConfirmPage />} />
      <Route element={<IdentityArea />}>
        <Route path="/organizacoes" element={<OrganizationsPage />} />
        <Route path="/organizacoes/nova" element={<CreateOrganizationPage />} />
        <Route path="/conta" element={<AccountPage />} />
        <Route path="/conta/fator" element={<ReplaceFactorPage />} />
        <Route path="/vincular-conta" element={<LinkAccountPage />} />
      </Route>
      <Route path="/o/:orgId" element={<OrganizationRoute />}>
        {/* área autenticada: o portão carrega /me e só monta as rotas internas para conta interna */}
        <Route element={<AuthenticatedArea />}>
          <Route index element={<InternalHome />} />
          <Route path="execucoes" element={<ExecutionsPage />} />
          <Route path="execucoes/:executionId" element={<ExecutionDetailPage />} />
          <Route path="workspaces" element={<WorkspacesPage />} />
          <Route path="workspaces/:workspaceId" element={<WorkspaceDetailPage />} />
          <Route path="automacoes/:automationId" element={<AutomationDetailPage />} />
          {/* F6a-1: administração, só leitura; o acesso de cada tela é decidido pela API (403 → estado próprio) */}
          <Route path="administracao/membros" element={<MembersPage />} />
          <Route path="administracao/clientes" element={<ClientsPage />} />
          <Route path="administracao/concessoes" element={<GrantsPage />} />
        </Route>
        <Route path="login" element={<LoginPage />} />
        <Route path="mfa" element={<MfaPage />} />
        <Route path="mfa/setup" element={<MfaSetupPage />} />
        <Route path="forgot-password" element={<ForgotPasswordPage />} />
        <Route path="reset-password" element={<ResetPasswordPage />} />
        {/* caminho do link do e-mail (contrato da API); reset-password fica como compatibilidade */}
        <Route path="recuperar-senha" element={<ResetPasswordPage />} />
        <Route path="entrar" element={<OrganizationEntryPage />} />
        <Route path="verify-email" element={<VerifyEmailPage />} />
        {features.resendVerification && <Route path="resend-verification" element={<ResendVerificationPage />} />}
        <Route path="*" element={<NotFoundInOrganizationPage />} />
      </Route>
      <Route path="*" element={<NoOrganizationPage />} />
    </Routes>
  );
}
