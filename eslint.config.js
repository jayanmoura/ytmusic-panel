// ESLint for the GNOME Shell extension (GJS, ES modules).
// Imports from gi:// and resource:// are resolved by GJS at runtime, so they
// are only checked for syntax here.
import js from '@eslint/js';

// Globals that GJS and GNOME Shell provide.
const gjsGlobals = {
    ARGV: 'readonly',
    Debugger: 'readonly',
    GIRepositoryGType: 'readonly',
    console: 'readonly',
    global: 'readonly',
    globalThis: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    clearInterval: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    setTimeout: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
};

export default [
    js.configs.recommended,
    {
        files: ['extension/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            // Callbacks often receive arguments they don't use (signal handlers).
            'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none'}],
            'eqeqeq': 'error',
            'no-self-compare': 'error',
            'no-shadow': 'error',
            'no-unreachable-loop': 'error',
            'no-unused-private-class-members': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
];
