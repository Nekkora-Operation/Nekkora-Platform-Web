import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppearanceSection } from '../components/AppearanceSection';
import { DEFAULT_THEME, PLATFORM_THEMES, PlatformThemeProvider, THEME_STORAGE_KEY } from './theme';

/** PLATFORM-FLUXO-002 — temas: padrão Nekkora Light, só três opções, aplicação no documento e persistência neste navegador. */
const html = () => document.documentElement;
const mount = () =>
  render(
    <PlatformThemeProvider>
      <AppearanceSection />
    </PlatformThemeProvider>,
  );

describe('Temas da Platform', () => {
  beforeEach(() => {
    localStorage.clear();
    html().removeAttribute('data-nk-theme');
  });

  it('abre em Nekkora Light, com as três opções, sem gravar nada', () => {
    mount();
    expect(DEFAULT_THEME).toBe('light');
    expect(html().getAttribute('data-nk-theme')).toBe('light');
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.textContent ?? r.getAttribute('aria-label'))).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /^Nekkora Light/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Nekkora Dark/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Sakura Dark/ })).toBeInTheDocument();
    expect(PLATFORM_THEMES).toEqual(['light', 'dark', 'sakura-dark']);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('a escolha vale na hora para o documento e fica guardada para a próxima sessão', () => {
    const first = mount();
    fireEvent.click(screen.getByRole('radio', { name: /^Sakura Dark/ }));
    expect(html().getAttribute('data-nk-theme')).toBe('sakura-dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('sakura-dark');
    first.unmount();
    // nova sessão (outra montagem da aplicação): o tema guardado é o aplicado
    mount();
    expect(screen.getByRole('radio', { name: /^Sakura Dark/ })).toBeChecked();
    expect(html().getAttribute('data-nk-theme')).toBe('sakura-dark');
  });

  it('valor guardado desconhecido (outro tema da biblioteca ou lixo) vale como o padrão', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'midnight-blue');
    mount();
    expect(html().getAttribute('data-nk-theme')).toBe('light');
    expect(screen.getByRole('radio', { name: /^Nekkora Light/ })).toBeChecked();
  });

  it('outra aba trocou o tema: esta acompanha', () => {
    mount();
    act(() => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }));
    });
    expect(html().getAttribute('data-nk-theme')).toBe('dark');
  });
});
