/**
 * L402 protocol helpers — pure functions, no I/O.
 *
 * The L402 flow ("HTTP 402 Payment Required", Lightning Labs variant):
 *   GET resource                        -> 402 + WWW-Authenticate: L402 macaroon="...", invoice="..."
 *   pay the invoice, obtain preimage    -> Authorization: L402 <macaroon>:<preimage>
 *   GET resource with that header       -> 200
 *
 * Parser and amount decoder ported from blink-skills (blink/scripts/l402_discover.js).
 */

/**
 * Parse a `WWW-Authenticate: L402 ...` challenge header.
 * Also accepts the legacy `LSAT` scheme, and the Blink Paywall server's
 * `verify="<LUD-21 url>"` extension: when the owner is self-custodial the
 * invoice settles outside Blink's ledger, and that URL is how to find out.
 * @returns {{macaroon: string, invoice: string, verify?: string}|null}
 */
export function parseChallenge(header) {
    if (!header) return null;
    const trimmed = header.trim();
    if (!/^(l402|lsat)\s/i.test(trimmed)) return null;
    const macaroon = trimmed.match(/macaroon\s*=\s*"([^"]+)"/i);
    const invoice = trimmed.match(/invoice\s*=\s*"([^"]+)"/i);
    const verify = trimmed.match(/verify\s*=\s*"([^"]+)"/i);
    if (!macaroon || !invoice) return null;
    const challenge = { macaroon: macaroon[1], invoice: invoice[1] };
    if (verify) challenge.verify = verify[1];
    return challenge;
}

/** Build the Authorization header value for a settled challenge. */
export function buildAuthorization(macaroon, preimage) {
    return `L402 ${macaroon}:${preimage}`;
}

function bolt11AmountParts(invoice) {
    if (!invoice) return null;
    const lower = invoice.toLowerCase();
    let rest;
    if (lower.startsWith('lntbs')) rest = lower.slice(5);
    else if (lower.startsWith('lntb')) rest = lower.slice(4);
    else if (lower.startsWith('lnbc')) rest = lower.slice(4);
    else return null;
    // digits + optional multiplier, then the "1" bech32 separator
    const match = rest.match(/^(\d+)([munp]?)1/);
    if (!match) return null;
    return { amount: BigInt(match[1]), multiplier: match[2] };
}

const MSATS_PER_UNIT = {
    '': 100_000_000_000n, // whole BTC
    m: 100_000_000n,
    u: 100_000n,
    n: 100n,
};

/**
 * Decode a BOLT-11 invoice amount in millisatoshis (HRP parse only, no
 * checksum). @returns {number|null}
 */
export function decodeAmountMsats(invoice) {
    const parts = bolt11AmountParts(invoice);
    if (!parts) return null;
    const { amount, multiplier } = parts;
    let msats;
    if (multiplier === 'p') {
        msats = amount / 10n; // floored at msat granularity
    } else {
        const factor = MSATS_PER_UNIT[multiplier];
        if (factor === undefined) return null;
        msats = amount * factor;
    }
    if (msats > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(msats);
}

/** Decode a BOLT-11 invoice amount in whole satoshis (rounded). @returns {number|null} */
export function decodeAmountSats(invoice) {
    const msats = decodeAmountMsats(invoice);
    return msats === null ? null : Math.round(msats / 1000);
}
