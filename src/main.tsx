import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import 'nekkora-lib/styles.css';
import './app/global.css';
import { AppRoutes } from './app/AppRoutes';
import { captureInitialLinkToken } from './auth/linkToken';
import { applyThemeToDocument, readStoredTheme } from './app/theme';

// Antes de qualquer renderização: tira o token de redefinição/verificação da URL e guarda só em memória.
captureInitialLinkToken();
// O tema escolhido antes da primeira pintura: sem piscar no tema padrão ao abrir (PLATFORM-FLUXO-002).
applyThemeToDocument(readStoredTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>,
);
