import { authorizeOnceApproved, type PaypalClient } from "../../apps/web/src/lib/paypal";

type WaitOptions = { requestId: string; attempts: number; pause: () => Promise<unknown> };

/** Asks PayPal until the buyer has approved and the order is authorized. Null: nobody approved. */
export const waitForAuthorization = async (
  paypal: Pick<PaypalClient, "getOrder" | "authorizeOrder">,
  orderId: string,
  { requestId, attempts, pause }: WaitOptions,
): Promise<string | null> => {
  for (let tried = 0; tried < attempts; tried += 1) {
    const authorizationId = await authorizeOnceApproved(paypal, orderId, requestId);
    if (authorizationId) return authorizationId;
    await pause();
  }
  return null;
};
