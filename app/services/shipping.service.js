export async function verifyShippingRate({ shopDomain, division, district, shippingCode, shippingPrice }) {
  const params = new URLSearchParams({
    "shipping_address[country]": "Bangladesh",
    "shipping_address[province]": division,
    "shipping_address[city]": district,
    "shipping_address[zip]": "",
  });

  const res = await fetch(`https://${shopDomain}/cart/shipping_rates.json?${params}`);

  if (!res.ok) {
    throw Object.assign(new Error(`Could not fetch shipping rates from store: ${res.status}`), { code: "SHIPPING_FETCH_FAILED" });
  }

  const json = await res.json();
  const rates = json.shipping_rates ?? [];
  const matched = rates.find((r) => r.code === shippingCode);

  if (!matched) {
    throw Object.assign(new Error(`Shipping rate not found: ${shippingCode}`), { code: "INVALID_SHIPPING_RATE" });
  }

  const verifiedPrice = parseFloat(matched.price);
  if (Math.abs(verifiedPrice - shippingPrice) > 0.01) {
    throw Object.assign(new Error("Shipping price mismatch"), { code: "SHIPPING_PRICE_MISMATCH" });
  }

  return { title: matched.name, price: verifiedPrice };
}
