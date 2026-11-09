import { signingHandlers } from "@/lib/signing-handlers";
import { signingDeps, signingLimits } from "@/lib/signing-runtime";

const handlers = signingHandlers({ ...signingDeps, limits: signingLimits });

export const GET = handlers.get;
export const POST = handlers.post;
