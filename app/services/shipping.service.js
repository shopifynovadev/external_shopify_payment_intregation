const DELIVERY_PROFILES_QUERY = `
  query DeliveryZoneList {
    deliveryProfiles(first: 10) {
      edges {
        node {
          profileLocationGroups {
            locationGroupZones(first: 20) {
              edges {
                node {
                  zone {
                    countries { code { countryCode } }
                  }
                  methodDefinitions(first: 20) {
                    edges {
                      node {
                        active
                        name
                        rateProvider {
                          __typename
                          ... on DeliveryRateDefinition {
                            price { amount }
                          }
                        }
                        methodConditions {
                          field
                          conditionCriteria {
                            __typename
                            ... on Weight { unit value }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// In-process cache — display route only (payment initiate always fetches fresh)
const shippingConfigCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function toKg(value, unit) {
  switch (unit) {
    case "KILOGRAMS": return value;
    case "GRAMS":     return value / 1000;
    case "POUNDS":    return value * 0.453592;
    case "OUNCES":    return value * 0.0283495;
    default:          return value;
  }
}

function parseDeliveryProfiles(profileEdges) {
  const bdRates = {};

  for (const profileEdge of profileEdges) {
    for (const locationGroup of profileEdge.node.profileLocationGroups) {
      for (const zoneEdge of locationGroup.locationGroupZones.edges) {
        const zone = zoneEdge.node;
        const isBD = zone.zone.countries.some(c => c.code.countryCode === "BD");
        if (!isBD) continue;

        for (const methodEdge of zone.methodDefinitions.edges) {
          const method = methodEdge.node;
          if (!method.active) continue;
          if (method.rateProvider.__typename !== "DeliveryRateDefinition") continue;

          const price = parseFloat(method.rateProvider.price.amount);

          // Weight conditions: pick the largest weight value as the rate key
          const weightConds = method.methodConditions.filter(
            c => c.conditionCriteria.__typename === "Weight"
          );

          if (weightConds.length > 0) {
            const maxCond = weightConds.reduce((max, c) =>
              c.conditionCriteria.value > max.conditionCriteria.value ? c : max
            );
            const kg = toKg(maxCond.conditionCriteria.value, maxCond.conditionCriteria.unit);
            bdRates[kg] = price;
          } else {
            bdRates[method.name] = price;
          }
        }
      }
    }
  }

  return bdRates;
}

async function fetchFromShopify(shopDomain, accessToken) {
  const res = await fetch(`https://${shopDomain}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query: DELIVERY_PROFILES_QUERY }),
  });

  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);

  return parseDeliveryProfiles(json.data.deliveryProfiles.edges);
}

/**
 * @param {{ shopDomain: string, accessToken: string, noCache?: boolean }} opts
 * noCache: true  → always fetch fresh (payment initiate — rate verification)
 * noCache: false → use in-process 1-hour cache (display route)
 */
export async function getShippingConfig({ shopDomain, accessToken, noCache = false }) {
  if (!noCache) {
    const cached = shippingConfigCache.get(shopDomain);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
  }

  const bdRates = await fetchFromShopify(shopDomain, accessToken);
  const data = { BD: bdRates };

  if (!noCache) {
    shippingConfigCache.set(shopDomain, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  return data;
}

/**
 * Calculate server-side shipping and verify against what was shown to the customer.
 * Throws SHIPPING_RATE_CHANGED if live rates differ from expectedTotal by more than ৳1.
 *
 * @param {{ config: object, lineItemsWithKg: Array<{kg: number, quantity: number}>, namedRateTitle: string|null, expectedTotal: number }}
 * @returns {{ shippingPrice: number, shippingTitle: string }}
 */
export function calculateShipping({ config, lineItemsWithKg, namedRateTitle, expectedTotal }) {
  const bdRates = config.BD ?? {};

  let weightShipping = 0;
  for (const item of lineItemsWithKg) {
    const rate = bdRates[item.kg];
    if (rate != null) weightShipping += rate * item.quantity;
  }

  let namedRatePrice = 0;
  if (namedRateTitle) {
    const price = bdRates[namedRateTitle];
    if (price == null) {
      throw Object.assign(
        new Error(`Invalid shipping option: ${namedRateTitle}`),
        { code: "INVALID_SHIPPING" }
      );
    }
    namedRatePrice = price;
  }

  const shippingPrice = parseFloat((weightShipping + namedRatePrice).toFixed(2));

  if (Math.abs(shippingPrice - expectedTotal) > 1) {
    throw Object.assign(
      new Error("Shipping rates have changed. Please refresh the page."),
      { code: "SHIPPING_RATE_CHANGED" }
    );
  }

  const shippingTitle = namedRateTitle ?? (weightShipping > 0 ? "Weight-based shipping" : "Free Shipping");

  return { shippingPrice, shippingTitle };
}
