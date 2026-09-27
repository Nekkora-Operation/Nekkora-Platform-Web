/**
 * Leitura do URI otpauth:// RECEBIDO do servidor, só para exibir a chave de configuração manual. O frontend
 * nunca gera segredo TOTP.
 */
export function manualKeyFromOtpauth(uri: string): string | null {
  try {
    const secret = new URL(uri).searchParams.get('secret');
    if (!secret || !/^[A-Z2-7]+=*$/i.test(secret)) return null;
    return secret.replace(/=+$/, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
  } catch {
    return null;
  }
}
