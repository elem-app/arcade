import { createClaudeSdkBackend } from "./backends/claude-sdk-backend.js";
import { createClaudeSdkTstBackend } from "./backends/claude-sdk-tst-backend.js";
import { createOpenAiSdkBackend } from "./backends/openai-sdk-backend.js";
import { createOpenAiSdkTstBackend } from "./backends/openai-sdk-tst-backend.js";
import { createPiAgentBackend } from "./backends/pi-agent-backend.js";
import type { AppConfig, SecretsConfig } from "./config.js";
import { createSecretResolver } from "./service/secrets.js";
import type { Backend } from "./types/backend.js";
import type { BackendName } from "./types/worker-slot.js";

/** Construct the opinionated backend registry shipped by the `arcade` CLI. */
export function createCliBackends(
  config: AppConfig,
): Record<BackendName, Backend> {
  return createStandardBackends(config.secrets);
}

/** Construct Arcade's standard production backend registry for an external composition. */
export function createStandardBackends(
  secrets?: SecretsConfig,
): Record<BackendName, Backend> {
  const secretResolver = createSecretResolver(secrets);
  return {
    "pi-agent": createPiAgentBackend(),
    "claude-sdk": createClaudeSdkBackend(),
    "claude-sdk-tst": createClaudeSdkTstBackend(),
    "openai-sdk": createOpenAiSdkBackend({ secretResolver }),
    "openai-sdk-tst": createOpenAiSdkTstBackend({ secretResolver }),
  };
}
