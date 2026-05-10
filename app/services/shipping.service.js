import prisma from "../db.server.js";

const SHIPPING_QUERY = `
  query GetCartDelivery($cartId: ID!) {
    cart(id: $cartId) {
      deliveryGroups {
        deliveryOptions {
          handle
          title
          estimatedCost {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

export async function verifyShippingRate({ shopDomain, cartId, shippingHandle }) {
  const settings = await prisma.merchantSettings.findUnique({
    where: { shopDomain },
    select: { storefrontAccessToken: true },
  });

  if (!settings?.storefrontAccessToken) {
    throw new Error("Storefront access token not configured for this shop");
  }

  const res = await fetch(
    `https://${shopDomain}/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": settings.storefrontAccessToken,
      },
      body: JSON.stringify({ query: SHIPPING_QUERY, variables: { cartId } }),
    }
  );

  if (!res.ok) {
    throw new Error(`Storefront API error: ${res.status}`);
  }

  const { data, errors } = await res.json();

  if (errors?.length) {
    throw new Error(`Storefront GraphQL error: ${errors[0].message}`);
  }

  const options = data?.cart?.deliveryGroups?.flatMap((g) => g.deliveryOptions) ?? [];
  const matched = options.find((o) => o.handle === shippingHandle);

  if (!matched) {
    throw new Error(`Shipping rate handle not found: ${shippingHandle}`);
  }

  return {
    title: matched.title,
    price: parseFloat(matched.estimatedCost.amount),
    currency: matched.estimatedCost.currencyCode,
  };
}
