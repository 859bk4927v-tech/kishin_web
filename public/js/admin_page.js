// View model that prepares a booking record for display in the admin screen.
class BookingListItem {
  constructor(booking) {
    this.booking = booking;
  }

  get heading() {
    const { startTime, endTime, customerName } = this.booking;
    return WeeklyCalendar.displayText(`${WeeklyCalendar.dateLabel(this.booking.date)} ${startTime}~${endTime} ${customerName}`);
  }

  get details() {
    const booking = this.booking;
    const notificationNames = {
      sent: appJa.text("admin.notificationSent"),
      failed: appJa.text("admin.notificationFailed"),
      not_configured: appJa.text("admin.notificationNotConfigured"),
      pending: appJa.text("admin.notificationPending")
    };
    return [
      [appJa.text("admin.labelBookingNumber"), booking.bookingNumber],
      [appJa.text("admin.labelMenu"), booking.menuName || booking.menu],
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
    this.blockForm = this.document.getElementById("adminBlockForm");
    this.blockDate = this.document.getElementById("adminBlockDate");
    this.blockStart = this.document.getElementById("adminBlockStart");
    this.blockEnd = this.document.getElementById("adminBlockEnd");
    this.blockNote = this.document.getElementById("adminBlockNote");
    this.blockSubmit = this.document.getElementById("adminBlockSubmit");
    this.bookingList = this.document.getElementById("bookingList");
    this.notice = this.document.getElementById("adminNotice");
    this.token = "";
    this.sessionVersion = 0;
    this.refreshRequestId = 0;
    this.calendar = this.document.getElementById('adminCalendar');
    this.calendarStatus = this.document.getElementById('adminCalendarStatus');
    this.cancelledList = this.document.getElementById('cancelledBookingList');
    this.dialog = this.document.getElementById('bookingDialog');
    this.dialogNotice = this.document.getElementById('bookingDialogNotice');
  }

  start() {
    if (!this.loginForm) return;
    try {
      sessionStorage.removeItem("kishinAdminToken");
    } catch {
      // The admin token is held only in memory, even when browser storage is disabled.
    }
    this.loginForm.addEventListener("submit", (event) => this.login(event));
    this.logoutButton.addEventListener("click", () => this.logout());
    this.document.getElementById("adminRefresh").addEventListener("click", () => this.refresh());
    this.dateInput.addEventListener("change", () => {
      this.blockDate.value = this.dateInput.value;
      this.refresh();
    });
    this.blockForm.addEventListener("submit", (event) => this.saveBlock(event));
    this.blockStart.addEventListener("change", () => this.updateBlockEndOptions());
    this.document.getElementById('adminPrevious').addEventListener('click', () => this.changeWeek(-1));
    this.document.getElementById('adminNext').addEventListener('click', () => this.changeWeek(1));
    this.document.getElementById('bookingDialogClose').addEventListener('click', () => this.closeBookingDialog());
    this.dialog.addEventListener('close', () => this.bookingList.replaceChildren());
    window.addEventListener("pagehide", () => this.logout());
  }

  showNotice(message, kind = "error") {
    for (const notice of [this.notice, this.dialogNotice]) {
      notice.hidden = false;
      notice.className = `booking-notice is-${kind}`;
      notice.textContent = message;
    }
  }

  clearNotice() {
    for (const notice of [this.notice, this.dialogNotice]) {
      notice.hidden = true;
      notice.textContent = "";
      notice.className = "booking-notice";
    }
  }

  async request(path, options = {}) {
    const sessionVersion = this.sessionVersion;
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${this.token}`);
    try {
      const data = await ApiClient.request(path, { ...options, headers });
      if (sessionVersion !== this.sessionVersion) throw new Error("管理画面のセッションが変わりました。");
      return data;
    } catch (error) {
      if (sessionVersion !== this.sessionVersion) throw new Error("管理画面のセッションが変わりました。");
      if (error.status === 401) { this.logout(); this.showNotice(error.message); }
      throw error;
    }
  }

  logout() {
    this.refreshRequestId += 1;
    this.sessionVersion += 1;
    this.token = "";
    this.tokenInput.value = "";
    this.dashboard.hidden = true;
    this.loginForm.hidden = false;
    this.closeBookingDialog();
    this.calendar.replaceChildren();
    this.cancelledList.replaceChildren();
    this.calendarStatus.textContent = '';
    this.config = null;
    this.clearNotice();
  }

  createButton(label, className, handler) {
    const button = this.document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = WeeklyCalendar.displayText(label);
    button.addEventListener("click", handler);
    return button;
  }

  closeBookingDialog() {
    if (this.dialog.open) this.dialog.close();
    this.bookingList.replaceChildren();
  }

  openBooking(booking) {
    this.dialogNotice.hidden = true;
    this.bookingList.replaceChildren();
    this.renderBookingCard(booking);
    this.dialog.showModal();
  }

  changeWeek(amount) {
    if (!WeeklyCalendar.isValidDate(this.dateInput.value)) return;
    this.dateInput.value = WeeklyCalendar.addDays(this.dateInput.value, amount * 7);
    this.blockDate.value = this.dateInput.value;
    this.refresh();
  }

  renderBookings(bookings, blocks) {
    const dates = WeeklyCalendar.dates(this.dateInput.value);
    const active = bookings.filter(booking => booking.status === 'confirmed');
    const table = WeeklyCalendar.createTable(this.document, dates, WeeklyCalendar.times(this.config.schedule, true),
      '予約管理 : ' + WeeklyCalendar.rangeLabel(this.dateInput.value), (cell, date, time) => {
        const booking = active.find(item => item.date === date && item.startTime <= time && time < item.endTime);
        if (!booking) {
          const block = blocks.find(item => item.date === date && item.startTime <= time && time < item.endTime);
          if (block) {
            const button = this.createButton('予定あり', 'calendar-block', () => this.openBlock(block));
            button.setAttribute('aria-label', WeeklyCalendar.displayText(`${WeeklyCalendar.dateLabel(date)} ${block.startTime}~${block.endTime} 登録した予定を開く`));
            cell.className = time === block.startTime ? 'block-start' : 'block-continuation';
            cell.append(button);
            return;
          }
          const closed = this.config.closedWeekdays.includes(WeeklyCalendar.weekday(date));
          cell.className = closed ? 'calendar-unavailable' : 'calendar-empty';
          cell.textContent = closed ? '休' : '—';
          return;
        }
        const button = this.createButton(`${booking.startTime}~${booking.endTime}\n${booking.customerName}`, 'calendar-booking', () => this.openBooking(booking));
        button.setAttribute('aria-label', WeeklyCalendar.displayText(`${WeeklyCalendar.dateLabel(date)} ${booking.startTime}~${booking.endTime} ${booking.customerName} 予約情報を開く`));
        cell.className = time === booking.startTime ? 'booking-start' : 'booking-continuation';
        cell.append(button);
      });
    this.calendar.replaceChildren(table);
    this.document.getElementById('adminWeekLabel').textContent = WeeklyCalendar.rangeLabel(this.dateInput.value);
    this.calendarStatus.textContent = appJa.format(`この週の予約 : ${active.length}件・予定 : ${blocks.length}件`);
    const cancelled = bookings.filter(booking => booking.status === 'cancelled');
    this.cancelledList.replaceChildren();
    cancelled.forEach(booking => {
      this.cancelledList.append(this.createButton(`${WeeklyCalendar.dateLabel(booking.date)} ${booking.startTime} ${booking.customerName}`, 'btn btn-outline', () => this.openBooking(booking)));
    });
    this.document.getElementById('cancelledBookings').hidden = !cancelled.length;
  }

  renderBookingCard(booking) {
    const item = new BookingListItem(booking);
    const card = this.document.createElement("article");
    card.className = `booking-card ${booking.status === "cancelled" ? "is-cancelled" : ""}`;
    const heading = this.document.createElement("h2");
    heading.id = "booking-detail-title";
    heading.textContent = item.heading;
    card.append(heading, this.createDetailsList(item.details));

    const actions = this.document.createElement("div");
    actions.className = "booking-actions";
    if (booking.status === "confirmed") {
      actions.append(this.createButton(appJa.text("admin.changeDateTime"), "btn btn-outline", () => this.showReschedule(card, booking)));
      actions.append(this.createButton(appJa.text("admin.cancel"), "btn btn-danger", () => this.cancelBooking(booking)));
    }
    if (booking.status === 'confirmed' && ['failed', 'not_configured', 'pending'].includes(booking.notificationStatus)) {
      actions.append(this.createButton(appJa.text("admin.resendLine"), "btn btn-outline", () => this.resendNotification(booking)));
    }
    card.append(actions);
    this.bookingList.append(card);
  }

  openBlock(block) {
    this.dialogNotice.hidden = true;
    this.bookingList.replaceChildren();
    const card = this.document.createElement('article');
    card.className = 'booking-card';
    const heading = this.document.createElement('h2');
    heading.id = 'booking-detail-title';
    heading.textContent = '登録した予定';
    card.append(heading, this.createDetailsList([
      ['日時', WeeklyCalendar.displayText(`${WeeklyCalendar.dateLabel(block.date)} ${block.startTime}~${block.endTime}`)],
      ['メモ', block.note || 'なし']
    ]));
    const actions = this.document.createElement('div');
    actions.className = 'booking-actions';
    actions.append(this.createButton('この予定を解除', 'btn btn-danger', () => this.deleteBlock(block)));
    card.append(actions);
    this.bookingList.append(card);
    this.dialog.showModal();
  }

  populateBlockTimes() {
    const times = WeeklyCalendar.times(this.config.schedule, true);
    const closing = this.config.schedule.closingMinute;
    const endTime = `${String(Math.floor(closing / 60)).padStart(2, '0')}:${String(closing % 60).padStart(2, '0')}`;
    const fill = (select, values) => {
      select.replaceChildren(...values.map(value => {
        const option = this.document.createElement('option');
        option.value = value;
        option.textContent = WeeklyCalendar.displayText(value);
        return option;
      }));
    };
    fill(this.blockStart, times);
    fill(this.blockEnd, [...times.slice(1), endTime]);
    this.updateBlockEndOptions();
  }

  updateBlockEndOptions() {
    for (const option of this.blockEnd.options) {
      option.disabled = option.value <= this.blockStart.value;
    }
    if (this.blockEnd.value <= this.blockStart.value) {
      this.blockEnd.value = Array.from(this.blockEnd.options).find(option => !option.disabled)?.value || '';
    }
  }

  async saveBlock(event) {
    event.preventDefault();
    if (this.blockEnd.value <= this.blockStart.value) {
      this.showNotice('終了時刻は開始時刻より後にしてください。');
      return;
    }
    this.blockSubmit.disabled = true;
    try {
      await this.request('/api/admin/blocks', {
        method: 'POST',
        body: JSON.stringify({
          date: this.blockDate.value,
          startTime: this.blockStart.value,
          endTime: this.blockEnd.value,
          note: this.blockNote.value
        })
      });
      this.dateInput.value = this.blockDate.value;
      this.blockNote.value = '';
      this.showNotice('予定を登録し、予約枠を塞ぎました。', 'success');
      await this.refresh();
    } catch (error) {
      this.showNotice(error.message);
    } finally {
      this.blockSubmit.disabled = false;
    }
  }

  async deleteBlock(block) {
    if (!window.confirm(`${WeeklyCalendar.dateLabel(block.date)} ${block.startTime}~${block.endTime} の予定を解除しますか?`)) return;
    try {
      await this.request(`/api/admin/blocks/${encodeURIComponent(block.id)}`, { method: 'DELETE' });
      this.showNotice('予定を解除しました。', 'success');
      await this.refresh();
    } catch (error) {
      this.showNotice(error.message);
    }
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
    date.id = "rescheduleDate";
    dateLabel.htmlFor = date.id;
    const timeLabel = this.createLabel(appJa.text("form.changedStartTime"));
    const time = this.createInput("time", booking.startTime);
    time.id = "rescheduleTime";
    timeLabel.htmlFor = time.id;
    time.step = "1800";
    const times = WeeklyCalendar.times(this.config.schedule);
    time.min = times[0];
    const duration = booking.durationMinutes;
    time.max = WeeklyCalendar.times(this.config.schedule, false, duration).at(-1);
    date.min = this.config.minDate;
    date.max = this.config.maxDate;
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
    if (!this.token || !this.config) return false;
    if (!WeeklyCalendar.isValidDate(this.dateInput.value)) {
      this.refreshRequestId += 1;
      this.closeBookingDialog();
      this.calendar.replaceChildren();
      this.cancelledList.replaceChildren();
      this.document.getElementById('cancelledBookings').hidden = true;
      this.calendarStatus.textContent = '日付を選択してください。';
      return false;
    }
    const requestId = ++this.refreshRequestId;
    this.closeBookingDialog();
    this.calendar.replaceChildren();
    this.cancelledList.replaceChildren();
    this.document.getElementById('cancelledBookings').hidden = true;
    this.document.getElementById('adminWeekLabel').textContent = WeeklyCalendar.rangeLabel(this.dateInput.value);
    this.calendarStatus.textContent = '一週間の予約を読み込んでいます…';
    this.calendar.setAttribute('aria-busy', 'true');
    try {
      const results = await Promise.all(WeeklyCalendar.dates(this.dateInput.value).map(date =>
        this.request(`/api/admin/bookings?date=${encodeURIComponent(date)}`)));
      if (requestId !== this.refreshRequestId) return false;
      this.renderBookings(results.flatMap(data => data.bookings), results.flatMap(data => data.blocks || []));
      return true;
    } catch (error) {
      if (requestId !== this.refreshRequestId) return false;
      this.calendarStatus.textContent = '予約を読み込めませんでした。「一覧を更新」で再度お試しください。';
      this.showNotice(error.message);
      return false;
    } finally {
      if (requestId === this.refreshRequestId) this.calendar.setAttribute('aria-busy', 'false');
    }
  }

  async login(event) {
    event.preventDefault();
    this.sessionVersion += 1;
    const sessionVersion = this.sessionVersion;
    this.token = this.tokenInput.value.trim();
    if (!this.token) return;
    try {
      this.config = await this.request('/api/config');
      if (sessionVersion !== this.sessionVersion) return;
      this.dateInput.value = this.config.minDate;
      this.blockDate.min = this.config.minDate;
      this.blockDate.max = this.config.maxDate;
      this.blockDate.value = this.config.minDate;
      this.populateBlockTimes();
      if (!(await this.refresh())) return;
      this.clearNotice();
      this.tokenInput.value = '';
      this.loginForm.hidden = true;
      this.dashboard.hidden = false;
    } catch (error) {
      if (sessionVersion === this.sessionVersion) this.showNotice(error.message);
    }
  }
}

new AdminPage().start();
