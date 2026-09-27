import { createHmac, randomBytes } from 'node:crypto';

/** TOTP (RFC 6238) com os parâmetros do contrato: HMAC-SHA1, 6 dígitos, passo de 30 s. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

export function base32Decode(input: string): Buffer {
  let bits = '';
  for (const ch of input.replace(/[\s=-]/g, '').toUpperCase()) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('chave base32 inválida');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** Segredo de 160 bits em base32 (como a API). */
export const newSecret = () => base32Encode(randomBytes(20));

export const currentStep = (now = Date.now()) => Math.floor(now / 30_000);

export function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Passo aceito (tolerância de ±1) ou null. O anti-replay (passo > último aceito) fica com quem chama. */
export function acceptedStep(secret: string, code: string, lastStep: number, now = Date.now()): number | null {
  const p = currentStep(now);
  for (const s of [p - 1, p, p + 1]) if (s > lastStep && totp(secret, s) === code) return s;
  return null;
}

/** Aplicativo autenticador de teste, a partir da chave exibida na tela. */
export class Authenticator {
  private lastStep = 0;

  constructor(private readonly secret: string) {}

  /** Código de um passo ainda não usado; se estiver além da tolerância, espera o relógio andar. */
  async next(): Promise<string> {
    for (;;) {
      const now = currentStep();
      const step = Math.max(now, this.lastStep + 1);
      if (step <= now + 1) {
        this.lastStep = step;
        return totp(this.secret, step);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  /** Código sabidamente errado agora. */
  wrong(): string {
    const now = currentStep();
    const valid = new Set([now - 1, now, now + 1].map((s) => totp(this.secret, s)));
    for (let i = 0; ; i++) {
      const c = String((123456 + i * 7919) % 1_000_000).padStart(6, '0');
      if (!valid.has(c)) return c;
    }
  }
}
