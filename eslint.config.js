import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat ESLint config for the Blink Paywall widget.
 *
 * Environments:
 *   - src/**            browser ES modules, bundled by esbuild.
 *   - tests/**          Vitest + jsdom.
 *   - server/**         the hard-paywall server: Web-standard code (Request/Response/
 *                       Web Crypto) that runs on Node, Cloudflare Workers and Deno.
 *   - *.config.js       Node ESM tooling.
 *   - generator.js      browser script (generator page, served raw).
 */
export default [
    {
        ignores: ['node_modules/**', 'v1/**', 'coverage/**', 'src/qr.js'],
    },
    js.configs.recommended,
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser },
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none' }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['generator.js', 'editor.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.browser },
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none' }],
        },
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser },
        },
    },
    {
        files: ['server/**/*.js', 'server/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser, Deno: 'readonly' },
        },
        rules: {
            'no-empty': ['warn', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['*.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node },
        },
    },
];
