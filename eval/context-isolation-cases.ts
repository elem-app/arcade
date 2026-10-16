export const NO_PRIOR_PROVIDER_CONTEXT = "NO_PRIOR_PROVIDER_CONTEXT";

/**
 * Two same-role nodes whose only communication channel for `privateToken` is
 * provider continuation. The second node writes whether that provider-private
 * context was visible; the token is absent from inbound dialog and files.
 */
export function contextVisibilityEvalArc(input: {
  privateToken: string;
  outputArtifact: string;
}): string {
  return `
"arc";

function Main() {
  this.trigger = () => true;

  let output = Artifact("${input.outputArtifact}");

  $enter(Remember);
  $enter(Recall);

  function Remember() {
    this.hostParams = {
      workerRole: "writer",
    };
    $instruct(\`Remember the value inside <private-token>${input.privateToken}</private-token> for a later instruction in this same provider conversation. Do not write or emit the value, and do not ask a question. Report completed.\`);
  }

  function Recall() {
    this.hostParams = {
      workerRole: "writer",
    };
    $instruct(\`Create or overwrite \${output}. If an earlier instruction in this provider conversation explicitly supplied a value inside <private-token>, write exactly that value. Otherwise write exactly ${NO_PRIOR_PROVIDER_CONTEXT}. Do not infer a value, search for one, or ask a question.\`);
  }
}
`;
}
