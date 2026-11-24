import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  renderAgentSemanticText,
  SemanticTextRenderer,
} from "../src/service/semantic-text-renderer.js";

describe("SemanticTextRenderer", () => {
  it("renders artifact mentions as per-run local file paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-artifacts-"));
    const workspace = new SemanticTextRenderer();
    const arcRunId = "arc-run:1234";
    const workspacePath = join(root, arcRunId.replaceAll(":", "-"));

    const rendered = workspace.render(
      [
        { kind: "text", value: "Write " },
        { kind: "artifact", path: "research/log.md" },
        { kind: "text", value: "." },
      ],
      { workspacePath },
    );

    const expectedPath = join(root, "arc-run-1234", "research", "log.md");
    expect(rendered).toEqual({
      text: `Write ${expectedPath}.`,
      artifactPaths: [expectedPath],
      audienceReferences: [],
    });
  });

  it("renders artifact mentions under a per-arc workspace root", async () => {
    const workspacePath = await mkdtemp(
      join(tmpdir(), "arcade-arc-workspace-"),
    );
    const workspace = new SemanticTextRenderer();

    const rendered = workspace.render(
      [{ kind: "artifact", path: "notes/today.md" }],
      { workspacePath },
    );

    const expectedPath = join(workspacePath, "notes", "today.md");
    expect(rendered.artifactPaths).toEqual([expectedPath]);
  });

  it("resolves bundle-prefix matches into the bundle directory", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "arcade-ws-"));
    const bundleDir = await mkdtemp(join(tmpdir(), "arcade-bundle-"));
    const workspace = new SemanticTextRenderer();

    const rendered = workspace.render(
      [
        { kind: "artifact", path: "methodology/template.md" },
        { kind: "text", value: " and " },
        { kind: "artifact", path: "drafts/idea-1.md" },
      ],
      {
        workspacePath,
        bundle: { "methodology/": bundleDir },
      },
    );

    expect(rendered.artifactPaths).toEqual([
      join(bundleDir, "template.md"),
      join(workspacePath, "drafts", "idea-1.md"),
    ]);
  });

  it("renders host variables as explicit semantic markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-artifacts-"));
    const workspace = new SemanticTextRenderer();

    const rendered = workspace.render(
      [
        { kind: "text", value: "Ask " },
        { kind: "hostVar", module: "audience", path: ["approval", "finance"] },
        { kind: "text", value: " for approval." },
      ],
      { workspacePath: join(root, "run-alice-thread-1") },
    );

    expect(rendered).toEqual({
      text: "Ask <audience:approval.finance> for approval.",
      artifactPaths: [],
      audienceReferences: [
        {
          marker: "<audience:approval.finance>",
          audience: "approval.finance",
        },
      ],
    });
  });

  it("maps the rendered user entity to the originator audience", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "arcade-ws-"));
    const workspace = new SemanticTextRenderer();

    const rendered = workspace.render(
      [
        { kind: "text", value: "Reply to " },
        { kind: "entity", name: "user" },
        { kind: "text", value: "." },
      ],
      { workspacePath },
    );

    expect(rendered).toEqual({
      text: "Reply to user.",
      artifactPaths: [],
      audienceReferences: [{ marker: "user", audience: "originator" }],
    });
  });

  it("prefers the longest matching bundle prefix", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "arcade-ws-"));
    const outer = await mkdtemp(join(tmpdir(), "arcade-outer-"));
    const inner = await mkdtemp(join(tmpdir(), "arcade-inner-"));
    const workspace = new SemanticTextRenderer();

    const rendered = workspace.render(
      [{ kind: "artifact", path: "a//b/c.md" }],
      {
        workspacePath,
        bundle: { "a/": outer, "a/b/": inner },
      },
    );

    expect(rendered.artifactPaths).toEqual([join(inner, "c.md")]);
  });

  it("renders dot components under the workspace and longest matching bundle", () => {
    const context = {
      workspacePath: "/host/work",
      workspaceBundle: { "assets/": "/outer", "assets/deep/": "/inner" },
    };
    for (const [path, host, sandbox] of [
      [".", "/host/work", "/workspace"],
      ["./.", "/host/work", "/workspace"],
      ["./.config/./x", "/host/work/.config/x", "/workspace/.config/x"],
      [
        "./assets/./deep/input",
        "/inner/input",
        "/workspace/.arcade-bundles/assets/deep/input",
      ],
      ["assets/deep/.", "/inner/", "/workspace/.arcade-bundles/assets/deep/"],
      ["reports/.", "/host/work/reports/", "/workspace/reports/"],
    ] as const) {
      const text = [{ kind: "artifact" as const, path }];
      expect(
        renderAgentSemanticText(text, context, { kind: "host" }).text,
      ).toBe(host);
      expect(
        renderAgentSemanticText(text, context, {
          kind: "sandbox",
          sandboxRoot: "/workspace",
        }).text,
      ).toBe(sandbox);
    }
    expect(
      renderAgentSemanticText(
        [{ kind: "artifact", path: "./." }],
        { workspacePath: "/", workspaceBundle: { "": "/catch-all" } },
        { kind: "sandbox", sandboxRoot: "." },
      ).text,
    ).toBe(".");
  });

  it("selects the bundle before projecting a repeated-separator path for the worker", () => {
    const context = {
      workspacePath: "/host/work",
      workspaceBundle: {
        "assets/": "/outer",
        "assets/deep/": "/inner",
        manual: "/manual",
      },
    };
    const text = [{ kind: "artifact" as const, path: "assets//deep/x" }];
    expect(renderAgentSemanticText(text, context, { kind: "host" }).text).toBe(
      "/inner/x",
    );
    expect(
      renderAgentSemanticText(text, context, {
        kind: "sandbox",
        sandboxRoot: "/workspace",
      }).text,
    ).toBe("/workspace/.arcade-bundles/assets/deep/x");
    const custom = renderAgentSemanticText(text, context, {
      kind: "sandbox",
      sandboxRoot: ".",
      renderBundlePath(location, suffix) {
        expect([location, suffix]).toEqual(["/inner", "x"]);
        return "/client/x";
      },
    });
    expect(custom.artifactPaths).toEqual(["/client/x"]);
    for (const destination of ["/client/inner", "/client/inner/"]) {
      const rendered = renderAgentSemanticText(
        [{ kind: "artifact", path: "assets//deep/." }],
        context,
        {
          kind: "sandbox",
          sandboxRoot: ".",
          renderBundlePath(location, suffix) {
            expect([location, suffix]).toEqual(["/inner", ""]);
            return destination;
          },
        },
      );
      expect(rendered.text).toBe("/client/inner/");
    }
    const hostPath = (path: string) =>
      renderAgentSemanticText([{ kind: "artifact", path }], context, {
        kind: "host",
      }).text;
    expect(hostPath("reports///q3.md")).toBe("/host/work/reports/q3.md");
    expect(hostPath("manual//index")).toBe("/manual/index");
    expect(hostPath("assets//deep/.")).toBe("/inner/");
    expect(() => hostPath("assets//deep/")).toThrow();
    expect(() => hostPath("assets//../x")).toThrow();
    expect(() => hostPath("manual../x")).toThrow();
  });

  it("rejects unsafe artifact paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-artifacts-"));
    const workspace = new SemanticTextRenderer();
    const context = {
      workspacePath: join(root, "run-alice-thread-1"),
    };

    expect(() =>
      workspace.render([{ kind: "artifact", path: "/tmp/log.md" }], context),
    ).toThrow("Arc artifact path must be relative: /tmp/log.md");
    expect(() =>
      workspace.render(
        [{ kind: "artifact", path: "notes/../log.md" }],
        context,
      ),
    ).toThrow("Arc artifact path contains an invalid segment: notes/../log.md");
  });

  it("renders agent artifact mentions to host paths by target", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "arcade-artifacts-"));
    const arcRunId = "run:agent";
    const workspacePath = join(artifactRoot, arcRunId.replaceAll(":", "-"));

    const rendered = renderAgentSemanticText(
      [
        { kind: "text", value: "Read " },
        { kind: "artifact", path: "notes/input.md" },
      ],
      {
        workspacePath,
        workspaceBundle: {},
      },
      { kind: "host" },
    );

    const expected = join(workspacePath, "notes", "input.md");
    expect(rendered).toEqual({
      text: `Read ${expected}`,
      artifactPaths: [expected],
      audienceReferences: [],
    });
  });

  it("renders agent artifact mentions to OpenAI sandbox paths", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "arcade-ws-"));

    const rendered = renderAgentSemanticText(
      [
        { kind: "text", value: "Write " },
        { kind: "artifact", path: "drafts/result.md" },
      ],
      {
        workspacePath: workspacePath,
        workspaceBundle: {},
      },
      { kind: "sandbox", sandboxRoot: "/workspace" },
    );

    expect(rendered).toEqual({
      text: "Write /workspace/drafts/result.md",
      artifactPaths: ["/workspace/drafts/result.md"],
      audienceReferences: [],
    });
  });

  it("renders bundle-prefix artifact mentions to host paths", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "arcade-ws-"));
    const bundleBase = join(workspacePath, "templates");

    const rendered = renderAgentSemanticText(
      [
        { kind: "artifact", path: "methodology/template.md" },
        { kind: "text", value: " for " },
        { kind: "hostVar", module: "audience", path: ["reviewer"] },
      ],
      {
        workspacePath: workspacePath,
        workspaceBundle: { "methodology/": bundleBase },
      },
      { kind: "host" },
    );

    expect(rendered).toEqual({
      text: `${join(bundleBase, "template.md")} for <audience:reviewer>`,
      artifactPaths: [join(bundleBase, "template.md")],
      audienceReferences: [
        { marker: "<audience:reviewer>", audience: "reviewer" },
      ],
    });
  });

  it("renders bundle-prefix artifacts to the reserved sandbox bundle path", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "arcade-ws-"));
    const bundleBase = join(workspacePath, "templates");

    const rendered = renderAgentSemanticText(
      [{ kind: "artifact", path: "methodology/template.md" }],
      {
        workspacePath: workspacePath,
        workspaceBundle: { "methodology/": bundleBase },
      },
      { kind: "sandbox", sandboxRoot: "/workspace" },
    );

    expect(rendered).toEqual({
      text: "/workspace/.arcade-bundles/methodology/template.md",
      artifactPaths: ["/workspace/.arcade-bundles/methodology/template.md"],
      audienceReferences: [],
    });
  });
});
