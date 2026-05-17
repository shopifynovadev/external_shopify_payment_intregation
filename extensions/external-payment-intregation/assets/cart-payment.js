(() => {
  class CheckoutBkashForm extends HTMLElement {

    // ─── Web Component Lifecycle ──────────────────────────────────────────────

    connectedCallback() {
      this.appUrl     = this.dataset.appUrl;
      this.shopDomain = this.dataset.shop;

      // Shorthand DOM helper
      this.$ = (id) => document.getElementById(id);

      // Cart & shipping state
      this.cartData              = null;
      this.selectedRate          = null;
      this.weightRates           = {};
      this.cachedShippingDetails = null;
      this.selectedDivision      = null;

      // Discount state
      this.discountElement = this.querySelector("cart-discount-component");

      // Internal timers / observers
      this._cartSyncTimer = null;
      this._cartObserver  = null;

      // Payment Options
      this.paymentOptionsElement = this.querySelector("checkout-form-payment-options");

      this._init();
      this._bindEvents();
    }

    // ─── Initialisation ───────────────────────────────────────────────────────

    async _init() {
      try {
        await Promise.all([
          this._loadConfig(),
          this._loadCart(),
          this._loadShippingConfig(),
        ]);
        this._setupCartObserver();
        this._showCartErrorFromURL();
      } catch (err) {
        this._showBanner(`Failed to load payment form: ${err.message}`, "error");
      }
    }

    // ─── Event Binding ────────────────────────────────────────────────────────

    _bindEvents() {
      const divisionSelect = this.$("division");
      if (!divisionSelect) {
        console.warn("[CheckoutBkashForm] #division not found");
        return;
      }
      divisionSelect.addEventListener("change", (e) => {
        this.selectedDivision = e.target.value;
        this._onDivisionChange();
      });

      const form = document.querySelector("#checkoutForm");
      if (!form) return;

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this._onFormSubmit(form);
      });
    }

    // ─── Button Loading State ─────────────────────────────────────────────────

    _handleButtonLoading(button, isDisabled) {
      if (!button) return;
      button.disabled = isDisabled;
      button.classList.toggle("loading", isDisabled);
      button.querySelector(".loading__spinner")?.classList.toggle("hidden", !isDisabled);
    }

    // ─── Error Restore from URL ───────────────────────────────────────────────

    _showCartErrorFromURL() {
      const urlParams    = new URLSearchParams(window.location.search);
      const token        = urlParams.get("token")?.split("").reverse().join("");
      const error        = decodeURI(urlParams.get("error") ?? "");
      const errorMessage = urlParams.get("message");

      const errorContainer = document.querySelector(".container .cartError");
      const spinner        = errorContainer?.querySelector(".loading__spinner");

      if (token && error) {
        const saved = localStorage.getItem(`cart-${token}`);

        if (saved) {
          const errorText = errorMessage
            ? decodeURI(errorMessage)
            : window.cartError?.[error] ?? "Something went wrong. Please try again.";
          this._showBanner(errorText, "error");

          const data = JSON.parse(saved);
          const form = document.querySelector("#checkoutForm");
          if (data && form) {
            const setVal = (name, val) => {
              const el = form.querySelector(`[name="${name}"]`);
              if (el) el.value = val || "";
            };
            setVal("email",     data.email);
            setVal("phone",     data.phone);
            setVal("firstName", data.first_name);
            setVal("lastName",  data.last_name);
            setVal("address",   data.address);
            setVal("city",      data.city);
            setVal("zip",       data.zip);
            setVal("division",  data.division);
            setVal("country",   data.country);

            if (data.payment_details?.need_to_pay) {
              const paymentInput = document.querySelector(
                `input[name="nova_payment_plan"][value="${data.payment_details.need_to_pay}"]`
              );
              if (paymentInput) paymentInput.checked = true;
            }
          }
        } else {
          const newUrl = window.location.pathname;
          window.history.replaceState({}, document.title, newUrl);
        }
      }

      if (spinner) spinner.classList.add("hidden");
    }

    // ─── Cookie Helpers ───────────────────────────────────────────────────────

    _getCookie(name) {
      const m = document.cookie.match("(^|;)\\s*" + name + "\\s*=\\s*([^;]+)");
      return m ? decodeURIComponent(m[2]) : null;
    }

    _setCookie(name, value, days) {
      const exp = new Date(Date.now() + days * 864e5).toUTCString();
      document.cookie = `${name}=${encodeURIComponent(value)};expires=${exp};path=/;SameSite=Lax`;
    }

    _clearCookie(name) {
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/`;
    }

    // ─── Config & Cart Loading ────────────────────────────────────────────────

    async _loadConfig() {
      const res  = await fetch(`${this.appUrl}/api/storefront-config?shop=${this.shopDomain}`);
      const json = await res.json();
      if (!json.success) throw new Error("Payment not configured for this store");
      if (!json.data.isPaymentConfigured) {
        this._showBanner("bKash payment is not configured by the store owner.", "warning");
        const btn = this.$("payWithBkash");
        if (btn) btn.disabled = true;
      }
    }

    async _loadCart() {
      this.cartData = await this._getCartItems();
      this._refreshUI();
    }

    // ─── UI Refresh ───────────────────────────────────────────────────────────

    // Single entry point to keep summary + payment amounts in sync.
    // Always call this after cartData or selectedRate changes.
    _refreshUI() {
      this._updateSummary();
      this.paymentOptionsElement._renderPaymentAmounts();
    }

    // ─── Shipping Config ──────────────────────────────────────────────────────

    _onDivisionChange() {
      if (!this.cachedShippingDetails) {
        const warning = this.querySelector(".shipping-warning");
        if (warning) warning.style.display = "block";
        return;
      }
      const config = JSON.parse(this.cachedShippingDetails);
      this._applyShippingConfig(config, this.selectedDivision);
    }

    async _onFormSubmit(form) {
      this._handleButtonLoading(this.$("payWithBkash"), true);

      const formData = new FormData(form);

      // Always fetch the latest cart state at submit time to avoid stale totals
      const cart = await fetch("/cart.js").then(res => res.json());

      const selectedShippingInput = document.querySelector('input[name="shippingMethod"]:checked');
      const namedRatePrice        = parseFloat(selectedShippingInput?.value);
      const namedRateTitle        = selectedShippingInput?.dataset?.label;

      const order_details = {
        cart_details: cart,
        shipping_details: {
          email:      formData.get("email"),
          phone:      formData.get("phone"),
          first_name: formData.get("firstName"),
          last_name:  formData.get("lastName"),
          address:    formData.get("address"),
          city:       formData.get("city"),
          zip:        formData.get("zip"),
          division:   formData.get("division"),
          country:    formData.get("country"),
          countryCode: formData.get("country") === "bangladesh" ? "BD" : null,
          payment_details: {
            pay_type:    formData.get("checkout-form_selected-amount"),
            need_to_pay: formData.get("checkout-form_selected-plan"),
          },
          shipping_method: {
            title: namedRateTitle,
            rate:  namedRatePrice,
          },
        },
      };

      if (cart.token) {
        localStorage.setItem(
          `cart-${cart.token.split("?key=")[1]}`,
          JSON.stringify(order_details.shipping_details)
        );
      }

      try {
        const res = await fetch(`${this.appUrl}/api/payment/initiate`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(order_details),
        });

        const data = await res.json();
        if (data?.bkashURL) {
          window.location.href = data.bkashURL;
        } else {
          console.error("[CheckoutBkashForm] No bkashURL in response");
          this._handleButtonLoading(this.$("payWithBkash"), false);
        }
      } catch (error) {
        console.error("[CheckoutBkashForm] Payment error:", error);
        this._handleButtonLoading(this.$("payWithBkash"), false);
      }
    }

    async _loadShippingConfig() {
      if (!this.appUrl || !this.shopDomain) return;

      this.cachedShippingDetails = this._getCookie("nova_sc");

      const divisionSelect  = this.querySelector("#division");
      const currentDivision = divisionSelect?.value;

      if (this.cachedShippingDetails) {
        if (currentDivision) {
          this._applyShippingConfig(JSON.parse(this.cachedShippingDetails), currentDivision);
        }
        return;
      }

      try {
        const res  = await fetch(`${this.appUrl}/api/shipping/config?shop=${this.shopDomain}`);
        const json = await res.json();
        if (!json.success) return;

        this._setCookie("nova_sc", JSON.stringify(json.data), 2);
        this.cachedShippingDetails = JSON.stringify(json.data);

        if (currentDivision) {
          this._applyShippingConfig(json.data, currentDivision);
        }
      } catch {
        const warning = this.querySelector(".shipping-warning");
        if (warning) warning.style.display = "block";
      }
    }

    async _applyShippingConfig(config, division) {
      const bdRates    = config.BD ?? {};
      const weightRates = {};
      const namedRates  = {};

      for (const [key, price] of Object.entries(bdRates)) {
        if (!isNaN(Number(key))) {
          weightRates[Number(key)] = price;
        } else {
          namedRates[key] = price;
        }
      }

      this.weightRates = weightRates;

      const divisionRate = this._getDivisionRate(namedRates, division);
      const result       = await this._calculateShipping(weightRates, divisionRate);

      this._renderShippingResult({ ...result, division });
      this._refreshUI();
    }

    async _calculateShipping(weightRates, divisionRate) {
      // Fetch fresh cart here — shipping cost depends on current cart contents
      const cartItems = await this._getCartItems();

      let weightTotal         = 0;
      let hasWeightProduct    = false;
      let hasNonWeightProduct = false;

      for (const item of cartItems.items) {
        const itemWeightKg = item.grams / 1000;
        const rate         = weightRates[itemWeightKg];
        console.log(rate);

        if (rate) {
          hasWeightProduct = true;
          weightTotal += rate * item.quantity;
        } else {
          hasNonWeightProduct = true;
        }
      }

      let total = 0;
      if (hasWeightProduct)    total += weightTotal;
      if (hasNonWeightProduct) total += divisionRate;

      return { weightTotal, divisionRate, hasWeightProduct, hasNonWeightProduct, total };
    }

    _getDivisionRate(namedRates, division) {
      if (!division) return 0;
      return division.toLowerCase() === "dhaka"
        ? namedRates["Inside Dhaka"]  ?? 0
        : namedRates["Outside Dhaka"] ?? 0;
    }

    async _getCartItems() {
      try {
        const res  = await fetch("/cart.js");
        const cart = await res.json();
        return cart ?? [];
      } catch {
        console.error("[CheckoutBkashForm] Failed to fetch cart");
        return [];
      }
    }

    _renderShippingResult({ total, division }) {
      const shippingContainer = this.$("checkout-form_shipping-section");
      const container         = this.$("checkout-form_shipping-rates");
      const warning           = shippingContainer?.querySelector(".shipping-warning");

      if (!division) {
        if (warning)   warning.style.display = "block";
        if (container) container.innerHTML   = "";
        return;
      }

      if (warning) warning.style.display = "none";

      this.selectedRate = { price: total, title: `${division}-delivery` };

      container.innerHTML = `
        <label class="checkout-form_shipping-option" data-type="full">
          <input
            class="checkout-form_shipping-option__input"
            type="radio"
            name="shippingMethod"
            value="${total}"
            data-label="${division}-delivery"
            checked
          >
          <span class="checkout-form_shipping-option__card">
            <span class="checkout-form_shipping-option__radio-dot"></span>
            <span class="checkout-form_shipping-option__text">
              <span class="checkout-form_shipping-option__title">Total Shipping</span>
              <span class="checkout-form_shipping-option__amount" data-amount>৳${total}</span>
            </span>
          </span>
        </label>
      `;

      const radio = container.querySelector('input[name="shippingMethod"]');
      if (radio) {
        radio.addEventListener("change", () => {
          this.selectedRate = {
            price: parseFloat(radio.value),
            title: radio.dataset.label,
          };
        });
      }

      this.$("payWithBkash").disabled = false;
    }

    // ─── Cart MutationObserver ────────────────────────────────────────────────

    _setupCartObserver() {
      const selectors = [
        "#main-cart-items",
        "#main-cart-footer",
        ".cart__items",
        "[data-cart-items]",
        "cart-items",
      ];

      const targets = selectors
        .map(sel => document.querySelector(sel))
        .filter(Boolean);

      if (targets.length === 0) return;

      this._cartObserver = new MutationObserver(() => {
        clearTimeout(this._cartSyncTimer);
        this._cartSyncTimer = setTimeout(() => this._syncCartFromTheme(), 300);
      });

      targets.forEach(target => {
        this._cartObserver.observe(target, { childList: true, subtree: true });
      });
    }

    async _syncCartFromTheme() {
      this._loadCart();
      this.cachedShippingDetails = this._getCookie("nova_sc");

      const divisionSelect  = this.querySelector("#division");
      const currentDivision = divisionSelect?.value;

      if (this.cachedShippingDetails && currentDivision) {
        this._applyShippingConfig(JSON.parse(this.cachedShippingDetails), currentDivision);
      }
    }

    // ─── Summary ──────────────────────────────────────────────────────────────

    _updateSummary() {
      const subtotalMobileEl  = this.$("subtotal-mobile");
      const subtotalDesktopEl = this.$("subtotal");
      const totalMobileEl     = this.$("total-mobile");
      const totalDesktopEl    = this.$("total");
      const shippingMobileEl  = this.$("shippingCost-mobile");
      const shippingDesktopEl = this.$("shippingCost");

      const subtotal = this.cartData ? this.cartData.original_total_price / 100 : 0;
      const shipping = this.selectedRate?.price ?? 0;
      const discount = this.cartData ? this.cartData.total_discount / 100 : 0;
      const total    = Math.max(0, subtotal + shipping - discount);

      subtotalMobileEl.textContent  = `৳${subtotal.toFixed(2)}`;
      subtotalDesktopEl.textContent = `৳${subtotal.toFixed(2)}`;
      shippingMobileEl.textContent  = shipping > 0 ? `৳${shipping.toFixed(2)}` : "৳0.00";
      shippingDesktopEl.textContent = shipping > 0 ? `৳${shipping.toFixed(2)}` : "৳0.00";
      totalMobileEl.textContent     = `৳${total.toFixed(2)}`;
      totalDesktopEl.textContent    = `৳${total.toFixed(2)}`;

      ["discountRow", "discountRow-mobile"].forEach(id => {
        const discountRow = this.$(id);
        if (!discountRow) return;
        if (discount > 0) {
          discountRow.classList.remove("hidden");
          discountRow.querySelector(".cart__discount-value span").textContent = `-৳${discount.toFixed(2)}`;
        } else {
          discountRow.classList.add("hidden");
        }
      });

      this.discountElement.renderDiscountCodeElement(this.cartData?.discount_codes ?? []);
    }

    // Called by CartDiscountComponent after apply / remove.
    // Receives the fresh cart data from the discount response so we don't
    // need an extra /cart.js fetch — the data is already authoritative.
    _syncFormSummaryAfterDiscount(cartData) {
      this.cartData = {
        ...this.cartData,
        total_price:          cartData.total_price,
        original_total_price: cartData.original_total_price,
        total_discount:       cartData.total_discount,
        cart_level_discount_applications: cartData.cart_level_discount_applications ?? [],
        items:                cartData.items ?? this.cartData?.items,
        discount_codes:       cartData.discount_codes ?? [],
      };
      this._refreshUI();
    }

    // ─── UI Helpers ───────────────────────────────────────────────────────────

    _showBanner(msg, type) {
      const el = this.$("checkout-form_banner");
      if (!el) return;
      const colors = {
        error:   { bg: "#fff4f4", border: "#fda29b", text: "#912018" },
        warning: { bg: "#fffaeb", border: "#fec84b", text: "#92400e" },
        success: { bg: "#f0fdf4", border: "#6ce9a6", text: "#065f46" },
        info:    { bg: "#eff8ff", border: "#b2ddff", text: "#175cd3" },
      };
      const c = colors[type] ?? colors.info;
      el.style.cssText = `display:block;background:${c.bg};border:1px solid ${c.border};color:${c.text}`;
      el.textContent   = msg;
    }
  }

  if (!customElements.get("checkout-bkash-form")) {
    customElements.define("checkout-bkash-form", CheckoutBkashForm);
  }

  // ─── Discount Component ───────────────────────────────────────────────────

  class CartDiscountComponent extends HTMLElement {
    connectedCallback() {
      this.cartDiscountError  = this.querySelector('[ref="cartDiscountError"]');
      this.activeFetch        = null;
      this.$                  = (id) => document.getElementById(id);
      // Queried here (connectedCallback) so the DOM is guaranteed to be ready
      this.CheckoutBkashForm  = document.querySelector("checkout-bkash-form");

      this.applyDiscount  = this.applyDiscount.bind(this);
      this.removeDiscount = this.removeDiscount.bind(this);

      const applyBtn = this.querySelector('[on\\:click="/applyDiscount"]');
      if (applyBtn) applyBtn.addEventListener("click", this.applyDiscount);

      this.querySelectorAll('[on\\:click="/removeDiscount"]').forEach(btn => {
        btn.addEventListener("click", this.removeDiscount);
      });
    }

    disconnectedCallback() {
      const applyBtn = this.querySelector('[on\\:click="/applyDiscount"]');
      if (applyBtn) applyBtn.removeEventListener("click", this.applyDiscount);

      this.querySelectorAll('[on\\:click="/removeDiscount"]').forEach(btn => {
        btn.removeEventListener("click", this.removeDiscount);
      });
    }

    createAbortController() {
      if (this.activeFetch) this.activeFetch.abort();
      const controller = new AbortController();
      this.activeFetch = controller;
      return controller;
    }

    existingDiscounts() {
      return Array.from(this.querySelectorAll(".cart-discount__pill"))
        .map(pill => pill.dataset.discountCode)
        .filter(Boolean);
    }

    showAllSpinners() {
      document.querySelectorAll(".order-summary .loading__spinner").forEach(s => s.classList.remove("hidden"));
    }

    hideAllSpinners() {
      document.querySelectorAll(".order-summary .loading__spinner").forEach(s => s.classList.add("hidden"));
    }

    getSectionsToRender() {
      const mql = window.matchMedia("(max-width: 989px)");
      return [
        {
          id: "main-cart-items",
          section: document.getElementById("main-cart-items").dataset.id,
          selector: ".js-contents",
        },
        {
          id: "cart-icon-bubble",
          section: "cart-icon-bubble",
          selector: ".shopify-section",
        },
        {
          id: "cart-live-region-text",
          section: "cart-live-region-text",
          selector: ".shopify-section",
        },
        {
          id: "main-cart-footer",
          section: document.getElementById("main-cart-footer")?.dataset.id,
          selector: mql.matches
            ? ".order-summary.large-up-hide"
            : ".order-summary.small-hide.medium-hide",
        },
      ];
    }

    async applyDiscount(event) {
      event.preventDefault();
      event.stopPropagation();

      const input     = this.querySelector('input[name="discount"]');
      const sectionId = this.dataset.sectionId;
      const code      = input?.value?.trim();

      if (!input || !sectionId || !code) {
        this.handleDiscountError({});
        this.querySelector(".cart-discount__error-text").innerHTML = "Discount Code Required";
        return;
      }

      this.showAllSpinners();

      const existing = this.existingDiscounts();
      if (existing.includes(code)) return;

      existing.push(code);
      const sections         = this.getSectionsToRender();
      const abortController  = this.createAbortController();

      try {
        const response = await fetch(window.routes.cart_update_url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            discount: existing.join(","),
            sections: sections.map(s => s.section),
          }),
          signal: abortController.signal,
        });

        const data = await response.json();

        const failed = data.discount_codes.find(d => d.code === code && d.applicable === false);
        if (failed) {
          this.handleDiscountError(failed);
          return;
        }

        sections.forEach(({ id, section, selector }) => {
          const html = data.sections?.[section];
          if (html) this.morphSection(id, html, selector);
        });
        this.renderDiscountCodeElement(data.discount_codes);

        // Pass the fresh cart payload — no extra /cart.js fetch needed
        this.CheckoutBkashForm._syncFormSummaryAfterDiscount(data);
      } catch (e) {
        // Handle error
      } finally {
        this.activeFetch = null;
        this.hideAllSpinners();
      }
    }

    async removeDiscount(event) {
      event.preventDefault();
      event.stopPropagation();
      this.showAllSpinners();

      const button    = event.target.closest("button");
      const sectionId = this.dataset.sectionId;
      const pill      = button?.closest(".cart-discount__pill");
      const code      = pill?.dataset.discountCode;

      if (!button || !pill || !code || !sectionId) return;

      const existing = this.existingDiscounts();
      const index    = existing.indexOf(code);
      if (index === -1) return;

      existing.splice(index, 1);
      const sections        = this.getSectionsToRender();
      const abortController = this.createAbortController();

      try {
        const response = await fetch(window.routes.cart_update_url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            discount: existing.join(","),
            sections: sections.map(s => s.section),
          }),
          signal: abortController.signal,
        });

        const data = await response.json();

        sections.forEach(({ id, section, selector }) => {
          const html = data.sections?.[section];
          if (html) this.morphSection(id, html, selector);
        });
        this.renderDiscountCodeElement(data.discount_codes);

        // Pass the fresh cart payload — no extra /cart.js fetch needed
        this.CheckoutBkashForm._syncFormSummaryAfterDiscount(data);
      } catch (e) {
        // Handle fetch error
      } finally {
        this.activeFetch = null;
        this.hideAllSpinners();
      }
    }

    handleDiscountError(discountCode) {
      if (this.cartDiscountError) {
        this.cartDiscountError.classList.remove("hidden");
        this.cartDiscountError.querySelector(".failed-discount-code").innerHTML = discountCode?.code;
      }
    }

    morphSection(id, html, selector) {
      const dom        = new DOMParser().parseFromString(html, "text/html");
      const newContent = dom.querySelector(selector);
      const target     = document.querySelector(`#${id} ${selector}`);
      if (newContent && target) target.innerHTML = newContent.innerHTML;
    }

    renderDiscountCodeElement(codes) {
      const ul = this.querySelector("ul.cart-discount__codes");
      if (!ul) return;
      ul.innerHTML = "";
      if (!codes?.length) return;

      codes.forEach(code => {
        const li = document.createElement("li");
        li.className          = "cart-discount__pill";
        li.dataset.discountCode = code.code;
        li.setAttribute("aria-label", `Discount applied: ${code.code}`);

        li.innerHTML = `
          <p class="cart-discount__pill-code">${code.code}</p>
          <button
            type="button"
            on:click="/removeDiscount"
            class="cart-discount__pill-remove svg-wrapper svg-wrapper--smaller button-unstyled"
            aria-label="Remove discount: ${code.code}"
          >
            <svg width="7" height="8" viewBox="0 0 7 8" fill="none" xmlns="http://www.w3.org/2000/svg">
              <g opacity="1">
                <path d="M6 1.5L1 6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <path d="M1 1.5L6 6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </g>
            </svg>
          </button>
        `;

        ul.appendChild(li);
        this.$("discount-details").open = true;
      });

      // Bind only to newly created buttons inside the freshly rendered list
      ul.querySelectorAll('[on\\:click="/removeDiscount"]').forEach(btn => {
        btn.addEventListener("click", this.removeDiscount);
      });
    }
  }

  if (!customElements.get("cart-discount-component")) {
    customElements.define("cart-discount-component", CartDiscountComponent);
  }

  // ─── Payment Options Component ────────────────────────────────────────────

  class CheckoutFormPaymentOptions extends HTMLElement {

    connectedCallback() {
      this.currencySymbol    = this.dataset.currency || "৳";
      this.CheckoutBkashForm = document.querySelector("checkout-bkash-form");

      this._bindEvents();
      this._renderPaymentAmounts();
    }

    _bindEvents() {
      this.addEventListener("change", (e) => {
        if (!e.target.matches(".checkout-form_payment-option__input")) return;
        this._syncHiddenFields(e.target);
      });
    }

    // Reads amounts from the authoritative in-memory state on CheckoutBkashForm
    // rather than parsing DOM text — avoids currency-symbol brittle splits.
    _getAmountForInput(input) {
      const form = this.CheckoutBkashForm;

      if (input.value === "pay_delivery") {
        return form?.selectedRate?.price ?? 0;
      }

      const subtotal = form?.cartData ? form.cartData.original_total_price / 100 : 0;
      const shipping = form?.selectedRate?.price ?? 0;
      const discount = form?.cartData ? form.cartData.total_discount / 100 : 0;
      const total    = Math.max(0, subtotal + shipping - discount);
      const multiplier = parseFloat(input.dataset.multiplier ?? 0);
      return total * multiplier;
    }

    _formatAmount(amount) {
      return `${this.currencySymbol}${Math.round(amount)}`;
    }

    _renderPaymentAmounts() {
      this.querySelectorAll(".checkout-form_payment-option__input").forEach((input) => {
        const amountEl = input
          .closest(".checkout-form_payment-option")
          ?.querySelector("[data-amount]");

        if (!amountEl) return;

        const amount = this._getAmountForInput(input);
        amountEl.textContent = this._formatAmount(amount);

        if (input.checked) this._syncHiddenFields(input);
      });
    }

    _syncHiddenFields(input) {
      const amount   = this._getAmountForInput(input);
      const planEl   = document.getElementById("checkout-form_selected-plan");
      const amountEl = document.getElementById("checkout-form_selected-amount");
      if (planEl)   planEl.value   = input.value;
      if (amountEl) amountEl.value = amount.toFixed(2);
    }
  }

  if (!customElements.get("checkout-form-payment-options")) {
    customElements.define("checkout-form-payment-options", CheckoutFormPaymentOptions);
  }
})();