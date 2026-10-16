import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadAppConfig,
  parseAppConfig,
  parseArcadeConfig,
} from "../src/config.js";
import { parseWorkerHubSchedulingConfig } from "../src/service/worker-hub-config.js";

describe("parseArcadeConfig", () => {
  it("keeps connector configuration outside the Arcade library config", () => {
    expect(parseArcadeConfig("{}", "arcade.jsonc")).toEqual({
      dataDir: ".arcade-data",
      arcsDir: ".arcade/arcs",
      workers: { roles: {} },
      workerHub: {
        scheduling: {
          default: { concurrency: 1, maxQueueSize: 64 },
          roles: {},
        },
      },
      arcHost: { snapshotRuntimeCacheSize: 32 },
      logging: { level: "info", format: "json" },
    });
    expect(() =>
      parseArcadeConfig(
        JSON.stringify({ connectors: { mcp: {} } }),
        "arcade.jsonc",
      ),
    ).toThrow(/unrecognized key/i);
  });
});

describe("parseAppConfig", () => {
  it("leaves worker slots unbound when omitted", () => {
    const result = parseAppConfig("{}", "test.jsonc");
    expect(result.workers).toEqual({ roles: {} });
  });

  it("applies worker hub scheduling defaults", () => {
    expect(parseAppConfig("{}", "test.jsonc")).toEqual({
      dataDir: ".arcade-data",
      arcsDir: ".arcade/arcs",
      workers: { roles: {} },
      workerHub: {
        scheduling: {
          default: { concurrency: 1, maxQueueSize: 64 },
          roles: {},
        },
      },
      deliveryRules: [],
      connectors: {},
      arcHost: { snapshotRuntimeCacheSize: 32 },
      logging: { level: "info", format: "json" },
    });
  });

  it("applies nested defaults to programmatic worker hub scheduling input", () => {
    expect(parseWorkerHubSchedulingConfig({})).toEqual({
      default: { concurrency: 1, maxQueueSize: 64 },
      roles: {},
    });
    expect(
      parseWorkerHubSchedulingConfig({
        roles: { researcher: { concurrency: 2 } },
      }),
    ).toEqual({
      default: { concurrency: 1, maxQueueSize: 64 },
      roles: { researcher: { concurrency: 2 } },
    });
  });

  it("accepts open backend names in every worker slot kind", () => {
    const result = parseAppConfig(
      JSON.stringify({
        workers: {
          default: {
            backend: "designer-claude-sdk",
            model: "claude-opus-4-7",
            timeoutMs: 1234,
          },
          fastTrigger: {
            backend: "semantic-openai-sdk",
            model: "gpt-5.4-mini",
          },
          roles: {
            researcher: {
              backend: "researcher-custom",
              endpoint: "https://workers.example.test",
              nested: { retries: 2 },
            },
          },
        },
        workerHub: {
          scheduling: {
            default: { concurrency: 3, maxQueueSize: 20 },
            roles: {
              researcher: { concurrency: 2, maxQueueSize: 5 },
            },
          },
        },
      }),
      "test.jsonc",
    );

    expect(result.workers.default).toEqual({
      backend: "designer-claude-sdk",
      model: "claude-opus-4-7",
      timeoutMs: 1234,
    });
    expect(result.workers.fastTrigger).toEqual({
      backend: "semantic-openai-sdk",
      model: "gpt-5.4-mini",
    });
    expect(result.workers.roles.researcher).toEqual({
      backend: "researcher-custom",
      endpoint: "https://workers.example.test",
      nested: { retries: 2 },
    });
    expect(result.workerHub.scheduling).toEqual({
      default: { concurrency: 3, maxQueueSize: 20 },
      roles: { researcher: { concurrency: 2, maxQueueSize: 5 } },
    });
  });

  it("preserves backend-specific JSON fields on raw worker slots", () => {
    const result = parseAppConfig(
      JSON.stringify({
        workers: {
          default: {
            backend: "custom-agent",
            nested: { retries: 2, flags: [true, null, "x"] },
          },
          fastTrigger: null,
        },
      }),
      "test.jsonc",
    );
    expect(result.workers.default).toEqual({
      backend: "custom-agent",
      nested: { retries: 2, flags: [true, null, "x"] },
    });
  });

  it("handles comments and trailing commas", () => {
    const result = parseAppConfig(
      `{
        // Any registered backend name may be selected.
        "workers": {
          "default": { "backend": "my-backend", },
        },
      }`,
      "test.jsonc",
    );
    expect(result.workers.default).toEqual({ backend: "my-backend" });
  });

  it("disables fast-trigger routing when its slot is null", () => {
    const result = parseAppConfig(
      JSON.stringify({ workers: { fastTrigger: null } }),
      "test.jsonc",
    );
    expect(result.workers.fastTrigger).toBeNull();
  });

  it("rejects empty backend names", () => {
    expect(() =>
      parseAppConfig(
        JSON.stringify({ workers: { default: { backend: "  " } } }),
        "bad-backend.jsonc",
      ),
    ).toThrow(/backend/);
  });

  it("rejects non-positive or fractional worker hub concurrency", () => {
    for (const concurrency of [0, -1, 1.5]) {
      expect(() =>
        parseAppConfig(
          JSON.stringify({
            workerHub: {
              scheduling: {
                default: { concurrency, maxQueueSize: 64 },
              },
            },
          }),
          "bad-concurrency.jsonc",
        ),
      ).toThrow(/failed validation/);
    }
  });

  it("rejects negative or fractional worker hub queue size", () => {
    for (const maxQueueSize of [-1, 1.5]) {
      expect(() =>
        parseAppConfig(
          JSON.stringify({
            workerHub: {
              scheduling: {
                default: { concurrency: 1, maxQueueSize },
              },
            },
          }),
          "bad-queue.jsonc",
        ),
      ).toThrow(/failed validation/);
    }
  });

  it("rejects reserved kind and role fields in every raw worker slot location", () => {
    const declarations = [
      { default: { backend: "custom-agent", kind: "default" } },
      { default: { backend: "custom-agent", role: "designer" } },
      { fastTrigger: { backend: "custom-agent", kind: "fast-trigger" } },
      { fastTrigger: { backend: "custom-agent", role: "designer" } },
      {
        roles: {
          designer: { backend: "custom-agent", kind: "role" },
        },
      },
      {
        roles: {
          designer: { backend: "custom-agent", role: "designer" },
        },
      },
    ];
    for (const workers of declarations) {
      expect(() =>
        parseAppConfig(JSON.stringify({ workers }), "reserved.jsonc"),
      ).toThrow(/reserved for worker hub normalization/);
    }
  });

  it("rejects non-finite JSON worker config", () => {
    expect(() =>
      parseAppConfig(
        '{"workers":{"default":{"backend":"custom-agent","temperature":1e999}}}',
        "non-finite.jsonc",
      ),
    ).toThrow(/finite numbers/);
  });

  it("rejects the removed top-level backend-options map", () => {
    expect(() =>
      parseAppConfig(
        JSON.stringify({ backends: { "pi-agent": { workerCount: 2 } } }),
        "legacy-backends.jsonc",
      ),
    ).toThrow(/unrecognized key/i);
  });

  it("validates connector, delivery, and secret sections", () => {
    const result = parseAppConfig(
      JSON.stringify({
        connectors: {
          mcp: { port: 8080 },
          web: { host: "0.0.0.0", port: 3180 },
        },
        deliveryRules: [
          {
            situation: { role: "*", audience: "*", cause: "reply" },
            delivery: "inbox",
            target: { kind: "principal", id: "user-1" },
          },
        ],
        secrets: {
          provider: "env",
          env: { "openai.api_key": "ARCADE_OPENAI_API_KEY" },
        },
      }),
      "test.jsonc",
    );
    expect(result.connectors.mcp).toEqual({
      host: "127.0.0.1",
      port: 8080,
      path: "/mcp",
      requirePrincipal: false,
    });
    expect(result.deliveryRules[0]?.target).toEqual({
      kind: "principal",
      id: "user-1",
    });
    expect(result.secrets?.env).toEqual({
      "openai.api_key": "ARCADE_OPENAI_API_KEY",
    });

    expect(() =>
      parseAppConfig(
        JSON.stringify({
          secrets: {
            provider: "env",
            env: { "openai.api_key": "openai_api_key" },
          },
        }),
        "bad-secret.jsonc",
      ),
    ).toThrow(/Environment variable names/);
  });

  it("rejects non-integer connector ports", () => {
    expect(() =>
      parseAppConfig(
        JSON.stringify({ connectors: { mcp: { port: 3.14 } } }),
        "bad-port.jsonc",
      ),
    ).toThrow(/failed validation/);
  });
});

describe("loadAppConfig", () => {
  it("parses the committed local template", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const result = await loadAppConfig(join(here, "..", "config.local.jsonc"));
    expect(result.workers.fastTrigger).toEqual({
      backend: "claude-sdk-tst",
    });
    expect(result.connectors).toEqual({
      mcp: {
        host: "127.0.0.1",
        port: 3177,
        path: "/mcp",
        requirePrincipal: false,
      },
      web: { host: "127.0.0.1", port: 3180 },
    });
  });
});
