(() => {
  class CheckoutBkashForm {
    constructor(el) {
      this.el = el;
      this.appUrl = el.dataset.appUrl;
      this.shopDomain = el.dataset.shop;
      this.cartData = null;
      this.selectedRate = null;
      this.weightShipping = 0;
      this.weightRates = {};
      this.discountCode = null;
      this.discountAmount = 0;
      this.discountApplied = false;

      this._cartSyncTimer = null;
      this._cartObserver = null;
      this.selectedDivision = null;
      this.cachedShippingDetails = null;

      this.$ = (id) => document.getElementById(id);
      this.init();
      this.bindEvents();
    }

    // ─── Event Binding ────────────────────────────────────────────────────────

    bindEvents() {
      // this.$("checkout-form_apply-discount")?.addEventListener("click", () => this.applyDiscount());
      // this.$("checkout-form_pay-btn")?.addEventListener("click", () => this.pay());

      // const addressFields = ["checkout-form_district", "checkout-form_thana", "checkout-form_street", "checkout-form_division"];
      // addressFields.forEach((id) => {
      //   this.$(id)?.addEventListener("change", () => {
      //     this.selectedRate = null;
      //     this.validateForm();
      //   });
      // });

      // ["checkout-form_name", "checkout-form_phone", "checkout-form_district", "checkout-form_thana", "checkout-form_street"].forEach((id) => {
      //   this.$(id)?.addEventListener("input", () => this.validateForm());
      // });

      // division changes
      const divisionSelect = this.$("division");
      if (!divisionSelect) {
        console.warn("#division not found — check your selector or render timing");
        return;
      }

      divisionSelect.addEventListener("change", (e) => {
        this.selectedDivision = e.target.value;
        this.onDivisionChange(this.selectedDivision);
      });
    }

    async init() {
      try {
        await Promise.all([this.loadConfig(), this.loadCart(), this.loadShippingConfig()]);
        // this.checkReturnFromBkash();
        // this.setupCartObserver();
        // this.listenForDiscountEvents();
      } catch (err) {
        this.showBanner(`Failed to load payment form: ${err.message}`, "error");
      }
    }

    // ─── Cookie Helpers ───────────────────────────────────────────────────────

    getCookie(name) {
      const m = document.cookie.match("(^|;)\\s*" + name + "\\s*=\\s*([^;]+)");
      return m ? decodeURIComponent(m[2]) : null;
    }

    setCookie(name, value, days) {
      const exp = new Date(Date.now() + days * 864e5).toUTCString();
      document.cookie = `${name}=${encodeURIComponent(value)};expires=${exp};path=/;SameSite=Lax`;
    }

    clearCookie(name) {
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/`;
    }

    // ─── Shipping Config ──────────────────────────────────────────────────────
    onDivisionChange() {
      if (!this.cachedShippingDetails) {
        this.querySelector(".shipping-warning").style.display = "block";
        return;
      }

      const config = JSON.parse(this.cachedShippingDetails);
      this.applyShippingConfig(config, this.selectedDivision);
    }

    async loadShippingConfig() {
      if (!this.appUrl || !this.shopDomain) return;

      this.cachedShippingDetails = this.getCookie("nova_sc");
      
      const divisionSelect = this.querySelector("#division");
      const currentDivision = divisionSelect?.value;

      if (this.cachedShippingDetails) {
        // Config already cached — just apply if division is selected
        if (currentDivision) {
          this.applyShippingConfig(JSON.parse(this.cachedShippingDetails), currentDivision);
        }
        return;
      }

      try {
        const res = await fetch(`${this.appUrl}/api/shipping/config?shop=${this.shopDomain}`);
        const json = await res.json();
        if (!json.success) return;

        this.setCookie("nova_sc", JSON.stringify(json.data), 2);

        // Apply immediately if division already has a value
        if (currentDivision) {
          this.applyShippingConfig(json.data, currentDivision);
        }
      } catch {
        this.querySelector(".shipping-warning").style.display = "block";
      }
    }

    async applyShippingConfig(config, division) {
      const bdRates = config.BD ?? {};
      const weightRates = {};
      const namedRates = {};

      for (const [key, price] of Object.entries(bdRates)) {
        if (!isNaN(Number(key))) {
          weightRates[Number(key)] = price;
        } else {
          namedRates[key] = price;
        }
      }

      this.weightRates = weightRates;

      const divisionRate = this.getDivisionRate(namedRates, division);
      const result = await this.calculateShipping(weightRates, divisionRate);

      this.renderShippingResult({ ...result, division });

      if (typeof window.updateShippingValues === "function") {
        window.updateShippingValues(result.total);
      }
    }

    async calculateShipping(weightRates, divisionRate) {
      const cartItems = await this.getCartItems();

      let weightTotal = 0;
      let hasWeightProduct = false;
      let hasNonWeightProduct = false;

      for (const item of cartItems.items) {
        const itemWeightKg = item.grams / 1000;
        const rate = weightRates[itemWeightKg];
        console.log(rate);

        if (rate) {
          hasWeightProduct = true;
          weightTotal += rate * item.quantity;
        } else {
          hasNonWeightProduct = true;
        }
      }

      // Weighted only → weight rates only
      // Non-weighted only → division rate only
      // Both → weight rates + division rate
      let total = 0;
      if (hasWeightProduct) total += weightTotal;
      if (hasNonWeightProduct) total += divisionRate;

      return { weightTotal, divisionRate, hasWeightProduct, hasNonWeightProduct, total };
    }

    getDivisionRate(namedRates, division) {
      if (!division) return 0;

      const divLower = division.toLowerCase();

      if (divLower === "dhaka") {
        return namedRates["Inside Dhaka"] ?? 0;
      } else {
        return namedRates["Outside Dhaka"] ?? 0;
      }
    }

    async getCartItems() {
      try {
        const res = await fetch("/cart.js");
        const cart = await res.json();
        return cart ?? [];
      } catch {
        console.error("Failed to fetch cart");
        return [];
      }
    }

    renderShippingResult({ weightTotal, divisionRate, hasWeightProduct, hasNonWeightProduct, total, division }) {
      const shippingContainer = this.$("checkout-form_shipping-section");
      const container = this.$("checkout-form_shipping-rates");
      const warning = shippingContainer.querySelector(".shipping-warning");

      if (!division) {
        warning.style.display = "block";
        container.innerHTML = "";
        return;
      }

      warning.style.display = "none";

      container.innerHTML = `
        <label class="checkout-form_payment-option" data-type="full">
          <input
            class="checkout-form_payment-option__input"
            type="radio"
            name="shippingMethod"
            value="${total}"
            data-label="${division}-delivery"
            checked
          >
          <span class="checkout-form_payment-option__card">
            <span class="checkout-form_payment-option__radio-dot"></span>
            <span class="checkout-form_payment-option__text">
              <span class="checkout-form_payment-option__title">Total Shipping</span>
              <span class="checkout-form_payment-option__amount" data-amount>৳${total}</span>
            </span>
          </span>
        </label>
      `;
    }

    // ─── Cart Observer ────────────────────────────────────────────────────────

    setupCartObserver() {
      const candidates = [
        "#main-cart-items",
        ".cart__items",
        "[data-cart-items]",
        "cart-items",
      ];

      const targets = candidates
        .map(sel => document.querySelector(sel))
        .filter(Boolean);

      if (targets.length === 0) return;

      this._cartObserver = new MutationObserver(() => {
        clearTimeout(this._cartSyncTimer);
        this._cartSyncTimer = setTimeout(() => this.syncCartFromTheme(), 300);
      });

      targets.forEach(target => {
        this._cartObserver.observe(target, { childList: true, subtree: true });
      });
    }

    async syncCartFromTheme() {
      try {
        this.cartData = await this.getCartItems();

        if (this.cartData.item_count === 0) {
          this.showBanner("Your cart is empty.", "info");
          const btn = this.$("checkout-form_pay-btn");
          if (btn) btn.disabled = true;
        } else {
          this.validateForm();
        }

        // Recalculate weight shipping with updated cart
        this.weightShipping = this.applyShippingConfig(this.cachedShippingDetails, this.selectedDivision);
        this.updateSummary();
      } catch {
        // Silent fail
      }
    }

    // ─── Discount Event Listener ──────────────────────────────────────────────

    listenForDiscountEvents() {
      document.addEventListener("discount:update", (e) => {
        const data = e.detail?.data;
        if (!data) return;

        this.cartData = {
          ...this.cartData,
          total_price: data.total_price,
          original_total_price: data.original_total_price,
          total_discount: data.total_discount,
          cart_level_discount_applications: data.cart_level_discount_applications ?? [],
          items: data.items ?? this.cartData?.items,
        };

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
        const btn = this.$("checkout-form_pay-btn");
        if (btn) btn.disabled = true;
      }
    }

    async loadCart() {
      this.cartData = await this.getCartItems();
      if (this.cartData.item_count === 0) {
        this.showBanner("Your cart is empty.", "info");
        const btn = this.$("checkout-form_pay-btn");
        if (btn) btn.disabled = true;
        return;
      }
      this.updateSummary();
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
      const subtotalEl = this.$("checkout-form_subtotal");
      if (!subtotalEl) {
        // Summary elements not rendered (init() still commented out) —
        // delegate to the Liquid inline summary instead
        if (typeof window.updateShippingValues === "function") {
          window.updateShippingValues();
        }
        return;
      }

      const subtotal = this.cartData ? this.cartData.total_price / 100 : 0;
      const shipping = this.weightShipping + (this.selectedRate?.price ?? 0);
      const discount = this.discountAmount;
      const total = Math.max(0, subtotal + shipping - discount);

      subtotalEl.textContent = `৳${subtotal.toFixed(2)}`;
      this.$("checkout-form_shipping-cost").textContent = shipping > 0 ? `৳${shipping.toFixed(2)}` : "—";
      this.$("checkout-form_total").textContent = `৳${total.toFixed(2)}`;

      const discountRow = this.$("checkout-form_discount-row");
      if (discount > 0) {
        discountRow.style.display = "flex";
        this.$("checkout-form_discount-amount").textContent = `-৳${discount.toFixed(2)}`;
      } else {
        discountRow.style.display = "none";
      }

      const summary = this.$("checkout-form_summary");
      if (summary) summary.style.display = "block";
    }

    // ─── Form Validation ──────────────────────────────────────────────────────

    validateForm() {
      const name = this.$("checkout-form_name")?.value.trim();
      const phone = this.$("checkout-form_phone")?.value.trim();
      const district = this.$("checkout-form_district")?.value.trim();
      const thana = this.$("checkout-form_thana")?.value.trim();
      const street = this.$("checkout-form_street")?.value.trim();

      // Named rate required only if named rate options are present
      const hasNamedOptions = (this.$("checkout-form_shipping-rates")
        ?.querySelectorAll('input[type="radio"]').length ?? 0) > 0;
      const hasShipping = !hasNamedOptions || !!this.selectedRate;

      const valid = name && phone && district && thana && street && hasShipping;
      const btn = this.$("checkout-form_pay-btn");
      if (btn) btn.disabled = !valid;
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
          shippingSource: "shopify",
          shippingRate: {
            title: this.selectedRate?.title ?? null,
            expectedTotal: this.weightShipping + (this.selectedRate?.price ?? 0),
          },
          discountCode: this.discountCode,
          customerInfo: { name, phone, email, address: { division, district, thana, street } },
          lineItems,
        }),
      });

      const json = await res.json();

      if (json.success) {
        sessionStorage.setItem("nova_payment_id", json.data.paymentId);
        window.location.href = json.data.redirectUrl;
      } else {
        this.setProcessing(false);
        if (json.code === "SHIPPING_RATE_CHANGED") {
          this.clearCookie("nova_sc");
        }
        this.showBanner(json.error, "error");
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
      const form = this.$("checkout-form_form");
      const processing = this.$("checkout-form_processing");
      if (form) form.style.display = on ? "none" : "block";
      if (processing) processing.style.display = on ? "block" : "none";
    }

    showBanner(msg, type) {
      const el = this.$("checkout-form_banner");
      if (!el) return;
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
  }

  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("checkout-form_bkash-cart-block");
    if (el) {
      window.CheckoutBkashForm = new CheckoutBkashForm(el);
    }
  });
})();
