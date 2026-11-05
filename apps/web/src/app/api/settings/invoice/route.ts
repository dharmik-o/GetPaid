import { renderTypedSignature } from "@/lib/invoice-pdf";
import { runAsCurrentUser } from "@/lib/request-user";
import { templateHandlers } from "@/lib/template-handlers";

const handlers = templateHandlers({
  runAsUser: runAsCurrentUser,
  renderSignature: renderTypedSignature,
});

export const PUT = handlers.saveDetails;
