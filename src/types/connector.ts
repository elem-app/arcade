/** Minimal lifecycle contract shared by Arcade connectors. */
export interface Connector {
  /** Start accepting or delivering connector traffic. */
  start(): void | Promise<void>;
  /** Stop accepting connector traffic and release owned resources. */
  stop(): void | Promise<void>;
}
