import { demoLoginHandler } from "@/lib/demo-login-handler";

const handler = demoLoginHandler();

export const POST = handler.post;
