// Coordinates the customer booking form and its API requests.
class ReservationPage {
  constructor(documentRoot = document) {
    this.document = documentRoot;
    this.form = this.document.getElementById("bookingForm");
    if (!this.form) return;

    this.menu = this.document.getElementById("menu");
    this.date = this.document.getElementById("bookingDate");
    this.time = this.document.getElementById("bookingTime");
    this.slotList = this.document.getElementById("slotList");
    this.slotMessage = this.document.getElementById("slotMessage");
    this.notice = this.document.getElementById("bookingNotice");
    this.submitButton = this.document.getElementById("bookingSubmit");
    this.idempotencyKey = this.createRequestKey();
  }

  start() {
    if (!this.form) return;
    this.populateMenuOptions();
    this.submitButton.textContent = appJa.text("booking.submit");
    this.menu.addEventListener("change", () => this.loadSlots());
    this.date.addEventListener("change", () => this.loadSlots());
    this.form.addEventListener("submit", (event) => this.submit(event));
    this.loadConfig();
  }

  populateMenuOptions() {
    const labels = {
      first: `${appJa.strings.menus.first}　${appJa.strings.prices.first}`,
      acupuncture: `${appJa.strings.menus.acupuncture}　${appJa.strings.prices.acupuncture}`,
      acupuncture_moxa: `${appJa.strings.menus.acupunctureMoxa}　${appJa.strings.prices.acupunctureMoxa}`,
      meridian: `${appJa.strings.menus.meridian}　${appJa.strings.prices.meridian}`
    };
    Array.from(this.menu.options).forEach((option) => {
      if (labels[option.value]) option.textContent = labels[option.value];
    });
  }

  createRequestKey() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  showNotice(message, kind) {
    this.notice.hidden = false;
    this.notice.className = `booking-notice is-${kind}`;
    this.notice.textContent = message;
  }

  async readJson(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || appJa.text("booking.communicationError"));
    return data;
  }

  async loadConfig() {
    try {
      const response = await fetch("/api/config", { headers: { Accept: "application/json" } });
      const config = await this.readJson(response);
      this.date.min = config.minDate;
      this.date.max = config.maxDate;
      this.document.getElementById("dateHelp").textContent = appJa.text("booking.dateHelp", { daysAhead: config.daysAhead });
    } catch (error) {
      this.showNotice(error.message, "error");
    }
  }

  async loadSlots() {
    this.time.value = "";
    this.slotList.replaceChildren();
    if (!this.menu.value || !this.date.value) {
      this.slotMessage.textContent = appJa.text("booking.chooseMenuAndDate");
      return;
    }

    this.slotMessage.textContent = appJa.text("booking.checkingAvailability");
    try {
      const params = new URLSearchParams({ date: this.date.value, menu: this.menu.value });
      const response = await fetch(`/api/availability?${params}`, { headers: { Accept: "application/json" } });
      const data = await this.readJson(response);
      if (!data.slots.length) {
        this.slotMessage.textContent = data.message || appJa.text("booking.noAvailability");
        return;
      }
      this.slotMessage.textContent = appJa.text("booking.chooseTime");
      data.slots.forEach((slot) => this.renderTimeSlot(slot));
    } catch (error) {
      this.slotMessage.textContent = error.message;
    }
  }

  renderTimeSlot(slot) {
    const label = this.document.createElement("label");
    label.className = "slot-option";
    const radio = this.document.createElement("input");
    radio.type = "radio";
    radio.name = "slotChoice";
    radio.value = slot;
    radio.required = true;
    radio.addEventListener("change", () => { this.time.value = slot; });
    const text = this.document.createElement("span");
    text.textContent = slot;
    label.append(radio, text);
    this.slotList.append(label);
  }

  createBookingRequest() {
    return {
      idempotencyKey: this.idempotencyKey,
      menu: this.menu.value,
      date: this.date.value,
      time: this.time.value,
      name: this.form.elements.name.value.trim(),
      phone: this.form.elements.phone.value.trim(),
      email: this.form.elements.email.value.trim(),
      website: this.form.elements.website.value
    };
  }

  async submit(event) {
    event.preventDefault();
    if (!this.form.reportValidity()) return;
    this.submitButton.disabled = true;
    this.submitButton.textContent = appJa.text("booking.sending");
    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(this.createBookingRequest())
      });
      const result = await this.readJson(response);
      this.showBookingResult(result);
      this.resetForm();
      await this.loadConfig();
    } catch (error) {
      this.showNotice(error.message, "error");
      if (error.message.includes("空き") || error.message.includes("予約済み")) await this.loadSlots();
    } finally {
      this.submitButton.disabled = false;
      this.submitButton.textContent = appJa.text("booking.submit");
    }
  }

  showBookingResult(result) {
    const values = { bookingNumber: result.bookingNumber };
    if (result.notificationStatus === "sent") {
      this.showNotice(appJa.text("booking.confirmed", values), "success");
    } else if (result.notificationStatus === "failed") {
      this.showNotice(appJa.text("booking.confirmedLineFailed", values), "warning");
    } else {
      this.showNotice(appJa.text("booking.confirmedLineUnconfigured", values), "warning");
    }
  }

  resetForm() {
    this.form.reset();
    this.idempotencyKey = this.createRequestKey();
    this.slotList.replaceChildren();
    this.time.value = "";
    this.slotMessage.textContent = appJa.text("booking.chooseMenuAndDate");
  }
}

new ReservationPage().start();
