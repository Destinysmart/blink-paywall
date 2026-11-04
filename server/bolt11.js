/**
 * BOLT-11 invoice decoder — the few fields a paywall needs, no dependencies.
 *
 * The widget only ever needed the amount (an HRP parse, see src/l402.js). The
 * server also needs the PAYMENT HASH: for a self-custodial (Blink Spark)
 * owner the invoice comes from LNURL-pay, which hands back only the bolt11
 * string, and the macaroon must bind that invoice's hash. So this does the
 * real thing: bech32 checksum, timestamp and tagged fields.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

const TAG_PAYMENT_HASH = 1; // p
const TAG_EXPIRY = 6; // x
const TAG_DESCRIPTION = 13; // d
const TAG_PAYMENT_SECRET = 16; // s
const TAG_PAYEE = 19; // n

const DEFAULT_EXPIRY_SECONDS = 3600;
const SIGNATURE_LENGTH = 104; // 65-byte recoverable signature in 5-bit groups
const MSATS_PER_UNIT = { '': 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };

const decoder = new TextDecoder();

function polymod(values) {
    let chk = 1;
    for (const value of values) {
        const top = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ value;
        for (let i = 0; i < 5; i++) {
            if ((top >>> i) & 1) chk ^= GENERATOR[i];
        }
    }
    return chk;
}

function hrpExpand(hrp) {
    const out = [];
    for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
    out.push(0);
    for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
    return out;
}

function verifyChecksum(hrp, data) {
    return polymod(hrpExpand(hrp).concat(data)) === 1;
}

/** Regroup bits. Without padding, leftover bits are dropped (bolt11 pads with zeros). */
function convertBits(data, from, to, pad) {
    const maxValue = (1 << to) - 1;
    const maxAcc = (1 << (from + to - 1)) - 1;
    const out = [];
    let acc = 0;
    let bits = 0;
    for (const value of data) {
        acc = ((acc << from) | value) & maxAcc;
        bits += from;
        while (bits >= to) {
            bits -= to;
            out.push((acc >> bits) & maxValue);
        }
    }
    if (pad && bits > 0) out.push((acc << (to - bits)) & maxValue);
    return out;
}

function toHex(bytes) {
    return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readInt(values) {
    let n = 0;
    for (const value of values) n = n * 32 + value;
    return n;
}

function parseHrp(hrp) {
    const match = /^ln(bcrt|bc|tbs|tb)(\d*)([munp]?)$/.exec(hrp);
    if (!match) return null;
    const [, network, digits, multiplier] = match;
    let amountMsats = null;
    if (digits) {
        const amount = BigInt(digits);
        const msats = multiplier === 'p' ? amount / 10n : amount * MSATS_PER_UNIT[multiplier];
        amountMsats = msats > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(msats);
    }
    return { network, amountMsats };
}

/**
 * Decode a BOLT-11 invoice.
 * @returns {{network: string, amountMsats: number|null, amountSats: number|null,
 *   timestamp: number, expiry: number, paymentHash: string, paymentSecret: string|null,
 *   payee: string|null, description: string|null}}
 * @throws {Error} on anything that is not a well-formed, checksummed invoice
 */
export function decodeInvoice(invoice) {
    const text = String(invoice || '').trim();
    if (!text) throw new Error('Empty invoice');
    const lower = text.toLowerCase();
    if (text !== lower && text !== text.toUpperCase()) {
        throw new Error('Invoice mixes upper and lower case');
    }
    const separator = lower.lastIndexOf('1');
    if (separator < 1) throw new Error('Invoice has no bech32 separator');
    const hrp = lower.slice(0, separator);
    const dataPart = lower.slice(separator + 1);
    // Prefix first: "not an invoice at all" is the more useful complaint.
    const parsedHrp = parseHrp(hrp);
    if (!parsedHrp) throw new Error('Not a Lightning invoice (unexpected prefix)');
    // timestamp (7) + tagged fields + signature (104 = 65 bytes) + checksum (6)
    if (dataPart.length < 7 + SIGNATURE_LENGTH + 6) throw new Error('Invoice data too short');

    const data = [];
    for (const char of dataPart) {
        const value = CHARSET.indexOf(char);
        if (value === -1) throw new Error(`Invalid bech32 character "${char}"`);
        data.push(value);
    }
    if (!verifyChecksum(hrp, data)) throw new Error('Invoice checksum does not match');

    const payload = data.slice(0, -(SIGNATURE_LENGTH + 6));
    const result = {
        network: parsedHrp.network,
        amountMsats: parsedHrp.amountMsats,
        amountSats: parsedHrp.amountMsats === null ? null : Math.round(parsedHrp.amountMsats / 1000),
        timestamp: readInt(payload.slice(0, 7)),
        expiry: DEFAULT_EXPIRY_SECONDS,
        paymentHash: null,
        paymentSecret: null,
        payee: null,
        description: null,
    };

    let offset = 7;
    while (offset + 3 <= payload.length) {
        const type = payload[offset];
        const length = payload[offset + 1] * 32 + payload[offset + 2];
        const values = payload.slice(offset + 3, offset + 3 + length);
        if (values.length < length) throw new Error('Truncated tagged field');
        offset += 3 + length;
        switch (type) {
            case TAG_PAYMENT_HASH:
                if (length === 52 && !result.paymentHash) {
                    result.paymentHash = toHex(convertBits(values, 5, 8, false));
                }
                break;
            case TAG_PAYMENT_SECRET:
                if (length === 52) result.paymentSecret = toHex(convertBits(values, 5, 8, false));
                break;
            case TAG_PAYEE:
                if (length === 53) result.payee = toHex(convertBits(values, 5, 8, false));
                break;
            case TAG_EXPIRY:
                result.expiry = readInt(values);
                break;
            case TAG_DESCRIPTION:
                result.description = decoder.decode(
                    Uint8Array.from(convertBits(values, 5, 8, false))
                );
                break;
            default:
                break;
        }
    }
    if (!result.paymentHash) throw new Error('Invoice has no payment hash');
    return result;
}
