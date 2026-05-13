// if (document.querySelector("#main-cart-footer")) {
//   document.querySelector("#main-cart-footer").remove();
// }

if (document.querySelectorAll("[name=checkout], [data-shopify=payment-button]").length > 0) {
  document.querySelectorAll("[name=checkout]").forEach(el => el.remove());
}

if (document.querySelector("cart-drawer")) {
  const view_cart_element = `
  <a href="/cart" class="button button--primary view-cart">
    View Cart
  </a>
  `;

  document.querySelector("cart-drawer .drawer__footer .cart__ctas").insertAdjacentHTML("beforeend", view_cart_element);
}