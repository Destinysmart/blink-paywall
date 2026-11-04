/**
 * Minimal L402 macaroon — mint + verify — on Web Crypto, so the same file runs
 * on Node 20+, Cloudflare Workers, Deno and Bun.
 *
 * Ported from blink-skills (blink/scripts/_l402_macaroon.js) and kept
 * WIRE-COMPATIBLE with it: tokens minted here validate with
 * `blink l402-verify` and vice versa (tests/macaroon.spec.js carries a frozen
 * byte-identical vector).
 *
 * Intentionally NOT the full libmacaroons v2 spec — a practical,
 * self-contained implementation of the L402 security model:
 *   1. Cryptographic binding: the macaroon encodes payment_hash, HMAC-signed
 *      with a secret root key -> only this server can mint valid tokens.
 *   2. Caveats: expiry + resource scope.
 *   3. The preimage remains the payment proof: sha256(preimage) == payment_hash,
 *      and the preimage only exists once OUR invoice was settled.
 *
 * Binary layout (base64url without padding on the wire):
 *   [0]          version byte (0x01)
 *   [1..32]      payment_hash (32 raw bytes)
 *   [33..N]      caveats as TLV: 0x01 expiry (uint64BE unix seconds), 0x02 resource (utf8)
 *   [N+1..N+32]  HMAC-SHA256(rootKey, bytes[0..N])
 */

const VERSION_BYTE = 0x01;
const PAYMENT_HASH_SIZE = 32;
const HMAC_SIZE = 32;
const CAVEAT_TYPE_EXPIRY = 0x01;
const CAVEAT_TYPE_RESOURCE = 0x02;

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── byte helpers (no Buffer: Workers and browsers do not have it) ────────────

export function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
        throw new Error('Invalid hex string.');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

export function bytesToHex(bytes) {
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return hex;
}

