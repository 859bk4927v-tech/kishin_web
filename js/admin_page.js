// View model that prepares a booking record for display in the admin screen.
class BookingListItem {
  constructor(booking) {
    this.booking = booking;
  }

  get heading() {
    const { startTime, endTime, customerName } = this.booking;
    return `${startTime}〜${endTime}　${customerName}`;
  }

  get details() {
    const booking = this.booking;
    const menuNames = {
      first: appJa.strings.menus.first,
      acupuncture: appJa.strings.menus.acupuncture,
      acupuncture_moxa: appJa.strings.menus.acupunctureMoxa,
      meridian: appJa.strings.menus.meridian
    };
    const notificationNames = {
      sent: appJa.text("admin.notificationSent"),
      failed: appJa.text("admin.notificationFailed"),
      not_configured: appJa.text("admin.notificationNotConfigured"),
      pending: appJa.text("admin.notificationPending")
    };
    return [
      [appJa.text("admin.labelBookingNumber"), booking.bookingNumber],
      [appJa.text("admin.labelMenu"), menuNames[booking.menu] || booking.menu],
      [appJa.text("admin.labelPhone"), booking.phone],
      [appJa.text("admin.labelEmail"), booking.email || appJa.text("admin.emailMissing")],
      [appJa.text("admin.labelStatus"), booking.status === "confirmed" ? appJa.text("admin.statusConfirmed") : appJa.text("admin.statusCancelled")],
      [appJa.text("admin.labelLineNotification"), notificationNames[booking.notificationStatus] || booking.notificationStatus]
    ];
  }
}

// Coordinates authentication, booking actions, and rendering for the admin page.
class AdminPage {
  constructor(documentRoot = document) {
    this.document = documentRoot;
    this.loginForm = this.document.getElementById("adminLogin");
    if (!this.loginForm) return;

    this.tokenInput = this.document.getElementById("adminToken");
    this.logoutButton = this.document.getElementById("adminLogout");
    this.dashboard = this.document.getElementById("adminDashboard");
    this.dateInput = this.document.getElementById("adminDate");
    this.bookingList = this.document.getElementById("bookingList");
    this.notice = this.document.getElementById("adminNotice");
    this.token = sessionStorage.getItem("kishinAdminToken") || "";
  }

  start() {
    if (!this.loginForm) return;
    this.loginForm.addEventListener("submit", (event) => this.login(event));
    this.logoutButton.addEventListener("click", () => this.logout());
    this.document.getElementById("adminRefresh").addEventListener("click", () => this.refresh());
    this.dateInput.addEventListener("change", () => this.refresh());
    if (this.token) {
      this.tokenInput.value = this.token;
      this.loginForm.requestSubmit();
    }
  }

  showNotice(message, kind = "error") {
    this.notice.hidden = false;
    this.notice.className = `booking-notice is-${kind}`;
    this.notice.textContent = message;
  }

