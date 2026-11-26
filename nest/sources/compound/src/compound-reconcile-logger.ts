import { ConsoleLogger } from '@nestjs/common';
import type { Logger } from '@libs/chain';

// The indexer uses Nest's text console logger by default. Emit single-line JSON
// for reconciliation so operators can reliably query event identity and values.
export function createReconcileLogger(context: string): Logger {
  const logger = new ConsoleLogger(context, {
    json: true,
    colors: false,
    compact: true,
  });
  const message = (event: string, details: unknown) => ({
    ...(details && typeof details === 'object' ? details : {}),
    event,
  });
  return {
    info: (event, details) => logger.log(message(event, details)),
    warn: (event, details) => logger.warn(message(event, details)),
    error: (event, details) => logger.error(message(event, details)),
    debug: (event, details) => logger.debug(message(event, details)),
  };
}
