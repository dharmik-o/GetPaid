import { runAsCurrentUser } from "@/lib/request-user";
import { tourHandlers } from "@/lib/tour";

export const dynamic = "force-dynamic";

const handlers = tourHandlers({ runAsUser: runAsCurrentUser });

export const GET = handlers.get;
export const POST = handlers.post;
