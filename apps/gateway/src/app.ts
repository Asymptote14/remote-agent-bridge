import Fastify from 'fastify';

/**
 * The Fastify instance that every route module registers against.
 *
 * It is a singleton rather than something passed into `register*` functions so
 * that the route bodies could move out of index.ts unchanged: wrapping each
 * group would have re-indented several hundred lines for no behavioural gain.
 * index.ts imports each route module for its registration side effect.
 */
export const app = Fastify({ logger: true });
