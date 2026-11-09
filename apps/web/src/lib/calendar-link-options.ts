import type { Db } from "./db";

// Server-only: what an entry can be linked to, as the signed-in user sees it (RLS). Values are
// "client:<id>", "project:<id>" or "milestone:<id>", the same form the entry form sends.

export type LinkOption = { value: string; label: string };

export const loadLinkOptions = async (db: Db): Promise<LinkOption[]> => {
  const { rows } = await db.query<{ kind: string; id: string; label: string }>(
    `SELECT 'client' AS kind, c.id::text, c.name AS label FROM public.clients c
     UNION ALL
     SELECT 'project', p.id::text, c.name || ': ' || p.title
       FROM public.projects p JOIN public.clients c ON c.id = p.client_id
     UNION ALL
     SELECT 'milestone', m.id::text, c.name || ': ' || p.title || ': ' || m.name
       FROM public.milestones m
       JOIN public.projects p ON p.id = m.project_id JOIN public.clients c ON c.id = p.client_id
     ORDER BY 1, 3`,
  );
  const LABEL: Record<string, string> = {
    client: "Client",
    project: "Project",
    milestone: "Milestone",
  };
  return rows.map((row) => ({
    value: `${row.kind}:${row.id}`,
    label: `${LABEL[row.kind] ?? row.kind}: ${row.label}`,
  }));
};

/** The option value for an entry's most specific link, or "". */
export const linkValueOf = (entry: {
  milestoneId: string | null;
  projectId: string | null;
  clientId: string | null;
}): string =>
  entry.milestoneId
    ? `milestone:${entry.milestoneId}`
    : entry.projectId
      ? `project:${entry.projectId}`
      : entry.clientId
        ? `client:${entry.clientId}`
        : "";
