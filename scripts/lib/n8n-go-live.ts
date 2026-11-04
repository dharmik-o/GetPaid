// What `npm run n8n:go-live` does to the workflows, as pure functions so tests can check them. The
// workflow file in the repo holds placeholder credentials, since ids differ per n8n instance.

type Credential = { id: string; name: string };
type WorkflowNode = { credentials?: Record<string, Credential> } & Record<string, unknown>;

export type WorkflowFile = { id?: string; nodes: WorkflowNode[] } & Record<string, unknown>;

export type InstanceCredential = { id: string; name: string; type: string };

export type InstanceWorkflow = { id: string; name: string; active: boolean };

/** Which workflow, by the start of its name. Ids differ per instance. */
export const GO_LIVE_WORKFLOWS = ["Approval handler", "Scheduler", "Reply listener"] as const;

export const workflowIdByName = (
  workflows: readonly InstanceWorkflow[],
  prefix: string,
): string => {
  const matches = workflows.filter((workflow) => workflow.name.startsWith(prefix));
  const [first] = matches;
  if (!first || matches.length > 1) {
    throw new Error(
      `Expected exactly one workflow named "${prefix}...", found ${String(matches.length)}. Check the list in n8n, then run this again.`,
    );
  }
  return first.id;
};

const credentialFor = (
  credentials: readonly InstanceCredential[],
  type: string,
): InstanceCredential => {
  const matches = credentials.filter((credential) => credential.type === type);
  const [first] = matches;
  if (!first || matches.length > 1) {
    throw new Error(
      `Expected exactly one n8n credential of type ${type}, found ${String(matches.length)}. Check Credentials in n8n, then run this again.`,
    );
  }
  return first;
};

/** The repo's workflow with this instance's id and credentials, ready to import in place. */
export const forThisInstance = (
  file: WorkflowFile,
  workflowId: string,
  credentials: readonly InstanceCredential[],
): WorkflowFile => ({
  ...file,
  id: workflowId,
  nodes: file.nodes.map((node) => {
    if (!node.credentials) return node;
    const mapped: Record<string, Credential> = {};
    for (const type of Object.keys(node.credentials)) {
      const { id, name } = credentialFor(credentials, type);
      mapped[type] = { id, name };
    }
    return { ...node, credentials: mapped };
  }),
});

/** n8n's CLI prints log lines before the JSON. */
export const parseCliJson = (output: string): unknown => {
  const start = output.indexOf("[");
  if (start < 0) throw new Error("n8n's CLI printed no list. Is the n8n container running?");
  return JSON.parse(output.slice(start)) as unknown;
};
