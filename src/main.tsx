import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import 'nekkora-lib/styles.css';
import './app/global.css';
import { AppRoutes } from './app/AppRoutes';
import { captureInitialLinkToken } from './auth/linkToken';

// Antes de qualquer renderização: tira o token de redefinição/verificação da URL e guarda só em memória.
captureInitialLinkToken();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>,
);
