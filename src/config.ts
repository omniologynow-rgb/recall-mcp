import { z } from 'zod';

const envSchema = z.object({
    DATABASE_URL: z.string().url().startsWith('postgresql://'),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    APP_BASE_URL: z.string().url().default('http://localhost:8080'),
    MCPIZE_BILLING_WEBHOOK_SECRET: z.string().optional(),
    PORT: z.coerce.number().int().positive().max(65535).default(8080),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    RATE_LIMIT_PER_KEY: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_PER_USER_HOUR: z.coerce.number().int().positive().default(10000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
});

export type Env = z.infer<typeof envSchema>;

let validatedEnv: Env | null = null;

export function loadEnv(): Env {
    if (validatedEnv) {
        return validatedEnv;
    }
    const rawEnv = process.env;
    const result = envSchema.safeParse(rawEnv);
    if (!result.success) {
        const missing = result.error.issues.map((err: any) => err.path.join('.')).join(', ');
        console.error(`❌ Missing or invalid environment variables: ${missing}`);
        console.error('Please check your .env file and ensure all required variables are set.');
        console.error('Refer to .env.example for the list of required variables.');
        process.exit(1);
    }
    validatedEnv = result.data;
    return validatedEnv;
}

export function getEnv(): Env {
    if (!validatedEnv) {
        throw new Error('Environment not loaded. Call loadEnv() first.');
    }
    return validatedEnv;
}

export function resetEnvCache(): void {
    validatedEnv = null;
}

// Convenience config object (lazy)
export function getConfig() {
    const env = loadEnv();
    return {
        databaseUrl: env.DATABASE_URL,
        openaiApiKey: env.OPENAI_API_KEY,
        logLevel: env.LOG_LEVEL,
        isDev: env.NODE_ENV === 'development',
    };
}