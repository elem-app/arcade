# Arcade E2E Fixture Skill

This is an e2e-test fixture skill. It is not the production Arcade skill or
plugin format.

Use Arcade when the human asks to start, continue, coordinate, review, or
delegate a managed Arc workflow. Submit the human's actual request to Arcade;
do not rewrite it into a test-only command.

Requester fixture clients may decide to submit a human message to Arcade when
the message clearly asks for Arcade, a workflow, a handoff, a review, or a
draft that should be reviewed.

Reviewer fixture clients represent a human reviewer through MCP. Subscribe to
the configured Arcade inbox. When Arcade issues elicitation, show the request
to the human reviewer and return the human's decision. Do not make approval
judgments autonomously.

The fixture principals in this directory are local test identities only. They
are not authentication or authorization.
