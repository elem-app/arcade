import { describe, expect, it } from "vitest";

import { checkArcSource } from "../src/skill-tools/check-arc.js";
import { embedArcFiles } from "../src/skill-tools/view-arc.js";

describe("check-arc", () => {
  it("check-arc rejects a host call that does not match the built-in time module", () => {
    const report = checkArcSource(
      `"arc";\nimport Time from "host:time";\nfunction A() { Time.$addTimeout("soon", 5, 6); }\n`,
    );
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toMatch(/^error HOST_ARGUMENT_ARITY 3:\d+ /);
  });

  it("check-arc accepts calls and host variables of every built-in host module", () => {
    const report = checkArcSource(`"arc";
import Time from "host:time";
import Audience from "host:audience";
function A() {
  Time.$addTimeout(1000, "reply");
  Time.$removeTimeout("reply");
  $instruct(\`Ask \${Audience.reviewer} to approve.\`);
}
`);
    expect(report.ok).toBe(true);
    expect(report.lines[0]).toBe("no issues or lints");
  });

  it("check-arc reports a parse error as a failed check instead of throwing", () => {
    const report = checkArcSource(
      `"arc";\nfunction A() { $enter(Missing); }\n`,
    );
    expect(report.ok).toBe(false);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatch(/^parse error: .*Missing/);
  });

  it("check-arc outlines nodes with their channels and marks nodes without an action graph as empty", () => {
    const report = checkArcSource(`"arc";
function Plan() {
  this.displayName = "Plan";
  let draft = Artifact();
  $enter(Draft, { returns: { draft } });
  $enter(Commit, { args: { draft } });
  function Draft(returns = { draft: Artifact() }) {
    let doc = Artifact("draft.md");
    $instruct(\`Write a draft to \${doc}.\`);
    this.effects = () => {
      returns.draft.$set(doc);
    };
  }
  function Commit(args = { draft: Artifact() }) {}
}
`);
    expect(report.lines.slice(report.lines.indexOf("outline:"))).toEqual([
      "outline:",
      '  Plan "Plan"',
      "    Draft returns(draft)",
      "    Commit args(draft) [empty]",
    ]);
  });
});

describe("view-arc", () => {
  it("view-arc embeds files before the closing body tag with every < escaped", () => {
    const page = embedArcFiles("<html><body><div></div></body></html>", [
      { path: "a/a.arc.js", text: `$instruct("</script>");` },
    ]);
    expect(page).toBe(
      '<html><body><div></div><script type="application/json" id="arc-files">' +
        '[{"path":"a/a.arc.js","text":"$instruct(\\"\\u003c/script>\\");"}]' +
        "</script>\n</body></html>",
    );
    const json = page.match(/id="arc-files">(.*)<\/script>/)?.[1] ?? "";
    expect(JSON.parse(json)).toEqual([
      { path: "a/a.arc.js", text: `$instruct("</script>");` },
    ]);
  });
});
