import { createHmac } from 'node:crypto';

/** Aplicativo autenticador de teste (RFC 6238: HMAC-SHA1, 6 dígitos, 30 s), a partir da chave exibida na tela. */
function base32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.replace(/[\s=-]/g, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('chave base32 inválida');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function code(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export class Authenticator {
  private readonly secret: Buffer;
  private lastStep = 0;

  constructor(manualKey: string) {
    this.secret = base32(manualKey);
  }

  /**
   * Código de um passo ainda não usado. A API aplica anti-replay (passo > último aceito) e aceita +/-1 passo;
   * se o próximo passo livre estiver além da tolerância, espera o relógio andar — como uma pessoa faria.
   */
  async next(): Promise<string> {
    for (;;) {
      const now = Math.floor(Date.now() / 30_000);
      const step = Math.max(now, this.lastStep + 1);
      if (step <= now + 1) {
        this.lastStep = step;
        return code(this.secret, step);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  /** Código sabidamente errado (nunca coincide com os passos aceitos agora). */
  wrong(): string {
    const now = Math.floor(Date.now() / 30_000);
    const valid = new Set([now - 1, now, now + 1].map((s) => code(this.secret, s)));
    for (let i = 0; ; i++) {
      const c = String((123456 + i * 7919) % 1_000_000).padStart(6, '0');
      if (!valid.has(c)) return c;
    }
  }
}
