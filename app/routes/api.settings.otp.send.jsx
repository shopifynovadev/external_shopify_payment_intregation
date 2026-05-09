import { json } from "react-router";
import { authenticate } from "../shopify.server.js";
import { sendOtp } from "../services/otp.service.js";

export async function action({ request }) {
  const { session } = await authenticate.admin(request);

  // Use the Shopify account owner email as the OTP destination
  const ownerEmail = session.email;
  if (!ownerEmail) {
    return json({ success: false, error: "No email associated with this Shopify account" }, { status: 422 });
  }

  try {
    await sendOtp({
      shopDomain: session.shop,
      email: ownerEmail,
      purpose: "CHANGE_BKASH_CREDENTIALS",
    });
    return json({ success: true, data: { sentTo: ownerEmail.replace(/(.{2}).+(@.+)/, "$1***$2") } });
  } catch (err) {
    return json({ success: false, error: "Failed to send OTP. Please try again." }, { status: 500 });
  }
}
