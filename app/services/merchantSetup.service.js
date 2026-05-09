import prisma from "../db.server.js";

const CREATE_STOREFRONT_TOKEN = `
  mutation StorefrontAccessTokenCreate($input: StorefrontAccessTokenInput!) {
    storefrontAccessTokenCreate(input: $input) {
      storefrontAccessToken { accessToken }
      userErrors { field message }
    }
  }
`;

async function createStorefrontToken({ shopDomain, accessToken }) {
  const res = await fetch(`https://${shopDomain}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: CREATE_STOREFRONT_TOKEN,
      variables: { input: { title: "Nova bKash Storefront Token" } },
    }),
  });

  const { data } = await res.json();
  const errors = data?.storefrontAccessTokenCreate?.userErrors ?? [];
  if (errors.length) throw new Error(errors[0].message);

  return data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken ?? null;
}

export async function ensureMerchantSettings({ shopDomain, accessToken }) {
  const existing = await prisma.merchantSettings.findUnique({ where: { shopDomain } });

  if (existing) {
    // Reactivate if previously uninstalled
    if (!existing.isActive) {
      await prisma.merchantSettings.update({ where: { shopDomain }, data: { isActive: true } });
    }
    return existing;
  }

  // First install — create settings + storefront token
  let storefrontAccessToken = null;
  try {
    storefrontAccessToken = await createStorefrontToken({ shopDomain, accessToken });
  } catch (err) {
    console.error(`[merchantSetup] Could not create storefront token for ${shopDomain}:`, err.message);
  }

  const settings = await prisma.merchantSettings.create({
    data: {
      shopDomain,
      storefrontAccessToken,
      isActive: true,
      billingStartDate: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      shopDomain,
      action: "APP_INSTALLED",
      actor: shopDomain,
      metadata: { hasStorefrontToken: !!storefrontAccessToken },
    },
  });

  return settings;
}
