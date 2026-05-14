(() => {
  class NovaBkashCart {
    constructor(el) {
      this.el = el;
      this.appUrl = el.dataset.appUrl;
      this.shopDomain = el.dataset.shop;
      this.cartData = null;
      this.selectedRate = null; // { code, title, price }
      this.discountCode = null;
      this.discountAmount = 0;
      this.discountApplied = false;
      this.paymentPercentage = 100; // frontend dev can set to 25 or 50 via setPaymentPercentage()

      this.$ = (id) => document.getElementById(id);
      this.init();
    }

    async init() {
      try {
        await Promise.all([this.loadConfig(), this.loadCart()]);
        this.checkReturnFromBkash();
        this.bindEvents();
      } catch (err) {
        this.showBanner(`Failed to load payment form: ${err.message}`, "error");
      }
    }

    async loadConfig() {
      const res = await fetch(`${this.appUrl}/api/storefront-config?shop=${this.shopDomain}`);
      const json = await res.json();
      if (!json.success) throw new Error("Payment not configured for this store");
      if (!json.data.isPaymentConfigured) {
        this.showBanner("bKash payment is not configured by the store owner.", "warning");
        this.$("nova-pay-btn").disabled = true;
      }
    }

    async loadCart() {
      const res = await fetch("/cart.js");
      this.cartData = await res.json();
      if (this.cartData.item_count === 0) {
        this.showBanner("Your cart is empty.", "info");
        this.$("nova-pay-btn").disabled = true;
        return;
      }
      this.updateSummary();
    }

    async fetchShippingRates() {
      const district = this.$("nova-district").value.trim();
      const division = this.$("nova-division").value;

      if (!district || !division) {
        this.showBanner("Please fill in Division and District before fetching shipping rates.", "warning");
        return;
      }

      this.setShippingRatesLoading(true);

      const subtotal = this.cartData ? this.cartData.total_price / 100 : 0;
      const params = new URLSearchParams({
        shop: this.shopDomain,
        division,
        total: subtotal,
      });

      try {
        const res = await fetch(`${this.appUrl}/api/shipping/rates?${params}`);
        const json = await res.json();
        this.setShippingRatesLoading(false);
        if (!json.success) {
          this.showBanner("Could not fetch shipping rates. Please try again.", "error");
          return;
        }
        this.renderShippingRates(json.data ?? []);
      } catch {
        this.setShippingRatesLoading(false);
        this.showBanner("Could not fetch shipping rates. Please try again.", "error");
      }
    }

    renderShippingRates(rates) {
      const container = this.$("nova-shipping-rates");
      this.$("nova-shipping-section").style.display = "block";

      if (rates.length === 0) {
        container.innerHTML = `<p style="color:#d72c0d;font-size:13px;">No shipping rates available for this address.</p>`;
        return;
      }

      container.innerHTML = rates.map((rate) => `
        <label class="nova-rate-option" data-code="${rate.id}" data-price="${rate.price}" data-title="${rate.title}">
          <input type="radio" name="nova-shipping-rate" value="${rate.id}" style="margin:0;" />
          <span style="flex:1;">${rate.title}${rate.estimatedDays ? ` (${rate.estimatedDays} days)` : ""}</span>
          <strong>${rate.isFree ? "Free" : `৳${parseFloat(rate.price).toFixed(2)}`}</strong>
        </label>
      `).join("");

      container.querySelectorAll(".nova-rate-option").forEach((el) => {
        el.addEventListener("click", () => {
          container.querySelectorAll(".nova-rate-option").forEach((e) => e.classList.remove("selected"));
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
      const container = this.$("nova-shipping-rates");
      if (loading) {
        container.innerHTML = `<p style="color:#6d7175;font-size:13px;">Fetching rates...</p>`;
      }
      this.$("nova-shipping-section").style.display = "block";
    }

    async applyDiscount() {
      const code = this.$("nova-discount").value.trim();
      if (!code) return;

      const msgEl = this.$("nova-discount-msg");
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
        this.$("nova-discount").disabled = true;
        this.$("nova-apply-discount").disabled = true;
      } else {
        msgEl.textContent = `✗ ${json.data?.reason ?? json.error ?? "Invalid code"}`;
        msgEl.style.color = "#d72c0d";
        this.discountCode = null;
        this.discountAmount = 0;
        this.discountApplied = false;
      }
      this.updateSummary();
    }

    updateSummary() {
      const subtotal = this.cartData ? this.cartData.total_price / 100 : 0;
      const shipping = this.selectedRate?.price ?? 0;
      const discount = this.discountAmount;
      const fullTotal = Math.max(0, subtotal + shipping - discount);
      const chargedNow = parseFloat((fullTotal * (this.paymentPercentage ?? 100) / 100).toFixed(2));

      this.$("nova-subtotal").textContent = `৳${subtotal.toFixed(2)}`;
      this.$("nova-shipping-cost").textContent = shipping > 0 ? `৳${shipping.toFixed(2)}` : "—";
      this.$("nova-total").textContent = this.paymentPercentage < 100
        ? `৳${chargedNow.toFixed(2)} (${this.paymentPercentage}% of ৳${fullTotal.toFixed(2)})`
        : `৳${fullTotal.toFixed(2)}`;

      const discountRow = this.$("nova-discount-row");
      if (discount > 0) {
        discountRow.style.display = "flex";
        this.$("nova-discount-amount").textContent = `-৳${discount.toFixed(2)}`;
      } else {
        discountRow.style.display = "none";
      }

      this.$("nova-summary").style.display = "block";
    }

    validateForm() {
      const name = this.$("nova-name").value.trim();
      const phone = this.$("nova-phone").value.trim();
      const district = this.$("nova-district").value.trim();
      const thana = this.$("nova-thana").value.trim();
      const street = this.$("nova-street").value.trim();
      const hasShipping = !!this.selectedRate;

      const valid = name && phone && district && thana && street && hasShipping;
      this.$("nova-pay-btn").disabled = !valid;
    }

    setPaymentPercentage(pct) {
      const allowed = [25, 50, 100];
      if (!allowed.includes(Number(pct))) {
        this.showBanner("Invalid payment option. Choose 25%, 50%, or 100%.", "error");
        return;
      }
      this.paymentPercentage = Number(pct);
      this.updateSummary();
    }

    async pay() {
      const name = this.$("nova-name").value.trim();
      const phone = this.$("nova-phone").value.trim();
      const email = this.$("nova-email")?.value.trim() ?? null;
      const division = this.$("nova-division").value;
      const district = this.$("nova-district").value.trim();
      const thana = this.$("nova-thana").value.trim();
      const street = this.$("nova-street").value.trim();

      const lineItems = this.cartData.items.map((item) => ({
        variantId: `gid://shopify/ProductVariant/${item.variant_id}`,
        quantity: item.quantity,
        title: item.title,
        price: item.price / 100,  // sent for fraud detection — backend verifies against Shopify
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
          paymentPercentage: this.paymentPercentage ?? 100,
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

    setProcessing(on) {
      this.$("nova-form").style.display = on ? "none" : "block";
      this.$("nova-processing").style.display = on ? "block" : "none";
    }

    showBanner(msg, type) {
      const el = this.$("nova-banner");
      const colors = {
        error: { bg: "#fff4f4", border: "#fda29b", text: "#912018" },
        warning: { bg: "#fffaeb", border: "#fec84b", text: "#92400e" },
        success: { bg: "#f0fdf4", border: "#6ce9a6", text: "#065f46" },
        info: { bg: "#eff8ff", border: "#b2ddff", text: "#175cd3" },
      };
      const c = colors[type] ?? colors.info;
      el.style.display = "block";
      el.style.background = c.bg;
      el.style.border = `1px solid ${c.border}`;
      el.style.color = c.text;
      el.textContent = msg;
    }

    bindEvents() {
      this.$("nova-fetch-shipping-btn")?.addEventListener("click", () => this.fetchShippingRates());
      this.$("nova-apply-discount").addEventListener("click", () => this.applyDiscount());
      this.$("nova-pay-btn").addEventListener("click", () => this.pay());

      const addressFields = ["nova-district", "nova-thana", "nova-street", "nova-division"];
      addressFields.forEach((id) => {
        this.$(id)?.addEventListener("change", () => {
          this.$("nova-fetch-shipping-wrap").style.display = "block";
          this.selectedRate = null;
          this.validateForm();
        });
      });

      ["nova-name", "nova-phone", "nova-district", "nova-thana", "nova-street"].forEach((id) => {
        this.$(id)?.addEventListener("input", () => this.validateForm());
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("nova-bkash-cart-block");
    if (el) new NovaBkashCart(el);
  });
})();
