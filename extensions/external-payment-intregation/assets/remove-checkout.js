if (document.querySelector("#main-cart-footer")) {
  document.querySelector("#main-cart-footer").remove();
}

if (document.querySelectorAll("[name=checkout]").length > 0) {
  document.querySelectorAll("[name=checkout]").forEach(el => el.remove());
}