// Paddle's webhook (README: Plans and payments): payments, renewals, cancellations and refunds,
// applied to the Purchase and Group records (shared/billing.js). Paddle signs each event with the
// notification destination's secret (PADDLE_WEBHOOK_SECRET); anything else is refused. Every
// event may arrive more than once and out of order, and is applied so that it does not matter.
// A failure answers 500, and Paddle sends the event again later.
import { createClientFromRequest } from "npm:@base44/sdk";
import { secrets } from "base44:runtime";
import { paddleApi, receiveWebhook } from "../../shared/billing.js";
import { sealer } from "../../shared/sealed.js";

export default async function (req: Request): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "POST only." }, { status: 405 });
  const { status, json } = await receiveWebhook({
    secret: secrets.get("PADDLE_WEBHOOK_SECRET"),
    signature: req.headers.get("paddle-signature"),
    body: await req.text(),
    ctx: () => {
      const key = secrets.get("PADDLE_API_KEY");
      return {
        db: createClientFromRequest(req).asServiceRole.entities,
        s: sealer(secrets.get("DATA_KEY")),
        paddle: key ? paddleApi(key, secrets.get("PADDLE_ENVIRONMENT") === "sandbox" ? { sandbox: true } : {}) : null,
      };
    },
  });
  return Response.json(json, { status });
}
