export type EnvSecretProviderConfig = {
  provider: "env";
  env?: Record<string, string>;
};

export type SecretProviderConfig = EnvSecretProviderConfig;

export type SecretResolver = {
  getSecret(ref: string): Promise<string | undefined>;
};

export function createSecretResolver(
  config: SecretProviderConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SecretResolver | undefined {
  if (!config) return undefined;
  if (config.provider === "env") return new EnvSecretResolver(config, env);
  return undefined;
}

class EnvSecretResolver implements SecretResolver {
  readonly #config: EnvSecretProviderConfig;
  readonly #env: NodeJS.ProcessEnv;

  constructor(config: EnvSecretProviderConfig, env: NodeJS.ProcessEnv) {
    this.#config = config;
    this.#env = env;
  }

  async getSecret(ref: string): Promise<string | undefined> {
    const envName = this.#config.env?.[ref];
    if (!envName) return undefined;
    const value = this.#env[envName];
    return typeof value === "string" && value.trim().length > 0
      ? value
      : undefined;
  }
}
