import { defaultArchiveDir } from "@/lib/archive-paths";
import { archiveDownloadHandler } from "@/lib/invoice-archive-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handler = archiveDownloadHandler(() => ({
  runAsUser: runAsCurrentUser,
  dir: defaultArchiveDir(),
}));

export const GET = handler.get;
