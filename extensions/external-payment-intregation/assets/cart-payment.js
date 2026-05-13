(() => {
  class CheckoutBkashForm {
    constructor(el) {
      this.el = el;
      this.appUrl = el.dataset.appUrl;
      this.shopDomain = el.dataset.shop;
      this.cartData = null;
      this.selectedRate = null; // { code, title, price }
      this.discountCode = null;
      this.discountAmount = 0;
      this.discountApplied = false;

      // Debounce timer for MutationObserver cart sync
      this._cartSyncTimer = null;
      // MutationObserver instance
      this._cartObserver = null;

      this.$ = (id) => document.getElementById(id);
      // this.init();

      this.fetchShippingRates();
    }

    async init() {
      try {
        await Promise.all([this.loadConfig(), this.loadCart()]);
        this.checkReturnFromBkash();
        this.bindEvents();
        this.setupCartObserver();
        this.listenForDiscountEvents();
      } catch (err) {
        this.showBanner(`Failed to load payment form: ${err.message}`, "error");
      }
    }

    // ─── Cart Observer ────────────────────────────────────────────────────────

    /**
     * MutationObserver — watches the theme's own cart content sections.
     * When the theme re-renders quantities/removals via Section Rendering API,
     * we detect the DOM change and re-sync our summary from /cart.js.
     *
     * Targets both the cart items list and the cart footer (where totals live),
     * since different themes update different containers.
     */
    setupCartObserver() {
      // Common cart content selectors across Dawn-based themes.
      // We try each and observe the first one found.
      const candidates = [
        '#main-cart-items',
        '#main-cart-footer',
        '.cart__items',
        '[data-cart-items]',
        'cart-items',
      ];

      const targets = candidates
        .map(sel => document.querySelector(sel))
        .filter(Boolean);

      if (targets.length === 0) return;

      this._cartObserver = new MutationObserver(() => {
        // Debounce: the theme may do several DOM writes in one update cycle.
        // Wait until it's settled before re-fetching.
        clearTimeout(this._cartSyncTimer);
        this._cartSyncTimer = setTimeout(() => this.syncCartFromTheme(), 300);
      });

      targets.forEach(target => {
        this._cartObserver.observe(target, { childList: true, subtree: true });
      });
    }

    /**
     * Called after the MutationObserver fires (debounced).
     * Re-fetches the live cart and updates our summary.
     * Preserves discount state — the cart DOM change doesn't affect discounts.
     */
    async syncCartFromTheme() {
      try {
        const res = await fetch('/cart.js');
        const cart = await res.json();
        this.cartData = cart;

        if (cart.item_count === 0) {
          this.showBanner("Your cart is empty.", "info");
          this.$("checkout-form_pay-btn").disabled = true;
        } else {
          // Re-validate form in case pay button was disabled due to empty cart
          this.validateForm();
        }

        this.updateSummary();
      } catch {
        // Silent fail — cart summary just stays as-is
      }
    }

    // ─── Discount Event Listener ──────────────────────────────────────────────

    /**
     * cart-discount.js dispatches 'discount:update' on document after every
     * apply or remove. The event detail contains the full Shopify cart response
     * including updated total_price and total_discount — so we don't need an
     * extra /cart.js fetch here.
     */
    listenForDiscountEvents() {
      document.addEventListener('discount:update', (e) => {
        const data = e.detail?.data;
        if (!data) return;

        // Update our local cartData with the fresh totals from the discount response
        this.cartData = {
          ...this.cartData,
          total_price: data.total_price,
          original_total_price: data.original_total_price,
          total_discount: data.total_discount,
          cart_level_discount_applications: data.cart_level_discount_applications ?? [],
          items: data.items ?? this.cartData?.items,
        };

        // Reflect Shopify-applied discount amount into our summary.
        // cart-discount.js handles Shopify native discount codes via /cart/update.
        // We read total_discount directly from the cart response.
        this.discountAmount = (data.total_discount ?? 0) / 100;

        this.updateSummary();
      });
    }

    // ─── Config & Cart Loading ────────────────────────────────────────────────

    async loadConfig() {
      const res = await fetch(`${this.appUrl}/api/storefront-config?shop=${this.shopDomain}`);
      const json = await res.json();
      if (!json.success) throw new Error("Payment not configured for this store");
      if (!json.data.isPaymentConfigured) {
        this.showBanner("bKash payment is not configured by the store owner.", "warning");
        this.$("checkout-form_pay-btn").disabled = true;
      }
    }

    async loadCart() {
      const res = await fetch("/cart.js");
      this.cartData = await res.json();
      if (this.cartData.item_count === 0) {
        this.showBanner("Your cart is empty.", "info");
        this.$("checkout-form_pay-btn").disabled = true;
        return;
      }
      this.updateSummary();
    }

    // ─── Shipping ─────────────────────────────────────────────────────────────

    async fetchShippingRates() {
      // const district = this.$("checkout-form_district").value.trim();
      // const division = this.$("checkout-form_division").value;

      // if (!district || !division) {
      //   this.showBanner("Please fill in Division and District before fetching shipping rates.", "warning");
      //   return;
      // }

      // this.setShippingRatesLoading(true);

      const params = new URLSearchParams({
        "shipping_address[country]": "Bangladesh"
      });

      try {
        const res = await fetch(`/cart/shipping_rates.json?${params}`);
        const json = await res.json();
        this.setShippingRatesLoading(false);
        this.renderShippingRates(json.shipping_rates ?? []);
      } catch {
        this.setShippingRatesLoading(false);
        this.showBanner("Could not fetch shipping rates. Please try again.", "error");
      }
    }

    renderShippingRates(rates) {
      const container = this.$("checkout-form_shipping-rates");
      this.$("checkout-form_shipping-section").style.display = "block";

      if (rates.length === 0) {
        container.innerHTML = `<p style="color:#d72c0d;font-size:13px;">No shipping rates available for this address.</p>`;
        return;
      }

      container.innerHTML = rates.map((rate) => `
        <label class="checkout-form_rate-option" data-code="${rate.code}" data-price="${rate.price}" data-title="${rate.name}">
          <input type="radio" name="checkout-form_shipping-rate" value="${rate.code}" style="margin:0;" />
          <span style="flex:1;">${rate.name}</span>
          <strong>৳${parseFloat(rate.price).toFixed(2)}</strong>
        </label>
      `).join("");

      container.querySelectorAll(".checkout-form_rate-option").forEach((el) => {
        el.addEventListener("click", () => {
          container.querySelectorAll(".checkout-form_rate-option").forEach((e) => e.classList.remove("selected"));
          el.classList.add("selected");
          el.querySelector("input").checked = true;
          this.selectedRate = {
            code: el.dataset.code,
            title: el.dataset.title,
            price: parseFloat(el.dataset.price),
          };
          this.updateSummary();
          this.validateForm();
        });
      });
    }

    setShippingRatesLoading(loading) {
      const container = this.$("checkout-form_shipping-rates");
      if (loading) {
        container.innerHTML = `<p style="color:#6d7175;font-size:13px;">Fetching rates...</p>`;
      }
      this.$("checkout-form_shipping-section").style.display = "block";
    }

    // ─── Discount (Nova/bKash backend validation) ─────────────────────────────

    async applyDiscount() {
      const code = this.$("checkout-form_discount").value.trim();
      if (!code) return;

      const msgEl = this.$("checkout-form_discount-msg");
      msgEl.textContent = "Validating...";
      msgEl.style.color = "#6d7175";

      const subtotal = this.cartData.total_price / 100;
      const res = await fetch(`${this.appUrl}/api/discount/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopDomain: this.shopDomain, code, cartSubtotal: subtotal }),
      });
      const json = await res.json();

      if (json.success && json.data.valid) {
        this.discountCode = code;
        this.discountAmount = json.data.discountAmount;
        this.discountApplied = true;
        msgEl.textContent = `✓ Code applied — saving ৳${json.data.discountAmount.toFixed(2)}`;
        msgEl.style.color = "#008060";
        this.$("checkout-form_discount").disabled = true;
        this.$("checkout-form_apply-discount").disabled = true;
      } else {
        msgEl.textContent = `✗ ${json.data?.reason ?? json.error ?? "Invalid code"}`;
        msgEl.style.color = "#d72c0d";
        this.discountCode = null;
        this.discountAmount = 0;
        this.discountApplied = false;
      }
      this.updateSummary();
    }

    // ─── Summary ──────────────────────────────────────────────────────────────

    updateSummary() {
      const subtotal = this.cartData ? this.cartData.total_price / 100 : 0;
      const shipping = this.selectedRate?.price ?? 0;
      const discount = this.discountAmount;
      const total = Math.max(0, subtotal + shipping - discount);

      this.$("checkout-form_subtotal").textContent = `৳${subtotal.toFixed(2)}`;
      this.$("checkout-form_shipping-cost").textContent = shipping > 0 ? `৳${shipping.toFixed(2)}` : "—";
      this.$("checkout-form_total").textContent = `৳${total.toFixed(2)}`;

      const discountRow = this.$("checkout-form_discount-row");
      if (discount > 0) {
        discountRow.style.display = "flex";
        this.$("checkout-form_discount-amount").textContent = `-৳${discount.toFixed(2)}`;
      } else {
        discountRow.style.display = "none";
      }

      this.$("checkout-form_summary").style.display = "block";
    }

    // ─── Form Validation ──────────────────────────────────────────────────────

    validateForm() {
      const name = this.$("checkout-form_name").value.trim();
      const phone = this.$("checkout-form_phone").value.trim();
      const district = this.$("checkout-form_district").value.trim();
      const thana = this.$("checkout-form_thana").value.trim();
      const street = this.$("checkout-form_street").value.trim();
      const hasShipping = !!this.selectedRate;

      const valid = name && phone && district && thana && street && hasShipping;
      this.$("checkout-form_pay-btn").disabled = !valid;
    }

    // ─── Payment ──────────────────────────────────────────────────────────────

    async pay() {
      const name = this.$("checkout-form_name").value.trim();
      const phone = this.$("checkout-form_phone").value.trim();
      const email = this.$("checkout-form_email")?.value.trim() ?? null;
      const division = this.$("checkout-form_division").value;
      const district = this.$("checkout-form_district").value.trim();
      const thana = this.$("checkout-form_thana").value.trim();
      const street = this.$("checkout-form_street").value.trim();

      const subtotal = this.cartData.total_price / 100;
      const lineItems = this.cartData.items.map((item) => ({
        variantId: `gid://shopify/ProductVariant/${item.variant_id}`,
        quantity: item.quantity,
        title: item.title,
        price: item.price / 100,
      }));

      this.setProcessing(true);

      const res = await fetch(`${this.appUrl}/api/payment/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopDomain: this.shopDomain,
          shippingRate: this.selectedRate,
          discountCode: this.discountCode,
          customerInfo: { name, phone, email, address: { division, district, thana, street } },
          lineItems,
          subtotal,
        }),
      });

      const json = await res.json();

      if (json.success) {
        sessionStorage.setItem("nova_payment_id", json.data.paymentId);
        window.location.href = json.data.redirectUrl;
      } else {
        this.setProcessing(false);
        this.showBanner(`Payment failed: ${json.error}`, "error");
      }
    }

    // ─── Return from bKash ────────────────────────────────────────────────────

    checkReturnFromBkash() {
      const params = new URLSearchParams(window.location.search);
      const paymentId = params.get("payment_id");
      const status = params.get("payment_status");

      if (paymentId && status === "failed") {
        this.showBanner("Payment was not completed. Please try again.", "error");
        const clean = new URL(window.location.href);
        clean.searchParams.delete("payment_id");
        clean.searchParams.delete("payment_status");
        window.history.replaceState({}, "", clean.toString());
      }
    }

    // ─── UI Helpers ───────────────────────────────────────────────────────────

    setProcessing(on) {
      this.$("checkout-form_form").style.display = on ? "none" : "block";
      this.$("checkout-form_processing").style.display = on ? "block" : "none";
    }

    showBanner(msg, type) {
      const el = this.$("checkout-form_banner");
      const colors = {
        error:   { bg: "#fff4f4", border: "#fda29b", text: "#912018" },
        warning: { bg: "#fffaeb", border: "#fec84b", text: "#92400e" },
        success: { bg: "#f0fdf4", border: "#6ce9a6", text: "#065f46" },
        info:    { bg: "#eff8ff", border: "#b2ddff", text: "#175cd3" },
      };
      const c = colors[type] ?? colors.info;
      el.style.display = "block";
      el.style.background = c.bg;
      el.style.border = `1px solid ${c.border}`;
      el.style.color = c.text;
      el.textContent = msg;
    }

    // ─── Event Binding ────────────────────────────────────────────────────────

    bindEvents() {
      this.$("checkout-form_fetch-shipping-btn")?.addEventListener("click", () => this.fetchShippingRates());
      this.$("checkout-form_apply-discount").addEventListener("click", () => this.applyDiscount());
      this.$("checkout-form_pay-btn").addEventListener("click", () => this.pay());

      const addressFields = ["checkout-form_district", "checkout-form_thana", "checkout-form_street", "checkout-form_division"];
      addressFields.forEach((id) => {
        this.$(id)?.addEventListener("change", () => {
          this.$("checkout-form_fetch-shipping-wrap").style.display = "block";
          this.selectedRate = null;
          this.validateForm();
        });
      });

      ["checkout-form_name", "checkout-form_phone", "checkout-form_district", "checkout-form_thana", "checkout-form_street"].forEach((id) => {
        this.$(id)?.addEventListener("input", () => this.validateForm());
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("checkout-form_bkash-cart-block");
    if (el) {
      // Expose instance on window so checkout-form.liquid's
      // window.updateShippingValues can notify us of shipping changes too.
      window.CheckoutBkashForm = new CheckoutBkashForm(el);
    }
  });
})();