import { describe, expect, it } from 'vitest';
import {
    buildAuthorization,
    decodeAmountMsats,
    decodeAmountSats,
    parseChallenge,
} from '../src/l402.js';

describe('parseChallenge', () => {
    it('parses the Lightning Labs L402 header', () => {
        const header = 'L402 macaroon="bWFj", invoice="lnbc10n1abc"';
        expect(parseChallenge(header)).toEqual({ macaroon: 'bWFj', invoice: 'lnbc10n1abc' });
    });

    it('carries the verify URL extension when present (self-custodial owner)', () => {
        const header =
            'L402 macaroon="m", invoice="lnbc1x", verify="https://lnurl.blink.sv/lnurlp/verify/1"';
        expect(parseChallenge(header)).toEqual({
            macaroon: 'm',
            invoice: 'lnbc1x',
            verify: 'https://lnurl.blink.sv/lnurlp/verify/1',
        });
        expect(parseChallenge('L402 macaroon="m", invoice="lnbc1x"')).not.toHaveProperty('verify');
    });

    it('accepts LSAT and case variations, tolerates spacing', () => {
        const header = 'lsat  invoice = "lnbc1x" , MACAROON = "m1"';
        expect(parseChallenge(header)).toEqual({ macaroon: 'm1', invoice: 'lnbc1x' });
    });

    it('rejects other schemes and partial headers', () => {
        expect(parseChallenge('Bearer abc')).toBeNull();
        expect(parseChallenge('L402 macaroon="m"')).toBeNull();
        expect(parseChallenge(undefined)).toBeNull();
        expect(parseChallenge('')).toBeNull();
    });
});

describe('buildAuthorization', () => {
    it('joins macaroon and preimage', () => {
        expect(buildAuthorization('m', 'p')).toBe('L402 m:p');
    });
});

describe('decodeAmountMsats / decodeAmountSats', () => {
    it('decodes each multiplier', () => {
        expect(decodeAmountMsats('lnbc1m1rest')).toBe(100_000_000); // 1e5 sats
        expect(decodeAmountMsats('lnbc10u1rest')).toBe(1_000_000); // 1000 sats
        expect(decodeAmountMsats('lnbc10n1rest')).toBe(1000); // 1 sat
        expect(decodeAmountMsats('lnbc105p1rest')).toBe(10); // pico floored
        expect(decodeAmountMsats('lnbc21rest')).toBe(200_000_000_000); // 2 BTC
    });

    it('supports testnet/signet prefixes and uppercase', () => {
        expect(decodeAmountMsats('LNTB10N1REST')).toBe(1000);
        expect(decodeAmountMsats('lntbs10n1rest')).toBe(1000);
    });

    it('returns null for amountless or non-invoice strings', () => {
        expect(decodeAmountMsats('lnbc1notdigits')).toBeNull();
        expect(decodeAmountMsats('hello')).toBeNull();
        expect(decodeAmountMsats('')).toBeNull();
    });

    it('rounds to sats', () => {
        expect(decodeAmountSats('lnbc10u1rest')).toBe(1000);
        expect(decodeAmountSats('lnbc15n1rest')).toBe(2); // 1500 msat -> 2 sats
    });
});
