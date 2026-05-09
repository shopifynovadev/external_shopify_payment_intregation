(() => {
  const el = document.getElementById("nova-thankyou-block");
  if (!el) return;

  const appUrl = el.dataset.appUrl;
  const params = new URLSearchParams(window.location.search);
  const paymentId = params.get("payment_id") || sessionStorage.getItem("nova_payment_id");

  const show = (id) => {
    ["nova-ty-loading", "nova-ty-success", "nova-ty-failed", "nova-ty-timeout"].forEach((s) => {
      document.getElementById(s).style.display = s === id ? "block" : "none";
    });
  };

  if (!paymentId) {
    show("nova-ty-failed");
    document.getElementById("nova-ty-error-msg").textContent = "Payment reference not found.";
    return;
  }

  sessionStorage.removeItem("nova_payment_id");

  let attempts = 0;
  const MAX_ATTEMPTS = 36; // 3 minutes at 5s intervals

  async function poll() {
    attempts++;
    try {
      const res = await fetch(`${appUrl}/api/payment/status/${paymentId}`);
      const json = await res.json();
      if (!json.success) { scheduleNext(); return; }

      const { status, shopifyOrderNumber, bkashTransactionId, errorMessage } = json.data;

      if (status === "COMPLETED") {
        document.getElementById("nova-order-number").textContent = shopifyOrderNumber ?? "—";
        document.getElementById("nova-trx-id").textContent = bkashTransactionId ?? "—";
        show("nova-ty-success");
      } else if (status === "FAILED" || status === "ABANDONED") {
        show("nova-ty-failed");
        document.getElementById("nova-ty-error-msg").textContent =
          errorMessage ?? "Payment could not be completed. If bKash deducted an amount, it will be refunded.";
      } else if (attempts >= MAX_ATTEMPTS) {
        show("nova-ty-timeout");
      } else {
        scheduleNext();
      }
    } catch {
      if (attempts < MAX_ATTEMPTS) scheduleNext();
      else show("nova-ty-timeout");
    }
  }

  function scheduleNext() {
    setTimeout(poll, 5000);
  }

  poll();
})();