export function base64urlEncode(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(text) {
    const base64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function concat(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** Constant-time comparison: no early exit on the first differing byte. */
export function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

async function hmacSha256(key, data) {
    const cryptoKey = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    return new Uint8Array(await subtle.sign('HMAC', cryptoKey, data));
}

export async function sha256(data) {
    return new Uint8Array(await subtle.digest('SHA-256', data));
}

// ── macaroon ─────────────────────────────────────────────────────────────────

function encodeCaveats(caveats) {
    const parts = [];
    for (const caveat of caveats) {
        const head = new Uint8Array(3);
        head[0] = caveat.type;
        head[1] = (caveat.value.length >> 8) & 0xff;
        head[2] = caveat.value.length & 0xff;
        parts.push(head, caveat.value);
    }
    return concat(...parts);
}

function decodeCaveats(bytes) {
    const caveats = [];
    let offset = 0;
    while (offset + 3 <= bytes.length) {
        const type = bytes[offset];
        const length = (bytes[offset + 1] << 8) | bytes[offset + 2];
        offset += 3;
        if (offset + length > bytes.length) break; // malformed — truncate
        caveats.push({ type, value: bytes.subarray(offset, offset + length) });
        offset += length;
    }
    return caveats;
}

function isRootKey(rootKey) {
    return rootKey instanceof Uint8Array && rootKey.length === 32;
}

/**
 * Mint a macaroon bound to a payment hash.
 * @param {{paymentHash: string, rootKey: Uint8Array, expirySeconds?: number, resource?: string}} options
 *   expirySeconds: ABSOLUTE unix timestamp (seconds), not a duration.
 * @returns {Promise<string>} base64url macaroon
 */
export async function createMacaroon({ paymentHash, rootKey, expirySeconds, resource }) {
    if (!/^[0-9a-fA-F]{64}$/.test(paymentHash)) {
        throw new Error('paymentHash must be a 64-character hex string.');
    }
    if (!isRootKey(rootKey)) {
        throw new Error('rootKey must be a 32-byte Uint8Array.');
    }
    const caveats = [];
    if (expirySeconds !== undefined && expirySeconds !== null) {
        const value = new Uint8Array(8);
        new DataView(value.buffer).setBigUint64(0, BigInt(Math.floor(expirySeconds)));
        caveats.push({ type: CAVEAT_TYPE_EXPIRY, value });
    }
    if (resource !== undefined && resource !== null) {
        caveats.push({ type: CAVEAT_TYPE_RESOURCE, value: encoder.encode(resource) });
    }
    const body = concat(
        Uint8Array.of(VERSION_BYTE),
        hexToBytes(paymentHash),
        encodeCaveats(caveats)
    );
    return base64urlEncode(concat(body, await hmacSha256(rootKey, body)));
}

/**
 * Decode + verify the HMAC of a macaroon.
 * @returns {Promise<{signatureValid: boolean, paymentHash: string, expiresAt: number|null, resource: string|null}>}
 */
export async function decodeMacaroon({ macaroon, rootKey }) {
    if (!isRootKey(rootKey)) {
        throw new Error('rootKey must be a 32-byte Uint8Array.');
    }
    let raw;
    try {
        raw = base64urlDecode(macaroon);
    } catch {
        throw new Error('Macaroon is not valid base64url.');
    }
    if (raw.length < 1 + PAYMENT_HASH_SIZE + HMAC_SIZE) {
        throw new Error('Macaroon too short to be valid.');
    }
    if (raw[0] !== VERSION_BYTE) {
        throw new Error(`Unsupported macaroon version: 0x${raw[0].toString(16)}`);
    }
    const body = raw.subarray(0, raw.length - HMAC_SIZE);
    const signatureValid = timingSafeEqual(
        raw.subarray(raw.length - HMAC_SIZE),
        await hmacSha256(rootKey, body)
    );
    const paymentHash = bytesToHex(body.subarray(1, 1 + PAYMENT_HASH_SIZE));

    let expiresAt = null;
    let resource = null;
    for (const caveat of decodeCaveats(body.subarray(1 + PAYMENT_HASH_SIZE))) {
        if (caveat.type === CAVEAT_TYPE_EXPIRY && caveat.value.length === 8) {
            const view = new DataView(
                caveat.value.buffer,
                caveat.value.byteOffset,
                caveat.value.byteLength
            );
            expiresAt = Number(view.getBigUint64(0));
        } else if (caveat.type === CAVEAT_TYPE_RESOURCE) {
            resource = decoder.decode(caveat.value);
        }
    }
    return { signatureValid, paymentHash, expiresAt, resource };
}

/** sha256(preimage) === paymentHash — the proof the invoice was settled. */
export async function verifyPreimage(preimageHex, paymentHash) {
    if (!/^[0-9a-fA-F]{64}$/.test(preimageHex)) return false;
    if (!/^[0-9a-fA-F]{64}$/.test(paymentHash)) return false;
    const computed = await sha256(hexToBytes(preimageHex));
    return timingSafeEqual(computed, hexToBytes(paymentHash));
}

/**
 * Full token check. `authorization` is the raw Authorization header value.
 * @returns {Promise<{valid: boolean, reason?: string, paymentHash?: string}>}
 */
export async function verifyToken({ authorization, rootKey, resource, nowSeconds }) {
    const match = /^L402\s+([^:\s]+):([0-9a-fA-F]{64})$/i.exec(authorization || '');
    if (!match) return { valid: false, reason: 'malformed Authorization header' };
    const [, macaroon, preimage] = match;

    let decoded;
    try {
        decoded = await decodeMacaroon({ macaroon, rootKey });
    } catch (error) {
        return { valid: false, reason: error.message };
    }
    if (!decoded.signatureValid) return { valid: false, reason: 'invalid signature' };
    if (!(await verifyPreimage(preimage, decoded.paymentHash))) {
        return { valid: false, reason: 'preimage does not match payment hash' };
    }
    const now = nowSeconds !== undefined ? nowSeconds : Math.floor(Date.now() / 1000);
    if (decoded.expiresAt !== null && now > decoded.expiresAt) {
        return { valid: false, reason: 'token expired' };
    }
    if (decoded.resource !== null && resource !== undefined && decoded.resource !== resource) {
        return { valid: false, reason: 'token is for a different resource' };
    }
    return { valid: true, paymentHash: decoded.paymentHash };
}
