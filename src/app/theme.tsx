import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ThemeProvider, themes } from 'nekkora-lib';

/**
 * PLATFORM-FLUXO-002 — temas selecionáveis da Platform. Só os três temas oferecidos ao usuário; os demais temas da
 * Nekkora-Lib não são oferecidos e, se aparecerem guardados, valem como o padrão.
 *
 * A preferência fica NESTE navegador (localStorage), entre sessões: sair e entrar de novo mantém o tema. Não é dado de
 * conta e não vai ao servidor; outro navegador ou computador começa no padrão.
 */
export const PLATFORM_THEMES = ['light', 'dark', 'sakura-dark'] as const;
export type PlatformTheme = (typeof PLATFORM_THEMES)[number];
export const DEFAULT_THEME: PlatformTheme = 'light';
export const THEME_STORAGE_KEY = 'nekkora.platform.tema';

export const THEME_TEXT: Record<PlatformTheme, { label: string; description: string }> = {
  dark: { label: 'Nekkora Dark', description: 'Escuro, com o rosa da Nekkora.' },
  light: { label: 'Nekkora Light', description: 'Claro, para ambientes iluminados. É o tema padrão.' },
  'sakura-dark': { label: 'Sakura Dark', description: 'Escuro, com tons de cerejeira.' },
};

const isPlatformTheme = (v: unknown): v is PlatformTheme => typeof v === 'string' && (PLATFORM_THEMES as readonly string[]).includes(v);

export function readStoredTheme(): PlatformTheme {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPlatformTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Aplica o tema ao documento: o atributo que a Nekkora-Lib usa e a cor da barra do navegador em celulares. */
export function applyThemeToDocument(theme: PlatformTheme) {
  const html = document.documentElement;
  html.setAttribute('data-nk-theme', theme);
  html.setAttribute('data-nk-mode', themes[theme].mode);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themes[theme].palette.bg);
}

interface PlatformThemeValue {
  theme: PlatformTheme;
  setTheme: (t: PlatformTheme) => void;
}
const Ctx = createContext<PlatformThemeValue | null>(null);

/** Tema da aplicação inteira (área da identidade e área da organização). */
export function PlatformThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<PlatformTheme>(readStoredTheme);
  const setTheme = useCallback((t: PlatformTheme) => {
    if (!isPlatformTheme(t)) return;
    setThemeState(t);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      /* armazenamento indisponível: o tema vale até fechar a aba */
    }
  }, []);
  // outra aba trocou o tema: esta acompanha
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setThemeState(isPlatformTheme(e.newValue) ? e.newValue : DEFAULT_THEME);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => applyThemeToDocument(theme), [theme]);
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return (
    <Ctx.Provider value={value}>
      <ThemeProvider theme={theme} target="document">
        {children}
      </ThemeProvider>
    </Ctx.Provider>
  );
}

export function usePlatformTheme(): PlatformThemeValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlatformTheme fora do PlatformThemeProvider');
  return v;
}
