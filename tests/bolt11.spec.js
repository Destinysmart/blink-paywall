// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeInvoice } from '../server/bolt11.js';

// Minted by Blink's public lnInvoiceCreateOnBehalfOfRecipient (1000 sats,
// 15-minute expiry, memo "blink-paywall bolt11 test vector"); the hash is the
// `paymentHash` the API returned alongside it.
const INVOICE =
    'lnbc10u1p4w4ez3pp5uhze229ft4njavxu05thkqszdlch08psq2vplyx3smwkzlszgmxsdp5vfkxjmnt94cxz7thv9kxcgrzdak8gvf3yp6x2um5ypmx2cm5daeqcqzpuxqzuysp5g5e75uhmvxud23neehpdd9z4c37rgn646h4xrl66vzh33a6pk5rq9qxpqysgqtp3f38n60tn29n9q0lw8z9ktn5g4vglr4zp90np9556ks7u8pjj94f6nqehceu4906g7cjcm4c0fn7ptc8qq8fhpjzw2f0sy5cs83ssqqz97hc';
const PAYMENT_HASH = 'e5c59528a95d672eb0dc7d177b02026ff1779c3002981f90d186dd617e0246cd';

describe('decodeInvoice', () => {
    it('reads the payment hash, amount, memo and expiry of a Blink invoice', () => {
        const decoded = decodeInvoice(INVOICE);
        expect(decoded.paymentHash).toBe(PAYMENT_HASH);
        expect(decoded.amountMsats).toBe(1_000_000);
        expect(decoded.amountSats).toBe(1000);
        expect(decoded.network).toBe('bc');
        expect(decoded.description).toBe('blink-paywall bolt11 test vector');
        expect(decoded.expiry).toBe(900);
        expect(decoded.paymentSecret).toMatch(/^[0-9a-f]{64}$/);
        expect(decoded.timestamp).toBeGreaterThan(1_700_000_000);
    });

    it('accepts an all-uppercase invoice (QR form)', () => {
        expect(decodeInvoice(INVOICE.toUpperCase()).paymentHash).toBe(PAYMENT_HASH);
    });

    it('rejects a corrupted invoice', () => {
        const flipped = INVOICE.slice(0, 40) + (INVOICE[40] === 'q' ? 'p' : 'q') + INVOICE.slice(41);
        expect(() => decodeInvoice(flipped)).toThrow('checksum');
    });

    it('rejects things that are not invoices', () => {
        expect(() => decodeInvoice('')).toThrow();
        expect(() => decodeInvoice('hello')).toThrow();
        expect(() => decodeInvoice('lnbc1')).toThrow();
        expect(() => decodeInvoice('LNbc10u1' + INVOICE.slice(8))).toThrow('case');
        expect(() => decodeInvoice('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toThrow(
            'prefix'
        );
    });
});
