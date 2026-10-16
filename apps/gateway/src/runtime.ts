import { readRuntimeConfig } from '@rab/config';

/**
 * Startup configuration, resolved once.
 *
 * Route handlers and helpers need the port to build loopback URLs (the setup
 * hint, the allowed-origin list), so it is exported rather than re-read from the
 * config file at every use site.
 */
export const savedConfig = readRuntimeConfig();
export const port = Number(process.env.GATEWAY_PORT ?? savedConfig.port);
export const host = process.env.GATEWAY_HOST ?? savedConfig.host;
