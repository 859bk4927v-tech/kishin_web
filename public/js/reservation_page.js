// Coordinates the customer booking form and its API requests.
class ReservationPage {
  constructor(documentRoot = document) {
    this.document = documentRoot;
    this.form = this.document.getElementById("bookingForm");
    if (!this.form) return;

    this.menu = this.document.getElementById("menu");
    this.date = this.document.getElementById("bookingDate");
    this.time = this.document.getElementById("bookingTime");
    this.calendar = this.document.getElementById("bookingCalendar");
    this.calendarRetry = this.document.getElementById("bookingCalendarRetry");
    this.available = new Map();
    this.config = null;
    this.slotMessage = this.document.getElementById("slotMessage");
    this.notice = this.document.getElementById("bookingNotice");
    this.submitButton = this.document.getElementById("bookingSubmit");
    this.idempotencyKey = this.createRequestKey();
    this.availabilityRequestId = 0;
  }

  start() {
    if (!this.form) return;
    this.renderSelectedSymptom();
    window.addEventListener("hashchange", () => this.renderSelectedSymptom());
    this.populateMenuOptions();
    this.submitButton.textContent = appJa.text("booking.submit");
    this.menu.addEventListener("change", () => this.loadSlots());
    this.document.getElementById('bookingPrevious').addEventListener('click', () => this.changeWeek(-1));
    this.document.getElementById('bookingNext').addEventListener('click', () => this.changeWeek(1));
    this.calendarRetry.addEventListener('click', () => this.config ? this.loadSlots() : this.loadConfig());
    this.form.addEventListener("submit", (event) => this.submit(event));
    this.loadConfig();
  }

  renderSelectedSymptom() {
    const section = this.document.getElementById("selectedSymptom");
    if (!section) return;
    const title = this.document.getElementById("selected-symptom-title");
    const description = this.document.getElementById("selected-symptom-description");
    // Keep this display-only choice out of booking requests and server URLs.
    const symptom = new URLSearchParams(window.location.hash.slice(1)).get("symptom");
    const supported = ["neckShoulder", "backPain", "sleep", "cold", "digestion", "muscle"];
    section.hidden = true;
    title.textContent = "";
    description.textContent = "";
    if (!supported.includes(symptom)) return;

    title.textContent = appJa.text(`homePage.symptoms.${symptom}Title`);
    description.textContent = appJa.text(`homePage.symptoms.${symptom}Description`);
    section.hidden = false;
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
    this.submitButton.disabled = true;
    this.calendarRetry.hidden = true;
    this.slotMessage.textContent = 'カレンダーを準備しています…';
    try {
      const response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      this.config = await this.readJson(response);
      this.weekStart = this.config.minDate;
      this.document.getElementById('dateHelp').textContent = appJa.text('booking.dateHelp', { daysAhead: this.config.daysAhead });
      await this.loadSlots();
    } catch (error) {
      this.config = null;
      this.slotMessage.textContent = error.message;
      this.calendarRetry.hidden = false;
    } finally {
      this.submitButton.disabled = false;
    }
  }

  clearSelection() {
    this.date.value = '';
    this.time.value = '';
    this.document.getElementById('selectedDateTime').textContent = '日時を選択してください。';
  }

  changeWeek(amount) {
    if (!this.config) return;
    const start = WeeklyCalendar.addDays(this.weekStart, amount * 7);
    if (start < this.config.minDate || start > this.config.maxDate) return;
    this.weekStart = start;
    this.loadSlots();
  }

  async loadSlots() {
    const requestId = ++this.availabilityRequestId;
    this.clearSelection();
    this.available = new Map();
    this.calendarRetry.hidden = true;
    this.calendar.setAttribute("aria-busy", "false");
    if (!this.config) return;
    this.renderCalendar();
    if (!this.menu.value) {
      this.slotMessage.textContent = '先に施術メニューを選択してください。';
      return;
    }

    const menu = this.menu.value;
    const dates = WeeklyCalendar.dates(this.weekStart);
    this.slotMessage.textContent = '一週間の空き状況を確認しています…';
    this.calendar.setAttribute('aria-busy', 'true');
    try {
      const results = await Promise.all(dates.map(async date => {
        if (date > this.config.maxDate || this.config.closedWeekdays.includes(WeeklyCalendar.weekday(date))) return [date, []];
        const params = new URLSearchParams({ date, menu });
        const response = await fetch(`/api/availability?${params}`, { headers: { Accept: 'application/json' } });
        const data = await this.readJson(response);
        return [date, data.slots];
      }));
      if (requestId !== this.availabilityRequestId) return;
      this.available = new Map(results.map(([date, slots]) => [date, new Set(slots)]));
      this.renderCalendar();
      this.slotMessage.textContent = results.some(([, slots]) => slots.length)
        ? 'ご希望の日時の「○」をタップしてください。'
        : 'この週に予約可能な時間はありません。別の週をご確認ください。';
    } catch (error) {
      if (requestId !== this.availabilityRequestId) return;
      this.slotMessage.textContent = error.message;
      this.calendarRetry.hidden = false;
    } finally {
      if (requestId === this.availabilityRequestId) this.calendar.setAttribute('aria-busy', 'false');
    }
  }

  renderCalendar() {
    const dates = WeeklyCalendar.dates(this.weekStart);
    this.document.getElementById('bookingWeekLabel').textContent = WeeklyCalendar.rangeLabel(this.weekStart);
    this.document.getElementById('bookingPrevious').disabled = this.weekStart <= this.config.minDate;
    this.document.getElementById('bookingNext').disabled = WeeklyCalendar.addDays(this.weekStart, 7) > this.config.maxDate;
    const table = WeeklyCalendar.createTable(this.document, dates, WeeklyCalendar.times(this.config.schedule),
      '希望日時選択：' + WeeklyCalendar.rangeLabel(this.weekStart), (cell, date, time) => {
        const available = this.available.get(date)?.has(time)
          && Date.parse(`${date}T${time}:00+09:00`) > Date.now();
        if (!available) {
          cell.className = 'calendar-unavailable';
          cell.textContent = '×';
          cell.setAttribute('aria-label', `${WeeklyCalendar.dateLabel(date)} ${time} 受付不可`);
          return;
        }
        const button = this.document.createElement('button');
        button.type = 'button';
        button.className = 'calendar-slot';
        button.textContent = '○';
        button.dataset.date = date;
        button.dataset.time = time;
        button.setAttribute('aria-label', `${WeeklyCalendar.dateLabel(date)} ${time} 予約可能`);
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => this.selectSlot(button, date, time));
        cell.append(button);
      });
    this.calendar.replaceChildren(table);
  }

  selectSlot(button, date, time) {
    if (Date.parse(`${date}T${time}:00+09:00`) <= Date.now()) {
      this.loadSlots();
      return;
    }
    this.date.value = date;
    this.time.value = time;
    this.calendar.querySelectorAll('.calendar-slot').forEach(slot => {
      const selected = slot === button;
      slot.setAttribute('aria-pressed', String(selected));
      slot.textContent = selected ? '✓' : '○';
    });
    this.document.getElementById('selectedDateTime').textContent = `選択中：${WeeklyCalendar.dateLabel(date)} ${time}`;
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
    if (!this.date.value || !this.time.value) {
      this.showNotice('カレンダーからご希望の日時を選択してください。', 'error');
      this.calendar.focus();
      return;
    }
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
    this.clearSelection();
    this.available = new Map();
    if (this.config) this.renderCalendar();
    this.slotMessage.textContent = '先に施術メニューを選択してください。';
  }
}

new ReservationPage().start();
