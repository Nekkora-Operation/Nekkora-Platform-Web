import { Route, Routes } from 'react-router';
import { features } from '../config';
import { ForgotPasswordPage, ResendVerificationPage } from '../pages/EmailRequestPage';
import { HomePage } from '../pages/HomePage';
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
        <Route index element={<HomePage />} />
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
