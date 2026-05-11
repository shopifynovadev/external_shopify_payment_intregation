import prisma from "../db.server.js";

const UPSERT_APP_URL_METAFIELD = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

async function setAppUrlMetafield({ shopDomain, accessToken }) {
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) return;
  await fetch(`https://${shopDomain}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({
      query: UPSERT_APP_URL_METAFIELD,
      variables: {
        metafields: [{
          ownerId: `gid://shopify/Shop/1`,
          namespace: "nova_bkash",
          key: "app_url",
          value: appUrl,
          type: "single_line_text_field",
        }],
      },
    }),
  }).catch(() => {});
}

export async function ensureMerchantSettings({ shopDomain, accessToken }) {
  const existing = await prisma.merchantSettings.findUnique({ where: { shopDomain } });

  if (existing) {
    if (!existing.isActive) {
      await prisma.merchantSettings.update({ where: { shopDomain }, data: { isActive: true } });
    }
    return existing;
  }

  // Write app URL to shop metafield so Liquid theme blocks can read it without merchant config
  await setAppUrlMetafield({ shopDomain, accessToken });

  const settings = await prisma.merchantSettings.create({
    data: {
      shopDomain,
      storefrontAccessToken: null,
      isActive: true,
      billingStartDate: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      shopDomain,
      action: "APP_INSTALLED",
      actor: shopDomain,
      metadata: {},
    },
  });

  return settings;
}
