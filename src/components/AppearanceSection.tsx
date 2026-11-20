import { Button, Card, RadioGroup, SectionHeader, Stack } from 'nekkora-lib';
import { PLATFORM_THEMES, THEME_TEXT, usePlatformTheme, type PlatformTheme } from '../app/theme';

/**
 * PLATFORM-FLUXO-002 — escolha do tema, na área da conta. A troca vale na hora para a aplicação inteira e fica guardada
 * neste navegador para as próximas sessões.
 */
export function AppearanceSection({ headingLevel = 'h2' }: { headingLevel?: 'h2' | 'h3' }) {
  const { theme, setTheme } = usePlatformTheme();
  return (
    <Card variant="outlined" padding="lg">
      <Stack gap={3}>
        <SectionHeader
          as={headingLevel}
          title="Aparência"
          description="O tema vale para toda a Platform neste navegador e continua escolhido nas próximas vezes que você entrar."
        />
        <RadioGroup
          legend="Tema"
          name="tema-da-platform"
          value={theme}
          onChange={(v) => setTheme(v as PlatformTheme)}
          options={PLATFORM_THEMES.map((t) => ({ value: t, label: THEME_TEXT[t].label, description: THEME_TEXT[t].description }))}
        />
      </Stack>
    </Card>
  );
}

const NEXT: Record<PlatformTheme, PlatformTheme> = { light: 'dark', dark: 'sakura-dark', 'sakura-dark': 'light' };

/**
 * Ícone de tema nas telas de entrada (antes de entrar na conta): cada clique passa ao próximo dos três temas, na ordem
 * Nekkora Light → Nekkora Dark → Sakura Dark. A escolha é a mesma da conta, guardada neste navegador. O rótulo acessível
 * diz o tema atual e o próximo.
 */
export function ThemeCycleButton() {
  const { theme, setTheme } = usePlatformTheme();
  const next = NEXT[theme];
  const label = `Tema: ${THEME_TEXT[theme].label}. Mudar para ${THEME_TEXT[next].label}`;
  return <Button variant="ghost" size="sm" icon={theme === 'light' ? 'sun' : 'moon'} aria-label={label} title={label} onClick={() => setTheme(next)} />;
}
