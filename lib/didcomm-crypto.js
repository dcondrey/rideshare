// @ts-check
/**
 * DIDComm Messaging v2.1 encryption envelopes over X25519, with node:crypto
 * only. JWE JSON general serialization, media type
 * application/didcomm-encrypted+json.
 *
 *   authcrypt  ECDH-1PU+A256KW (draft-madden-jose-ecdh-1pu-04) + A256CBC-HS512
 *              Z = Ze || Zs; the content tag is fed into the KDF (cctag), so
 *              the payload is encrypted first and the key wrapped after.
 *   anoncrypt  ECDH-ES+A256KW (RFC 7518 §4.6) + A256CBC-HS512
 *
 * Both share one ephemeral key, apu/apv and alg across all recipients in the
 * protected header, as the spec requires. A256CBC-HS512 is the one content
 * algorithm DIDComm requires for both modes, so it is the only one supported;
 * A256GCM and XC20P (anoncrypt-only, optional) are refused on unpack.
 *
 * Tested against the DIDComm spec's ENCRYPTED_MSG_AUTH_X25519 vector
 * (tests/vectors/didcomm-authcrypt-x25519.json) and against didcomm-rust.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ENCRYPTED_TYP = "application/didcomm-encrypted+json";
const AUTHCRYPT = "ECDH-1PU+A256KW";
const ANONCRYPT = "ECDH-ES+A256KW";
const ENC = "A256CBC-HS512";
const KW_IV = Buffer.from("A6A6A6A6A6A6A6A6", "hex");

/** @param {Buffer | Uint8Array | string} b */
const b64u = (b) => Buffer.from(b).toString("base64url");
/** @param {string} s */
const unb64u = (s) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  return Buffer.from(s, "base64url");
};

/** @param {number} n */
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** @param {Buffer} b */
const lenPrefixed = (b) => Buffer.concat([u32(b.length), b]);

/**
 * One-step Concat KDF (NIST SP 800-56A, RFC 7518 §4.6.2) for a 256-bit KEK,
 * one SHA-256 round. `cctag` (ECDH-1PU only) extends SuppPubInfo.
 * @param {Buffer} z @param {string} alg @param {Buffer} apu @param {Buffer} apv @param {Buffer} [cctag]
 */
export function concatKdf(z, alg, apu, apv, cctag) {
  const suppPub = cctag ? Buffer.concat([u32(256), lenPrefixed(cctag)]) : u32(256);
  const otherInfo = Buffer.concat([
    lenPrefixed(Buffer.from(alg, "ascii")),
    lenPrefixed(apu),
    lenPrefixed(apv),
    suppPub,
  ]);
  return createHash("sha256")
    .update(Buffer.concat([u32(1), z, otherInfo]))
    .digest();
}

/** @param {Buffer} kek @param {Buffer} cek */
function wrap(kek, cek) {
  const c = createCipheriv("aes256-wrap", kek, KW_IV);
  return Buffer.concat([c.update(cek), c.final()]);
}

/** @param {Buffer} kek @param {Buffer} wrapped */
function unwrap(kek, wrapped) {
  const d = createDecipheriv("aes256-wrap", kek, KW_IV);
  return Buffer.concat([d.update(wrapped), d.final()]);
}

/** RFC 7518 §5.2.2.1 and §5.2.5. @param {Buffer} cek 64 bytes @param {Buffer} iv @param {Buffer} aad */
function cbcHmacTag(cek, iv, ciphertext, aad) {
  const al = Buffer.alloc(8);
  al.writeBigUInt64BE(BigInt(aad.length * 8));
  return createHmac("sha512", cek.subarray(0, 32))
    .update(Buffer.concat([aad, iv, ciphertext, al]))
    .digest()
    .subarray(0, 32);
}

/**
 * HChaCha20 (draft-irtf-cfrg-xchacha-03 §2.2): derives the XChaCha20 subkey
 * from a 256-bit key and the first 16 bytes of the 24-byte nonce. Node has the
 * IETF ChaCha20-Poly1305 but no XChaCha, so this is the one missing piece.
 * @param {Buffer} key @param {Buffer} nonce16
 */
export function hchacha20(key, nonce16) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(i * 4);
  /** @param {number} v @param {number} n */
  const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
  /** @param {number} a @param {number} b @param {number} c @param {number} d */
  const qr = (a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0;
    s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0;
    s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0;
    s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0;
    s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12);
    qr(1, 5, 9, 13);
    qr(2, 6, 10, 14);
    qr(3, 7, 11, 15);
    qr(0, 5, 10, 15);
    qr(1, 6, 11, 12);
    qr(2, 7, 8, 13);
    qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => {
    out.writeUInt32LE(s[w], i * 4);
  });
  return out;
}

