import { AsyncLocalStorage } from 'async_hooks';

export interface AuthContext {
    userId: string;
    tier: string;
}

export const authContext = new AsyncLocalStorage<AuthContext>();

export function requireAuth(): AuthContext {
    const ctx = authContext.getStore();
    if (!ctx) {
        throw new Error('Authentication required');
    }
    return ctx;
}
