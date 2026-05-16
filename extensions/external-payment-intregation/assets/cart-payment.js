(() => {
  class CheckoutBkashForm extends HTMLElement {

    // ─── Web Component Lifecycle ──────────────────────────────────────────────

    connectedCallback() {
      this.appUrl        = this.dataset.appUrl;
      this.shopDomain = this.dataset.shop;
      
      // Shorthand DOM helper
      this.$ = (id) => document.getElementById(id);

      // Cart & shipping state
      this.cartData             = null;
      this.selectedRate         = null;
      this.weightRates          = {};
      this.cachedShippingDetails = null;
      this.selectedDivision     = null;

      // Discount state (kept for legacy applyDiscount() path)
      this.discountCode    = null;
      this.discountAmount  = 0;
      this.discountApplied = false;
      this.discountElement = this.querySelector("cart-discount-component");

      // Internal timers / observers
      this._cartSyncTimer  = null;
      this._cartObserver   = null;

      // Expose instance globally so window.updateShippingValues and
      // cart-discount.js can read selectedRate
      window.CheckoutBkashForm = this;

      // Attach all window-level helpers that cart-discount.js depends on
      this._defineWindowHelpers();

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
      // Division select — triggers shipping rate calculation
      const divisionSelect = this.$("division");
      if (!divisionSelect) {
        console.warn("[CheckoutBkashForm] #division not found");
        return;
      }
      divisionSelect.addEventListener("change", (e) => {
        this.selectedDivision = e.target.value;
        this._onDivisionChange();
      });

      // Form submit
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
          // Show error text
          const errorText = errorMessage
            ? decodeURI(errorMessage)
            : window.cartError?.[error] ?? "Something went wrong. Please try again.";
          this._showBanner(errorText, "error");

          // Restore form fields
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

            // Restore shipping radio — match by value == saved rate
            if (data.shipping_method?.rate != null) {
              const shippingInput = document.querySelector(
                `input[name="shippingMethod"][value="${data.shipping_method.rate}"]`
              );
              if (shippingInput) {
                shippingInput.checked = true;
                this._updateShippingValues();
              }
            }

            // Restore payment plan radio — match by value == pay_type
            if (data.payment_details?.need_to_pay) {
              const paymentInput = document.querySelector(
                `input[name="nova_payment_plan"][value="${data.payment_details.need_to_pay}"]`
              );
              if (paymentInput) paymentInput.checked = true;
            }
          }
        } else {
          // Invalid token — clean URL
          const newUrl = window.location.pathname;
          window.history.replaceState({}, document.title, newUrl);
        }
      }

      if (spinner) {
        spinner.classList.add("hidden");
      }
    }

    // ─── Window Helpers (called by cart-discount.js) ──────────────────────────

    _defineWindowHelpers() {
      // Called by: shipping radio change, showCartErrorFromURL, cart-discount.js
      window.updateShippingValues = () => {
        const namedRate   = this.selectedRate?.price ?? 0;
        const shippingRate = namedRate;

        const subtotalCents = parseInt(
          this.$("subtotal")?.dataset?.subTotal ??
          this.$("subtotal-mobile")?.dataset?.subTotal ?? 0,
          10
        );
        const discountCents = parseInt(
          document.querySelector("[data-discount]")?.dataset?.discount ?? 0,
          10
        );

        const subtotalMoney = (subtotalCents / 100).toFixed(2);
        const shippingMoney = shippingRate.toFixed(2);
        const totalMoney    = Math.max(
          0,
          (subtotalCents / 100) + shippingRate - (discountCents / 100)
        ).toFixed(2);

        // Update both desktop and mobile summary spans
        const updates = {
          "subtotal":            subtotalMoney,
          "subtotal-mobile":     subtotalMoney,
          "shippingCost":        shippingMoney,
          "shippingCost-mobile": shippingMoney,
          "total":               totalMoney,
          "total-mobile":        totalMoney,
        };
        Object.entries(updates).forEach(([id, value]) => {
          const el = this.$(id);
          if (el) el.textContent = value;
        });

        // Also push updated shipping into payment options widget
        if (typeof window.novaPaymentOptions?.setShipping === "function") {
          window.novaPaymentOptions.setShipping(shippingRate);
        }
      };

      // Called by: cart-discount.js after apply / remove
      window.syncFormSummaryAfterDiscount = async () => {
        try {
          const cart = await fetch("/cart.js").then(r => r.json());

          const subtotalCents = cart.original_total_price;
          const discountCents = cart.total_discount;

          // Update subtotal data attributes + text (both layouts)
          ["subtotal", "subtotal-mobile"].forEach(id => {
            const el = this.$(id);
            if (!el) return;
            el.dataset.subTotal = subtotalCents;
            el.textContent = (subtotalCents / 100).toFixed(2);
          });

          // Update discount row visibility + value (both layouts)
          ["discountRow", "discountRow-mobile"].forEach(id => {
            const row = this.$(id);
            if (!row) return;
            if (discountCents > 0) {
              row.classList.remove("hidden");
              const valueEl = row.querySelector("[data-discount]");
              if (valueEl) {
                valueEl.dataset.discount = discountCents;
                valueEl.textContent = `-${(discountCents / 100).toFixed(2)}`;
              }
            } else {
              row.classList.add("hidden");
            }
          });

          // Recalculate total with current shipping then update all spans
          window.updateShippingValues();

          // Also update payment options widget with fresh cart total
          if (typeof window.novaPaymentOptions?.setCartTotal === "function") {
            window.novaPaymentOptions.setCartTotal(cart.total_price);
          }
        } catch (err) {
          console.error("[CheckoutBkashForm] syncFormSummaryAfterDiscount failed:", err);
        }
      };
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
      this._updateSummary();
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

      // Always get the most recent cart state
      const cart = await fetch("/cart.js").then(res => res.json());

      // Get selected shipping radio
      const selectedShippingInput = document.querySelector('input[name="shippingMethod"]:checked');
      const namedRatePrice        = parseFloat(selectedShippingInput?.value);
      const namedRateTitle        = selectedShippingInput?.dataset?.label;

      const order_details = {
        cart_details: cart,
        shipping_details: {
          email:    formData.get("email"),
          phone:    formData.get("phone"),
          first_name: formData.get("firstName"),
          last_name:  formData.get("lastName"),
          address:  formData.get("address"),
          city:     formData.get("city"),
          zip:      formData.get("zip"),
          division: formData.get("division"),
          country:  formData.get("country"),
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

      // Store in localStorage keyed by cart token for error-return restore
      if (cart.token) {
        localStorage.setItem(
          `cart-${cart.token.split("?key=")[1]}`,
          JSON.stringify(order_details.shipping_details)
        );
      }

      console.log(order_details);

      try {
        const res = await fetch(`${this.appUrl}/api/bkash/payment/create`, {
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

      // window.updateShippingValues();
      this._updateSummary();
    }

    async _calculateShipping(weightRates, divisionRate) {
      const cartItems = await this._getCartItems();

      let weightTotal        = 0;
      let hasWeightProduct   = false;
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

      // Weighted only → weight rates only
      // Non-weighted only → division rate only
      // Both → weight rates + division rate
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
        if (warning)  warning.style.display = "block";
        if (container) container.innerHTML  = "";
        return;
      }

      if (warning) warning.style.display = "none";

      // Store as the selected named rate so updateShippingValues can read it
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

      // Bind change event on newly rendered radio
      const radio = container.querySelector('input[name="shippingMethod"]');
      if (radio) {
        radio.addEventListener("change", () => {
          this.selectedRate = {
            price: parseFloat(radio.value),
            title: radio.dataset.label,
          };
          window.updateShippingValues();
        });
      }

      this.$("payWithBkash").disabled = false;
    }

    // ─── Cart MutationObserver ────────────────────────────────────────────────

    _setupCartObserver() {
      // Unified selector list from both original scripts
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
      try {
        const cart = await fetch("/cart.js").then(r => r.json());

        // Update cartData
        this.cartData = cart;

        if (cart.item_count === 0) {
          this._showBanner("Your cart is empty.", "info");
          const btn = this.$("payWithBkash");
          if (btn) btn.disabled = true;
        }

        // Update subtotal data attributes so updateShippingValues reads fresh values
        document.querySelectorAll('[id^="subtotal"]').forEach(el => {
          el.dataset.subTotal = cart.original_total_price;
          el.textContent = (cart.original_total_price / 100).toFixed(2);
        });

        document.querySelectorAll("[data-discount]").forEach(el => {
          el.dataset.discount = cart.total_discount;
          if (cart.total_discount > 0) {
            el.textContent = `-${(cart.total_discount / 100).toFixed(2)}`;
          }
        });

        // Recalculate shipping with updated cart then refresh summary
        if (this.cachedShippingDetails && this.selectedDivision) {
          await this._applyShippingConfig(
            JSON.parse(this.cachedShippingDetails),
            this.selectedDivision
          );
        } else {
          window.updateShippingValues();
        }
      } catch {
        // Silent fail — values stay as last known state
      }
    }

    // ─── Discount Event Listener (legacy path) ────────────────────────────────

    _listenForDiscountEvents() {
      document.addEventListener("discount:update", (e) => {
        const data = e.detail?.data;
        if (!data) return;

        this.cartData = {
          ...this.cartData,
          total_price:          data.total_price,
          original_total_price: data.original_total_price,
          total_discount:       data.total_discount,
          cart_level_discount_applications: data.cart_level_discount_applications ?? [],
          items: data.items ?? this.cartData?.items,
        };

        this.discountAmount = (data.total_discount ?? 0) / 100;
        this._updateSummary();
      });
    }

    // ─── Summary ──────────────────────────────────────────────────────────────

    _updateSummary() {
      const subtotalMobileEl = this.$("subtotal-mobile");
      const subtotalDesktopEl = this.$("subtotal");
      const totalMobileEl = this.$("total-mobile");
      const totalDesktopEl = this.$("total");
      const shippingMobileEl = this.$("shippingCost-mobile");
      const shippingDesktopEl = this.$("shippingCost");

      const subtotal = this.cartData ? this.cartData.original_total_price / 100 : 0;
      const shipping = (this.selectedRate?.price ?? 0);
      const discount = this.cartData ? this.cartData.total_discount / 100 : 0;
      const total    = Math.max(0, subtotal + shipping - discount);

      subtotalMobileEl.textContent = `৳${subtotal.toFixed(2)}`;
      subtotalDesktopEl.textContent = `৳${subtotal.toFixed(2)}`;
      shippingMobileEl.textContent = shipping > 0 ? `৳${shipping.toFixed(2)}` : "—";
      shippingDesktopEl.textContent = shipping > 0 ? `৳${shipping.toFixed(2)}` : "—";
      totalMobileEl.textContent = `৳${total.toFixed(2)}`;
      totalDesktopEl.textContent = `৳${total.toFixed(2)}`;

      ["discountRow", "discountRow-mobile"].forEach(id => {
        const discountRow = this.$(id);
        console.log(discount);
        if (discountRow && discount > 0) {
          discountRow.classList.remove("hidden");
          discountRow.querySelector(".cart__discount-value span").textContent = `-৳${discount.toFixed(2)}`;
        }
      });

      this.discountElement.renderDiscountCodeElement(this.cartData.discount_codes);
    }

    // ─── Return from bKash ────────────────────────────────────────────────────

    _checkReturnFromBkash() {
      const params    = new URLSearchParams(window.location.search);
      const paymentId = params.get("payment_id");
      const status    = params.get("payment_status");

      if (paymentId && status === "failed") {
        this._showBanner("Payment was not completed. Please try again.", "error");
        const clean = new URL(window.location.href);
        clean.searchParams.delete("payment_id");
        clean.searchParams.delete("payment_status");
        window.history.replaceState({}, "", clean.toString());
      }
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
})();

// Discount Function
class CartDiscountComponent extends HTMLElement {
  constructor() {
    super();
    this.cartDiscountError = null;
    this.activeFetch = null;
    this.$ = (id) => document.getElementById(id);

    this.applyDiscount = this.applyDiscount.bind(this);
    this.removeDiscount = this.removeDiscount.bind(this);
  }

  connectedCallback() {
    this.cartDiscountError = this.querySelector('[ref="cartDiscountError"]');

    const applyBtn = this.querySelector('[on\\:click="/applyDiscount"]');
    if (applyBtn) {
      applyBtn.addEventListener('click', this.applyDiscount);
    }

    this.querySelectorAll('[on\\:click="/removeDiscount"]').forEach(btn => {
      btn.addEventListener('click', this.removeDiscount);
    });
  }

  disconnectedCallback() {
    const applyBtn = this.querySelector('[on\\:click="/applyDiscount"]');
    if (applyBtn) {
      applyBtn.removeEventListener('click', this.applyDiscount);
    }

    this.querySelectorAll('[on\\:click="/removeDiscount"]').forEach(btn => {
      btn.removeEventListener('click', this.removeDiscount);
    });
  }

  createAbortController() {
    if (this.activeFetch) {
      this.activeFetch.abort();
    }
    const controller = new AbortController();
    this.activeFetch = controller;
    return controller;
  }

  existingDiscounts() {
    return Array.from(this.querySelectorAll('.cart-discount__pill'))
      .map(pill => pill.dataset.discountCode)
      .filter(Boolean);
  }

  showAllSpinners() {
    document.querySelectorAll('.order-summary .loading__spinner').forEach(spinner => {
      spinner.classList.remove('hidden');
    });
  }

  hideAllSpinners() {
    document.querySelectorAll('.order-summary .loading__spinner').forEach(spinner => {
      spinner.classList.add('hidden');
    });
  }

  getSectionsToRender() {
    const mql = window.matchMedia('(max-width: 989px)');
    return [
      {
        id: 'main-cart-items',
        section: document.getElementById('main-cart-items').dataset.id,
        selector: '.js-contents',
      },
      {
        id: 'cart-icon-bubble',
        section: 'cart-icon-bubble',
        selector: '.shopify-section',
      },
      {
        id: 'cart-live-region-text',
        section: 'cart-live-region-text',
        selector: '.shopify-section',
      },
      {
        id: 'main-cart-footer',
        section: document.getElementById('main-cart-footer')?.dataset.id,
        selector: mql.matches ? '.order-summary.large-up-hide' : '.order-summary.small-hide.medium-hide',
      }
    ];
  }

  async applyDiscount(event) {
    event.preventDefault();
    event.stopPropagation();

    const input = this.querySelector('input[name="discount"]');
    const sectionId = this.dataset.sectionId;
    const code = input?.value?.trim();

    if (!input || !sectionId || !code) {
      this.handleDiscountError({});
      this.querySelector(".cart-discount__error-text").innerHTML = 'Discount Code Required';
      return;
    }

    this.showAllSpinners();

    const existing = this.existingDiscounts();
    if (existing.includes(code)) return;

    existing.push(code);
    const sections = this.getSectionsToRender();
    const abortController = this.createAbortController();

    try {
      const response = await fetch(window.routes.cart_update_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          discount: existing.join(','),
          sections: sections.map(s => s.section),
        }),
        signal: abortController.signal,
      });

      const data = await response.json();

      const failed = data.discount_codes.find(
        d => d.code === code && d.applicable === false
      );
      if (failed) {
        this.handleDiscountError(failed);
        return;
      }

      document.dispatchEvent(
        new CustomEvent('discount:update', {
          detail: { data, origin: this.id },
        })
      );

      sections.forEach(({ id, section, selector }) => {
        const html = data.sections?.[section];
        if (html) this.morphSection(id, html, selector);
      });
      this.renderDiscountCodeElement(data.discount_codes);
      window.updateShippingValues();
      window.syncFormSummaryAfterDiscount();
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

    const button = event.target.closest('button');
    const sectionId = this.dataset.sectionId;
    const pill = button?.closest('.cart-discount__pill');
    const code = pill?.dataset.discountCode;

    if (!button || !pill || !code || !sectionId) return;

    const existing = this.existingDiscounts();
    const index = existing.indexOf(code);
    if (index === -1) return;

    existing.splice(index, 1);
    const sections = this.getSectionsToRender();
    const abortController = this.createAbortController();

    try {
      const response = await fetch(window.routes.cart_update_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          discount: existing.join(','),
          sections: sections.map(s => s.section),
        }),
        signal: abortController.signal,
      });

      const data = await response.json();

      document.dispatchEvent(
        new CustomEvent('discount:update', {
          detail: { data, origin: this.id },
        })
      );

      sections.forEach(({ id, section, selector }) => {
        const html = data.sections?.[section];
        if (html) this.morphSection(id, html, selector);
      });
      this.renderDiscountCodeElement(data.discount_codes);
      window.updateShippingValues();
      window.syncFormSummaryAfterDiscount();
    } catch (e) {
      // Handle fetch error
    } finally {
      this.activeFetch = null;
      this.hideAllSpinners();
    }
  }

  handleDiscountError(discountCode) {
    if (this.cartDiscountError) {
      this.cartDiscountError.classList.remove('hidden');
      this.cartDiscountError.querySelector(".failed-discount-code").innerHTML = discountCode?.code;
    }
  }

  morphSection(id, html, selector) {
    const dom = new DOMParser().parseFromString(html, 'text/html');
    const newContent = dom.querySelector(selector);
    const target = document.querySelector(`#${id} ${selector}`);
    if (newContent && target) {
      target.innerHTML = newContent.innerHTML;
    }
  }

  renderDiscountCodeElement(codes) {
    const ul = this.querySelector('ul.cart-discount__codes');
    if (!ul) return;
    ul.innerHTML = "";
    if (codes.length < 1) return;

    codes.forEach(code => {
      const li = document.createElement('li');
      li.className = 'cart-discount__pill';
      li.dataset.discountCode = code;
      li.setAttribute('aria-label', `Discount applied: ${code.code}`);

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

    this.querySelectorAll('[on\\:click="/removeDiscount"]').forEach(btn => {
      btn.addEventListener('click', this.removeDiscount);
    });
  }
}

if (!customElements.get('cart-discount-component')) {
  customElements.define('cart-discount-component', CartDiscountComponent);
}