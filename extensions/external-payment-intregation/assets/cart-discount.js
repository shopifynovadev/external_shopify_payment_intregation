class CartDiscountComponent extends HTMLElement {
  constructor() {
    super();
    this.cartDiscountError = null;
    this.activeFetch = null;

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
      },
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
      window.updateShippingValues();
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
      window.updateShippingValues();
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
}

if (!customElements.get('cart-discount-component')) {
  customElements.define('cart-discount-component', CartDiscountComponent);
}