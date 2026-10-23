import { createCipheriv } from "node:crypto";

// AES-128-CMAC (RFC 4493). node:crypto has no CMAC, but ECB with no padding is enough to build it.

const RB = 0x87;

function aesBlock(key: Buffer, block: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}

function shiftLeft(b: Buffer): Buffer {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = ((b[i] as number) << 1) | (i < 15 ? (b[i + 1] as number) >> 7 : 0);
  if (((b[0] as number) & 0x80) !== 0) out[15] = (out[15] as number) ^ RB;
  return out;
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = (a[i] as number) ^ (b[i] as number);
  return out;
}

export function aesCmac(key: Buffer, message: Buffer): Buffer {
  if (key.length !== 16) throw new Error("AES-CMAC key must be 16 bytes");
  const k1 = shiftLeft(aesBlock(key, Buffer.alloc(16)));
  const k2 = shiftLeft(k1);

  const n = Math.max(1, Math.ceil(message.length / 16));
  const complete = message.length > 0 && message.length % 16 === 0;
  let last: Buffer = Buffer.alloc(16);
  message.copy(last, 0, (n - 1) * 16);
  if (complete) {
    last = xor(last, k1);
  } else {
    last[message.length - (n - 1) * 16] = 0x80;
    last = xor(last, k2);
  }

  let x: Buffer = Buffer.alloc(16);
  for (let i = 0; i < n - 1; i++) x = aesBlock(key, xor(x, message.subarray(i * 16, i * 16 + 16)));
  return aesBlock(key, xor(x, last));
}
