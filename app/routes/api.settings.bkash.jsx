
import { authenticate } from "../shopify.server.js";
import prisma from "../db.server.js";
import { decrypt } from "../utils/crypto.js";

function maskValue(value) {
  if (!value) return null;
  const decrypted = decrypt(value);
  if (!decrypted) return null;
  return decrypted.length > 4
    ? "•".repeat(decrypted.length - 4) + decrypted.slice(-4)
    : "••••";
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);

  const settings = await prisma.merchantSettings.findUnique({
    where: { shopDomain: session.shop },
    select: {
      bkashNumber: true,
      bkashUsername: true,
      bkashPassword: true,
      bkashAppKey: true,
      bkashAppSecret: true,
      bkashApiBaseUrl: true,
      hideCheckout: true,
      enabledThemes: true,
    },
  });

  // Return masked values — never return decrypted credentials to the frontend
  return ({
    success: true,
    data: {
      bkashNumber: maskValue(settings?.bkashNumber),
      bkashUsername: maskValue(settings?.bkashUsername),
      bkashPassword: settings?.bkashPassword ? "••••••••" : null,
      bkashAppKey: maskValue(settings?.bkashAppKey),
      bkashAppSecret: maskValue(settings?.bkashAppSecret),
      bkashApiBaseUrl: settings?.bkashApiBaseUrl ?? null,
      isConfigured: !!(settings?.bkashAppKey && settings?.bkashAppSecret),
      hideCheckout: settings?.hideCheckout ?? true,
      enabledThemes: settings?.enabledThemes ?? [],
    },
  });
}
