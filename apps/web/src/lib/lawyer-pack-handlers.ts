import { isUuid } from "./db";
import { notFound, serverError } from "./http";
import { buildLawyerPack, type PackDeps } from "./lawyer-pack";

// Server-only: POST /api/projects/[id]/lawyer-pack. Builds the pack as the signed-in user (RLS), keeps a
// copy in the archive folder, and returns it for download. Another user's project is simply not found.

export const lawyerPackHandlers = (deps: PackDeps) => ({
  post: async (
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("Project");
    try {
      const pack = await buildLawyerPack(deps, id);
      if (!pack.ok) return notFound("Project");
      const name = pack.relativePath.split("/").at(-1) ?? "Lawyer-pack.pdf";
      return new Response(new Uint8Array(pack.bytes), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._ ()-]/g, "_")}"`,
          "x-pack-pages": String(pack.pages),
        },
      });
    } catch (error) {
      return serverError("lawyer_pack.failed", error);
    }
  },
});