/** @param {Buffer} cek @param {Buffer} iv 24 bytes */
const xchachaParams = (cek, iv) => ({
  key: hchacha20(cek, iv.subarray(0, 16)),
  nonce: Buffer.concat([Buffer.alloc(4), iv.subarray(16, 24)]),
});

/**
 * Content encryption algorithms, by JWE `enc`. A256CBC-HS512 is required for
 * both modes; A256GCM and XC20P are anoncrypt-only (ECDH-1PU needs a
 * committing AEAD).
 * @type {Record<string, { cekLen: number, ivLen: number,
 *   encrypt: (cek: Buffer, iv: Buffer, pt: Buffer, aad: Buffer) => { ciphertext: Buffer, tag: Buffer },
 *   decrypt: (cek: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer) => Buffer }>}
 */
const CONTENT = {
  "A256CBC-HS512": {
    cekLen: 64,
    ivLen: 16,
    encrypt: (cek, iv, pt, aad) => {
      const c = createCipheriv("aes-256-cbc", cek.subarray(32, 64), iv);
      const ciphertext = Buffer.concat([c.update(pt), c.final()]);
      return { ciphertext, tag: cbcHmacTag(cek, iv, ciphertext, aad) };
    },
    decrypt: (cek, iv, ct, tag, aad) => {
      const expected = cbcHmacTag(cek, iv, ct, aad);
      if (tag.length !== 32 || !timingSafeEqual(tag, expected)) {
        throw new Error("content authentication tag mismatch");
      }
      const d = createDecipheriv("aes-256-cbc", cek.subarray(32, 64), iv);
      return Buffer.concat([d.update(ct), d.final()]);
    },
  },
  A256GCM: {
    cekLen: 32,
    ivLen: 12,
    encrypt: (cek, iv, pt, aad) => {
      const c = createCipheriv("aes-256-gcm", cek, iv).setAAD(aad);
      const ciphertext = Buffer.concat([c.update(pt), c.final()]);
      return { ciphertext, tag: c.getAuthTag() };
    },
    decrypt: (cek, iv, ct, tag, aad) => {
      if (tag.length !== 16) throw new Error("content authentication tag mismatch");
      const d = createDecipheriv("aes-256-gcm", cek, iv).setAAD(aad).setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    },
  },
  XC20P: {
    cekLen: 32,
    ivLen: 24,
    encrypt: (cek, iv, pt, aad) => {
      const { key, nonce } = xchachaParams(cek, iv);
      const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 }).setAAD(aad, {
        plaintextLength: pt.length,
      });
      const ciphertext = Buffer.concat([c.update(pt), c.final()]);
      return { ciphertext, tag: c.getAuthTag() };
    },
    decrypt: (cek, iv, ct, tag, aad) => {
      if (tag.length !== 16) throw new Error("content authentication tag mismatch");
      const { key, nonce } = xchachaParams(cek, iv);
      const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 })
        .setAAD(aad, { plaintextLength: ct.length })
        .setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    },
  },
};

/** @param {{ x: string }} jwk */
export function x25519PublicKey(jwk) {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: jwk.x }, format: "jwk" });
}

/** @param {import("node:crypto").KeyObject} k */
const xOf = (k) => /** @type {{ x: string }} */ (k.export({ format: "jwk" })).x;

/** apv: SHA-256 of the sorted recipient kids joined with "." (DIDComm §Encryption). @param {string[]} kids */
function apvFor(kids) {
  return createHash("sha256")
    .update([...kids].sort().join("."))
    .digest();
}

/**
 * Encrypt a plaintext DIDComm message for one recipient DID's keys.
 * Authcrypt when `sender` is given, anoncrypt otherwise.
 * @param {Record<string, unknown>} message
 * @param {{ kid: string, publicKey: import("node:crypto").KeyObject }[]} recipients
 * @param {{ kid: string, privateKey: import("node:crypto").KeyObject }} [sender]
 * @param {{ enc?: "A256CBC-HS512" | "A256GCM" | "XC20P" }} [opts] anoncrypt content algorithm
 */
