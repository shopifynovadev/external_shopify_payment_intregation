
import { authenticate } from "../shopify.server.js";
import { sendOtp } from "../services/otp.service.js";

const SHOP_OWNER_EMAIL_QUERY = `query { shop { email } }`;

export async function action({ request }) {
  const { session, admin } = await authenticate.admin(request);

  let ownerEmail = session.email;

  if (!ownerEmail) {
    try {
      const res = await admin.graphql(SHOP_OWNER_EMAIL_QUERY);
      const json = await res.json();
      ownerEmail = json.data?.shop?.email;
    } catch {
      // fall through to error below
    }
  }

  if (!ownerEmail) {
    return Response.json(
      { success: false, error: "No email associated with this Shopify account" },
      { status: 422 }
    );
  }

  try {
    await sendOtp({
      shopDomain: session.shop,
      email: ownerEmail,
      purpose: "CHANGE_BKASH_CREDENTIALS",
    });
    return Response.json({
      success: true,
      data: { sentTo: ownerEmail.replace(/(.{2}).+(@.+)/, "$1***$2") },
    });
  } catch (err) {
    return Response.json(
      { success: false, error: "Failed to send OTP. Please try again." },
      { status: 500 }
    );
  }
}