  async request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Accept", "application/json");
    if (options.body) headers.set("Content-Type", "application/json");
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) this.logout();
      throw new Error(data.error || appJa.text("admin.communicationError"));
    }
    return data;
  }

  logout() {
    this.token = "";
    sessionStorage.removeItem("kishinAdminToken");
    this.tokenInput.value = "";
    this.dashboard.hidden = true;
    this.loginForm.hidden = false;
  }

  createButton(label, className, handler) {
    const button = this.document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  renderBookings(bookings) {
    this.bookingList.replaceChildren();
    if (!bookings.length) {
      const emptyMessage = this.document.createElement("p");
      emptyMessage.className = "booking-empty";
      emptyMessage.textContent = appJa.text("admin.noBookings");
      this.bookingList.append(emptyMessage);
      return;
    }

    bookings.forEach((booking) => this.renderBookingCard(booking));
  }

  renderBookingCard(booking) {
    const item = new BookingListItem(booking);
    const card = this.document.createElement("article");
    card.className = `booking-card ${booking.status === "cancelled" ? "is-cancelled" : ""}`;
    const heading = this.document.createElement("h2");
    heading.textContent = item.heading;
    card.append(heading, this.createDetailsList(item.details));

    const actions = this.document.createElement("div");
    actions.className = "booking-actions";
    if (booking.status === "confirmed") {
      actions.append(this.createButton(appJa.text("admin.changeDateTime"), "btn btn-outline", () => this.showReschedule(card, booking)));
      actions.append(this.createButton(appJa.text("admin.cancel"), "btn btn-danger", () => this.cancelBooking(booking)));
    }
    if (booking.notificationStatus === "failed" || booking.notificationStatus === "not_configured") {
      actions.append(this.createButton(appJa.text("admin.resendLine"), "btn btn-outline", () => this.resendNotification(booking)));
    }
    card.append(actions);
    this.bookingList.append(card);
  }

  createDetailsList(rows) {
    const details = this.document.createElement("dl");
    rows.forEach(([label, value]) => {
      const term = this.document.createElement("dt");
      term.textContent = label;
      const description = this.document.createElement("dd");
      description.textContent = value;
      details.append(term, description);
    });
    return details;
  }

  async cancelBooking(booking) {
    if (!window.confirm(appJa.text("admin.confirmCancel", { bookingNumber: booking.bookingNumber }))) return;
    try {
      await this.request(`/api/admin/bookings/${encodeURIComponent(booking.id)}/cancel`, { method: "POST", body: "{}" });
      this.showNotice(appJa.text("admin.cancelled"), "success");
      await this.refresh();
    } catch (error) {
      this.showNotice(error.message);
    }
  }

  async resendNotification(booking) {
    try {
      await this.request(`/api/admin/bookings/${encodeURIComponent(booking.id)}/notify`, { method: "POST", body: "{}" });
      this.showNotice(appJa.text("admin.lineSent"), "success");
      await this.refresh();
    } catch (error) {
      this.showNotice(error.message);
    }
  }

  showReschedule(card, booking) {
    const existingForm = card.querySelector(".reschedule-form");
    if (existingForm) {
      existingForm.remove();
      return;
    }

    const form = this.document.createElement("form");
    form.className = "reschedule-form";
    const dateLabel = this.createLabel(appJa.text("form.changedDate"));
    const date = this.createInput("date", booking.date);
    const timeLabel = this.createLabel(appJa.text("form.changedStartTime"));
    const time = this.createInput("time", booking.startTime);
    time.step = "1800";
    const saveButton = this.document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "btn btn-primary";
    saveButton.textContent = appJa.text("admin.saveDateTime");
    form.append(dateLabel, date, timeLabel, time, saveButton);
    form.addEventListener("submit", (event) => this.saveReschedule(event, booking, date, time, saveButton));
    card.append(form);
  }

  createLabel(text) {
    const label = this.document.createElement("label");
    label.textContent = text;
    return label;
  }

  createInput(type, value) {
    const input = this.document.createElement("input");
    input.type = type;
    input.value = value;
    input.required = true;
    return input;
  }

  async saveReschedule(event, booking, date, time, saveButton) {
    event.preventDefault();
    saveButton.disabled = true;
    try {
      await this.request(`/api/admin/bookings/${encodeURIComponent(booking.id)}`, {
        method: "PUT",
        body: JSON.stringify({ date: date.value, time: time.value })
      });
      this.showNotice(appJa.text("admin.changed"), "success");
      this.dateInput.value = date.value;
      await this.refresh();
    } catch (error) {
      this.showNotice(error.message);
      saveButton.disabled = false;
    }
  }

  async refresh() {
    if (!this.token || !this.dateInput.value) return false;
    try {
      const data = await this.request(`/api/admin/bookings?date=${encodeURIComponent(this.dateInput.value)}`);
      this.renderBookings(data.bookings);
      return true;
    } catch (error) {
      this.showNotice(error.message);
      return false;
    }
  }

  async login(event) {
    event.preventDefault();
    this.token = this.tokenInput.value.trim();
    if (!this.token) return;
    sessionStorage.setItem("kishinAdminToken", this.token);
    this.dateInput.value = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    if (!(await this.refresh())) return;
    this.loginForm.hidden = true;
    this.dashboard.hidden = false;
  }
}

new AdminPage().start();
