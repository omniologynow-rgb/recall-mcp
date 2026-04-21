export interface McpErrorShape {
    error: {
        code: string;
        message: string;
        retryable: boolean;
        meta?: Record<string, unknown>;
    };
}

export class ToolError extends Error {
    constructor(
        public code: string,
        message: string,
        public retryable: boolean = false,
        public meta?: Record<string, unknown>
    ) {
        super(message);
        this.name = 'ToolError';
    }

    toMcpError(): McpErrorShape {
        const result: McpErrorShape = {
            error: {
                code: this.code,
                message: this.message,
                retryable: this.retryable,
            },
        };
        if (this.meta) {
            result.error.meta = this.meta;
        }
        return result;
    }

    // Common error factory methods
    static unauthorized(message: string = 'Invalid or missing API key'): ToolError {
        return new ToolError('unauthorized', message, false);
    }

    static limitExceeded(
        message: string = 'Free tier allows 100 memories. Upgrade at https://recallmcp.dev/pricing'
    ): ToolError {
        return new ToolError('limit_exceeded', message, false);
    }

    static notFound(message: string = 'Resource not found'): ToolError {
        return new ToolError('not_found', message, false);
    }

    static validationError(message: string, meta?: Record<string, unknown>): ToolError {
        return new ToolError('validation_error', message, false, meta);
    }

    static internalError(message: string = 'Internal server error'): ToolError {
        return new ToolError('internal_error', message, false);
    }
}