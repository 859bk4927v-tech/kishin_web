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
    this.eveningOnly = this.document.getElementById("eveningOnly");
    this.available = new Map();
    this.config = null;
    this.slotMessage = this.document.getElementById("slotMessage");
    this.notice = this.document.getElementById("bookingNotice");
    this.submitButton = this.document.getElementById("bookingSubmit");
    this.idempotencyKey = this.createRequestKey();
    this.availabilityRequestId = 0;
    this.submitting = false;
  }

  start() {
    if (!this.form) return;
    this.renderSelectedSymptom();
    window.addEventListener("hashchange", () => this.renderSelectedSymptom());
    this.submitButton.textContent = appJa.text("booking.submit");
    this.menu.addEventListener("change", () => this.loadSlots());
    this.eveningOnly.addEventListener("change", () => this.changeTimeFilter());
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
    const selected = this.menu.value;
    const placeholder = this.document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = appJa.text('form.chooseMenu');
    const options = Object.entries(this.config.menus).map(([code, menu]) => {
      const option = this.document.createElement('option');
      option.value = code;
      option.textContent = `${menu.name} ¥${menu.price.toLocaleString('ja-JP')}`;
      return option;
    });
    this.menu.replaceChildren(placeholder, ...options);
    this.menu.value = Object.hasOwn(this.config.menus, selected) ? selected : '';
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

  async loadConfig() {
    this.submitButton.disabled = true;
    this.menu.disabled = true;
    this.calendarRetry.hidden = true;
    this.slotMessage.textContent = 'カレンダーを準備しています…';
    try {
      this.config = await ApiClient.request('/api/config');
      this.populateMenuOptions();
      this.weekStart = this.config.minDate;
      this.document.getElementById('dateHelp').textContent = appJa.text('booking.dateHelp', { daysAhead: this.config.daysAhead });
      await this.loadSlots();
    } catch (error) {
      this.config = null;
      this.available = new Map();
      this.calendar.replaceChildren();
      this.clearSelection();
      this.slotMessage.textContent = error.message;
      this.calendarRetry.hidden = false;
    } finally {
      this.submitButton.disabled = false;
      this.menu.disabled = !this.config;
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
    this.updateMenuSummary();
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
        const data = await ApiClient.request(`/api/availability?${params}`);
        return [date, data.slots];
      }));
      if (requestId !== this.availabilityRequestId) return;
      this.available = new Map(results.map(([date, slots]) => [date, new Set(slots)]));
      this.renderCalendar();
      this.updateAvailabilityMessage();
    } catch (error) {
      if (requestId !== this.availabilityRequestId) return;
      this.slotMessage.textContent = error.message;
      this.calendarRetry.hidden = false;
    } finally {
      if (requestId === this.availabilityRequestId) this.calendar.setAttribute('aria-busy', 'false');
    }
  }

  visibleTimes() {
    const duration = this.config.menus[this.menu.value]?.duration || 0;
    return WeeklyCalendar.times(this.config.schedule, false, duration).filter(time => !this.eveningOnly?.checked || time >= '18:00');
  }

  updateMenuSummary() {
    const summary = this.document.getElementById('menuSummary');
    if (!summary) return;
    const menu = this.config.menus[this.menu.value];
    summary.hidden = !menu;
    summary.textContent = appJa.format(menu ? `所要時間 : ${menu.duration}分 / 料金 : ¥${menu.price.toLocaleString('ja-JP')}(税込)` : '');
  }

  changeTimeFilter() {
    if (!this.config) return;
    this.clearSelection();
    this.renderCalendar();
    if (this.menu.value && this.calendar.getAttribute('aria-busy') !== 'true' && this.calendarRetry.hidden) {
      this.updateAvailabilityMessage();
    }
  }

  updateAvailabilityMessage() {
    const hasSlots = [...this.available.values()].some(slots => [...slots].some(time => !this.eveningOnly?.checked || time >= '18:00'));
    this.slotMessage.textContent = hasSlots
      ? 'ご希望の日時の「○」をタップしてください。'
      : this.eveningOnly?.checked
        ? 'この週の18:00以降に空きはありません。すべての時間帯を表示するか、別の週をご確認ください。'
        : 'この週に予約可能な時間はありません。別の週をご確認ください。';
  }

  renderCalendar() {
    const dates = WeeklyCalendar.dates(this.weekStart);
    this.document.getElementById('bookingWeekLabel').textContent = WeeklyCalendar.rangeLabel(this.weekStart);
    this.document.getElementById('bookingPrevious').disabled = this.weekStart <= this.config.minDate;
    this.document.getElementById('bookingNext').disabled = WeeklyCalendar.addDays(this.weekStart, 7) > this.config.maxDate;
    if (!this.menu.value || !this.available.size) {
      this.calendar.replaceChildren();
      return;
    }
    const table = WeeklyCalendar.createTable(this.document, dates, this.visibleTimes(),
      '希望日時選択:' + WeeklyCalendar.rangeLabel(this.weekStart), (cell, date, time) => {
        const available = this.available.get(date)?.has(time)
          && Date.parse(`${date}T${time}:00+09:00`) > Date.now();
        if (!available) {
          cell.className = 'calendar-unavailable';
          cell.textContent = '×';
          cell.setAttribute('aria-label', WeeklyCalendar.displayText(`${WeeklyCalendar.dateLabel(date)} ${time} 受付不可`));
          return;
        }
        const button = this.document.createElement('button');
        button.type = 'button';
        button.className = 'calendar-slot';
        button.textContent = '○';
        button.dataset.date = date;
        button.dataset.time = time;
        button.setAttribute('aria-label', WeeklyCalendar.displayText(`${WeeklyCalendar.dateLabel(date)} ${time} 予約可能`));
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
    this.document.getElementById('selectedDateTime').textContent = WeeklyCalendar.displayText(`選択中 : ${WeeklyCalendar.dateLabel(date)} ${time}`);
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
      website: this.form.elements.website.value,
      turnstileToken: this.form.querySelector('[name="cf-turnstile-response"]')?.value || ""
    };
  }

  async submit(event) {
    event.preventDefault();
    if (this.submitting) return;
    if (!this.form.reportValidity()) return;
    if (!this.date.value || !this.time.value) {
      this.showNotice('カレンダーからご希望の日時を選択してください。', 'error');
      this.calendar.focus();
      return;
    }
    this.submitButton.disabled = true;
    this.submitting = true;
    this.form.inert = true;
    this.submitButton.textContent = appJa.text("booking.sending");
    try {
      const result = await ApiClient.request("/api/bookings", {
        method: "POST",
        body: JSON.stringify(this.createBookingRequest())
      });
      if (BookingReceipt.save(result)) {
        window.location.replace('reservation_complete_page.html');
        return;
      }
      this.showBookingResult(result);
      this.resetForm();
      await this.loadConfig();
    } catch (error) {
      this.showNotice(error.message, "error");
      this.notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (window.turnstile) window.turnstile.reset();
      if (error.status === 409) await this.loadSlots();
    } finally {
      this.submitting = false;
      this.form.inert = false;
      this.submitButton.disabled = false;
      this.submitButton.textContent = appJa.text("booking.submit");
    }
  }

  showBookingResult(result) {
    const values = { bookingNumber: result.bookingNumber };
    const booking = result.booking;
    const details = booking
      ? `\n氏名:${booking.customerName}\n予約日時:${BookingReceipt.dateTimeLabel(booking)}\n予約メニュー:${booking.menuName}\n${appJa.text('booking.receiptReminder')}`
      : '';
    if (result.notificationStatus === "sent") {
      this.showNotice(appJa.text("booking.confirmed", values) + details, "success");
    } else if (result.notificationStatus === "failed") {
      this.showNotice(appJa.text("booking.confirmedLineFailed", values) + details, "warning");
    } else {
      this.showNotice(appJa.text("booking.confirmedLineUnconfigured", values) + details, "warning");
    }
    this.notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  resetForm() {
    this.form.reset();
    this.idempotencyKey = this.createRequestKey();
    this.clearSelection();
    this.available = new Map();
    if (this.config) {
      this.updateMenuSummary();
      this.renderCalendar();
    }
    this.slotMessage.textContent = '先に施術メニューを選択してください。';
  }
}

new ReservationPage().start();
