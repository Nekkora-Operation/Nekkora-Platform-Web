import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { AppRoutes } from '../app/AppRoutes';

/** Mostra o caminho atual para as asserções de preservação da organização. */
function LocationProbe() {
  const { pathname } = useLocation();
  return <output data-testid="location">{pathname}</output>;
}

export function renderApp(path: string) {
  // StrictMode como na aplicação: efeitos duplicados não podem reenviar requisições de uso único
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </StrictMode>,
  );
}
