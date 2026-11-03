import { secretBox } from "@/lib/crypto";
import { invoiceTextHandler } from "@/lib/invoice-document-handlers";
import { runAsCurrentUser } from "@/lib/request-user";

const handler = invoiceTextHandler({ runAsUser: runAsCurrentUser, box: secretBox });

export const POST = handler.post;
