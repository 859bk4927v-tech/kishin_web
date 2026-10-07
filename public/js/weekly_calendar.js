// Calendar dates use UTC arithmetic so browser time zones and DST cannot shift a day.
class WeeklyCalendar {
  static displayText(value) {
    return String(value).replace(/\s*([:/])\s*/g, " $1 ");
  }

  static isValidDate(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const value = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
  }

  static addDays(date, amount) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + amount);
    return value.toISOString().slice(0, 10);
  }

  static dates(start) {
    return Array.from({ length: 7 }, (_, index) => this.addDays(start, index));
  }

  static weekday(date) {
    return new Date(`${date}T00:00:00Z`).getUTCDay();
  }

  static dateLabel(date) {
    const [year, month, day] = date.split('-').map(Number);
    return `${year}年${month}月${day}日(${'日月火水木金土'[this.weekday(date)]})`;
  }

  static rangeLabel(start) {
    return `${this.dateLabel(start)} ~ ${this.dateLabel(this.addDays(start, 6))}`;
  }

  static times(schedule, includeClosingSlot = false, durationMinutes = 0) {
    const last = includeClosingSlot ? schedule.closingMinute - schedule.slotMinutes : schedule.lastStartMinute;
    const result = [];
    for (let minute = schedule.openingMinute; minute <= last; minute += schedule.slotMinutes) {
      if (minute + durationMinutes > schedule.closingMinute) continue;
      result.push(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
    }
    return result;
  }

  static createTable(documentRoot, dates, times, captionText, renderCell) {
    const table = documentRoot.createElement('table');
    table.className = 'week-calendar';
    const caption = documentRoot.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = this.displayText(captionText);
    const head = documentRoot.createElement('thead');
    const header = documentRoot.createElement('tr');
    const corner = documentRoot.createElement('th');
    corner.scope = 'col';
    corner.textContent = '時間';
    header.append(corner);
    dates.forEach(date => {
      const th = documentRoot.createElement('th');
      th.scope = 'col';
      const weekday = this.weekday(date);
      if (weekday === 0) th.className = 'is-sunday';
      if (weekday === 6) th.className = 'is-saturday';
      const day = documentRoot.createElement('span');
      const week = documentRoot.createElement('span');
      day.textContent = `${Number(date.slice(5, 7))} / ${Number(date.slice(8))}`;
      week.textContent = '日月火水木金土'[weekday];
      th.append(day, week);
      header.append(th);
    });
    head.append(header);
    const body = documentRoot.createElement('tbody');
    times.forEach(time => {
      const row = documentRoot.createElement('tr');
      const label = documentRoot.createElement('th');
      label.scope = 'row';
      label.textContent = this.displayText(time);
      row.append(label);
      dates.forEach(date => {
        const cell = documentRoot.createElement('td');
        renderCell(cell, date, time);
        row.append(cell);
      });
      body.append(row);
    });
    table.append(caption, head, body);
    return table;
  }
}
