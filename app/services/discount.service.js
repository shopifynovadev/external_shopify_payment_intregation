import prisma from "../db.server.js";

const DISCOUNT_QUERY = `
  query GetDiscount($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title
          usageLimit
          asyncUsageCount
          minimumRequirement {
            ... on DiscountMinimumSubtotal {
              greaterThanOrEqualToSubtotal {
                amount
                currencyCode
              }
            }
          }
          customerGets {
            value {
              ... on DiscountPercentage {
                percentage
              }
              ... on DiscountAmount {
                amount {
                  amount
                  currencyCode
                }
                appliesOnEachItem
              }
            }
          }
          startsAt
          endsAt
          status
        }
      }
    }
  }
`;

export async function validateDiscount({ shopDomain, code, cartSubtotal, accessToken }) {
  if (!code) return { valid: false, discountAmount: 0, reason: "No code provided" };

  const res = await fetch(
    `https://${shopDomain}/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: DISCOUNT_QUERY, variables: { code } }),
    }
  );

  if (!res.ok) {
    throw new Error(`Admin API error: ${res.status}`);
  }

  const { data, errors } = await res.json();

  if (errors?.length) {
    throw new Error(`GraphQL error: ${errors[0].message}`);
  }

  const node = data?.codeDiscountNodeByCode;
  if (!node) return { valid: false, discountAmount: 0, reason: "Invalid discount code" };

  const discount = node.codeDiscount;

  if (discount.status !== "ACTIVE") {
    return { valid: false, discountAmount: 0, reason: "Discount code is not active" };
  }

  const now = new Date();
  if (discount.endsAt && new Date(discount.endsAt) < now) {
    return { valid: false, discountAmount: 0, reason: "Discount code has expired" };
  }

  if (discount.usageLimit && discount.asyncUsageCount >= discount.usageLimit) {
    return { valid: false, discountAmount: 0, reason: "Discount usage limit reached" };
  }

  const minRequirement = discount.minimumRequirement?.greaterThanOrEqualToSubtotal;
  if (minRequirement && cartSubtotal < parseFloat(minRequirement.amount)) {
    return {
      valid: false,
      discountAmount: 0,
      reason: `Minimum order amount of ${minRequirement.amount} ${minRequirement.currencyCode} required`,
    };
  }

  const valueNode = discount.customerGets?.value;
  let discountAmount = 0;

  if (valueNode?.percentage !== undefined) {
    discountAmount = parseFloat((cartSubtotal * valueNode.percentage).toFixed(2));
  } else if (valueNode?.amount) {
    discountAmount = parseFloat(valueNode.amount.amount);
  }

  return { valid: true, discountAmount, reason: null };
}
