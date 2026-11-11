import { demoLoginHandler } from "@/lib/demo-login-handler";
import { runAsCurrentUser } from "@/lib/request-user";
import { resetTour } from "@/lib/tour";

const handler = demoLoginHandler({ onLogin: () => runAsCurrentUser(resetTour) });

export const POST = handler.post;
