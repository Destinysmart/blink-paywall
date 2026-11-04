// @vitest-environment node
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
    base64urlDecode,
    base64urlEncode,
    createMacaroon,
    decodeMacaroon,
    verifyPreimage,
    verifyToken,
} from '../server/macaroon.js';

const rootKey = Buffer.from('aa'.repeat(32), 'hex');
const preimage = 'bb'.repeat(32);
const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');

describe('macaroon mint/verify', () => {
    it('round-trips payment hash and caveats', async () => {
        const macaroon = await createMacaroon({
            paymentHash,
            rootKey,
            expirySeconds: 4102444800,
            resource: 'ebook',
        });
        const decoded = await decodeMacaroon({ macaroon, rootKey });
        expect(decoded).toEqual({
            signatureValid: true,
            paymentHash,
            expiresAt: 4102444800,
            resource: 'ebook',
        });
    });

    it('is wire-compatible with blink-skills _l402_macaroon.js', async () => {
        // Vector minted by blink-skills' createMacaroon with the same inputs.
        const skillsMacaroon =
            'AUyhRSaydRtkDVSc58r4rDlDhZIhGg7DcAZNV2ZqaCrWAQAIAAAAAPSGVwACAAVlYm9va' +
            '-snbVsuRcITFsgNOknxR2PPohwpQD10NM6zTrBoC6aY';
        const decoded = await decodeMacaroon({ macaroon: skillsMacaroon, rootKey });
        expect(decoded.signatureValid).toBe(true);
        expect(decoded.paymentHash).toBe(paymentHash);
        expect(decoded.resource).toBe('ebook');
        expect(decoded.expiresAt).toBe(4102444800);
        // And ours is byte-identical to theirs — on Web Crypto, not node:crypto.
        expect(
            await createMacaroon({
                paymentHash,
                rootKey,
                expirySeconds: 4102444800,
                resource: 'ebook',
            })
        ).toBe(skillsMacaroon);
    });

    it('rejects a tampered macaroon', async () => {
        const macaroon = await createMacaroon({ paymentHash, rootKey, resource: 'ebook' });
        const raw = Buffer.from(macaroon, 'base64url');
        raw[5] ^= 0xff;
        const decoded = await decodeMacaroon({ macaroon: raw.toString('base64url'), rootKey });
        expect(decoded.signatureValid).toBe(false);
    });

    it('rejects a macaroon minted with a different root key', async () => {
        const macaroon = await createMacaroon({ paymentHash, rootKey: crypto.randomBytes(32) });
        expect((await decodeMacaroon({ macaroon, rootKey })).signatureValid).toBe(false);
    });

    it('rejects garbage and wrong-sized keys', async () => {
        await expect(decodeMacaroon({ macaroon: 'AQ', rootKey })).rejects.toThrow('too short');
        await expect(
            createMacaroon({ paymentHash, rootKey: new Uint8Array(16) })
        ).rejects.toThrow('32-byte');
        await expect(createMacaroon({ paymentHash: 'nope', rootKey })).rejects.toThrow('hex');
    });

    it('verifyPreimage checks sha256(preimage) == hash', async () => {
        expect(await verifyPreimage(preimage, paymentHash)).toBe(true);
        expect(await verifyPreimage('cc'.repeat(32), paymentHash)).toBe(false);
        expect(await verifyPreimage('nothex', paymentHash)).toBe(false);
    });

    it('base64url helpers match Node, padding-free', () => {
        const bytes = crypto.randomBytes(37);
        expect(base64urlEncode(bytes)).toBe(bytes.toString('base64url'));
        expect(Buffer.from(base64urlDecode(bytes.toString('base64url')))).toEqual(bytes);
        expect(Buffer.from(base64urlDecode(bytes.toString('base64url') + '='))).toEqual(bytes);
    });
});

describe('verifyToken (Authorization header)', () => {
    let macaroon;
    let good;

    beforeAll(async () => {
        macaroon = await createMacaroon({
            paymentHash,
            rootKey,
            expirySeconds: 4102444800,
            resource: 'ebook',
        });
        good = `L402 ${macaroon}:${preimage}`;
    });

    it('accepts a valid token', async () => {
        expect(await verifyToken({ authorization: good, rootKey, resource: 'ebook' })).toEqual({
            valid: true,
            paymentHash,
        });
    });

    it('rejects wrong resource, wrong preimage, expiry, and malformed headers', async () => {
        expect((await verifyToken({ authorization: good, rootKey, resource: 'other' })).valid).toBe(
            false
        );
        expect(
            (
                await verifyToken({
                    authorization: `L402 ${macaroon}:${'cc'.repeat(32)}`,
                    rootKey,
                    resource: 'ebook',
                })
            ).valid
        ).toBe(false);
        expect(
            (
                await verifyToken({
                    authorization: good,
                    rootKey,
                    resource: 'ebook',
                    nowSeconds: 4102444801,
                })
            ).valid
        ).toBe(false);
        expect((await verifyToken({ authorization: 'Bearer x', rootKey })).valid).toBe(false);
        expect((await verifyToken({ authorization: undefined, rootKey })).valid).toBe(false);
    });
});
