import { json } from "react-router";
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { verifyOtp } from "../services/otp.service.js";
import { encrypt } from "../utils/crypto.js";
import { invalidateToken } from "../services/bkash.service.js";

export async function action({ request }) {
  const { session } = await authenticate.admin(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { otp, credentials } = body;
  // credentials: { bkashNumber, bkashUsername, bkashPassword, bkashAppKey, bkashAppSecret, bkashApiBaseUrl }

  if (!otp || !credentials) {
    return json({ success: false, error: "Missing otp or credentials" }, { status: 400 });
  }

  const otpResult = await verifyOtp({
    shopDomain: session.shop,
    otp: String(otp),
    purpose: "CHANGE_BKASH_CREDENTIALS",
  });

  if (!otpResult.valid) {
    return json({ success: false, error: otpResult.reason }, { status: 422 });
  }

  // Encrypt each credential field
  const updates = {};
  if (credentials.bkashNumber) updates.bkashNumber = encrypt(credentials.bkashNumber);
  if (credentials.bkashUsername) updates.bkashUsername = encrypt(credentials.bkashUsername);
  if (credentials.bkashPassword) updates.bkashPassword = encrypt(credentials.bkashPassword);
  if (credentials.bkashAppKey) updates.bkashAppKey = encrypt(credentials.bkashAppKey);
  if (credentials.bkashAppSecret) updates.bkashAppSecret = encrypt(credentials.bkashAppSecret);
  if (credentials.bkashApiBaseUrl) updates.bkashApiBaseUrl = credentials.bkashApiBaseUrl; // URL, not encrypted

  await prisma.merchantSettings.update({
    where: { shopDomain: session.shop },
    data: updates,
  });

  // Invalidate cached bKash token so next payment uses fresh credentials
  invalidateToken(session.shop);

  await prisma.auditLog.create({
    data: {
      shopDomain: session.shop,
      action: "BKASH_CREDENTIALS_UPDATED",
      actor: session.email ?? session.shop,
      metadata: { fieldsUpdated: Object.keys(updates) },
    },
  });

  return json({ success: true, data: { updated: true } });
}