export function packEncrypted(message, recipients, sender, opts = {}) {
  if (recipients.length === 0) throw new Error("no recipient keys");
  const enc = sender ? ENC : opts.enc || ENC;
  const content = CONTENT[enc];
  const epk = generateKeyPairSync("x25519");
  const apv = apvFor(recipients.map((r) => r.kid));
  const alg = sender ? AUTHCRYPT : ANONCRYPT;
  /** @type {Record<string, unknown>} */
  const header = {
    typ: ENCRYPTED_TYP,
    alg,
    enc,
    ...(sender ? { skid: sender.kid, apu: b64u(sender.kid) } : {}),
    apv: b64u(apv),
    epk: { kty: "OKP", crv: "X25519", x: xOf(epk.publicKey) },
  };
  const protectedB64 = b64u(JSON.stringify(header));
  const cek = randomBytes(content.cekLen);
  const iv = randomBytes(content.ivLen);
  const { ciphertext, tag } = content.encrypt(
    cek,
    iv,
    Buffer.from(JSON.stringify(message), "utf8"),
    Buffer.from(protectedB64, "ascii"),
  );
  const apu = sender ? Buffer.from(sender.kid, "utf8") : Buffer.alloc(0);
  return {
    protected: protectedB64,
    recipients: recipients.map((r) => {
      const ze = diffieHellman({ privateKey: epk.privateKey, publicKey: r.publicKey });
      const z = sender
        ? Buffer.concat([
            ze,
            diffieHellman({ privateKey: sender.privateKey, publicKey: r.publicKey }),
          ])
        : ze;
      const kek = concatKdf(z, alg, apu, apv, sender ? tag : undefined);
      return { header: { kid: r.kid }, encrypted_key: b64u(wrap(kek, cek)) };
    }),
    iv: b64u(iv),
    ciphertext: b64u(ciphertext),
    tag: b64u(tag),
  };
}

/**
 * Decrypt an encrypted DIDComm message addressed to one of `myKeys`.
 * For authcrypt, `senderKey(skid)` returns the sender's public X25519 key.
 * @param {unknown} jwe
 * @param {Map<string, import("node:crypto").KeyObject>} myKeys  kid → X25519 private key
 * @param {(skid: string) => Promise<import("node:crypto").KeyObject>} senderKey
 * @returns {Promise<{ message: Record<string, unknown>, authcrypt: boolean, senderKid: string | null, recipientKid: string }>}
 */
export async function unpackEncrypted(jwe, myKeys, senderKey) {
  const env = /** @type {Record<string, unknown>} */ (jwe && typeof jwe === "object" ? jwe : {});
  const header = JSON.parse(unb64u(String(env.protected)).toString("utf8"));
  if (header.alg !== AUTHCRYPT && header.alg !== ANONCRYPT)
    throw new Error(`unsupported alg ${header.alg}`);
  const content = Object.hasOwn(CONTENT, header.enc) ? CONTENT[header.enc] : null;
  if (!content) throw new Error(`unsupported enc ${header.enc}`);
  if (header.alg === AUTHCRYPT && header.enc !== ENC) {
    throw new Error("authcrypt requires A256CBC-HS512 (ECDH-1PU needs a committing AEAD)");
  }
  if (header.epk?.kty !== "OKP" || header.epk?.crv !== "X25519")
    throw new Error("epk must be an X25519 key");
  const authcrypt = header.alg === AUTHCRYPT;
  const recipients = Array.isArray(env.recipients) ? env.recipients : [];
  const mine = recipients.find((r) => r && myKeys.has(r.header?.kid));
  if (!mine) throw new Error("message is not addressed to any of this deployment's keys");
  const kids = recipients.map((r) => String(r.header?.kid));
  if (header.apv !== b64u(apvFor(kids)))
    throw new Error("apv does not match the recipient key ids");

  const tag = unb64u(String(env.tag));
  const epk = x25519PublicKey(header.epk);
  const myKey = /** @type {import("node:crypto").KeyObject} */ (myKeys.get(mine.header.kid));
  let z = diffieHellman({ privateKey: myKey, publicKey: epk });
  /** @type {string | null} */
  let senderKid = null;
  let apu = Buffer.alloc(0);
  if (authcrypt) {
    senderKid = header.skid ?? (header.apu ? unb64u(header.apu).toString("utf8") : null);
    if (!senderKid) throw new Error("authcrypt message names no sender key");
    if (header.apu && unb64u(header.apu).toString("utf8") !== senderKid)
      throw new Error("apu does not match skid");
    apu = Buffer.from(senderKid, "utf8");
    z = Buffer.concat([
      z,
      diffieHellman({ privateKey: myKey, publicKey: await senderKey(senderKid) }),
    ]);
  }
  const kek = concatKdf(z, header.alg, apu, unb64u(header.apv), authcrypt ? tag : undefined);
  const cek = unwrap(kek, unb64u(String(mine.encrypted_key)));
  if (cek.length !== content.cekLen) throw new Error("unwrapped key has the wrong length for enc");
  const iv = unb64u(String(env.iv));
  if (iv.length !== content.ivLen) throw new Error("iv has the wrong length for enc");
  const plaintext = content.decrypt(
    cek,
    iv,
    unb64u(String(env.ciphertext)),
    tag,
    Buffer.from(String(env.protected), "ascii"),
  );
  const message = JSON.parse(plaintext.toString("utf8"));
  if (authcrypt && senderKid && message.from !== senderKid.split("#")[0]) {
    throw new Error("plaintext from does not match the encryption sender");
  }
  return { message, authcrypt, senderKid, recipientKid: mine.header.kid };
}
