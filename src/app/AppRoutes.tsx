import { Route, Routes } from 'react-router';
import { features } from '../config';
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

/**
 * Todas as rotas vivem sob /o/:orgId. Sem organização na URL → estado controlado (V1 não resolve de outra
 * forma). Nada de cadastro público, login corporativo ou "manter conectado".
 */
export function AppRoutes() {
  return (
    <Routes>
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
        <Route path="verify-email" element={<VerifyEmailPage />} />
        {features.resendVerification && <Route path="resend-verification" element={<ResendVerificationPage />} />}
        <Route path="*" element={<NotFoundInOrganizationPage />} />
      </Route>
      <Route path="*" element={<NoOrganizationPage />} />
    </Routes>
  );
}
