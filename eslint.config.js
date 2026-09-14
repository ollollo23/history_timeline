/**
 * Конфигурация статического анализатора ESLint 9 (Flat Config).
 * Обеспечивает строгий контроль неиспользуемых переменных и импортов,
 * а также изоляцию сред исполнения браузера и тестового раннера Node.js.
 */

import js from '@eslint/js';
import globals from 'globals';

export default [
    // 1. Глобальные исключения путей из статического анализа
    {
        ignores: [
            '**/node_modules/**',
            '**/coverage/**',
            '**/.venv/**',
            '**/dist/**',
            '**/build/**',
            '**/project_info/**',
        ],
    },

    // 2. Базовый рекомендуемый набор правил ESLint
    js.configs.recommended,

    // 3. Конфигурация клиентского кода приложения (Browser environment)
    {
        files: ['frontend/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
            },
        },
        rules: {
            'no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
        },
    },

    // 4. Конфигурация модульных тестов и системных конфигураций (Node.js & Browser)
    {
        files: [
            'tests/js/**/*.js',
            '*.config.js',
            'vitest.config.js',
            'eslint.config.js',
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.browser,
            },
        },
        rules: {
            'no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
        },
    },
];
