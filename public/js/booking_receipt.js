// Stores only the details needed for the receipt, within the current browser tab.
class BookingReceipt {
  static storageKey = 'yomon.bookingReceipt';
  static fields = ['bookingNumber', 'customerName', 'date', 'startTime', 'endTime', 'menuName'];

  static isValid(booking) {
    return booking && this.fields.every(field => typeof booking[field] === 'string' && booking[field])
      && WeeklyCalendar.isValidDate(booking.date)
      && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(booking.startTime)
      && /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.test(booking.endTime)
      && booking.startTime < booking.endTime;
  }

  static save(result) {
    if (!this.isValid(result.booking)) return false;
    const booking = Object.fromEntries(this.fields.map(field => [field, result.booking[field]]));
    booking.notificationStatus = result.notificationStatus;
    try {
      window.sessionStorage.setItem(this.storageKey, JSON.stringify(booking));
      return true;
    } catch {
      return false;
    }
  }

  static read() {
    try {
      const booking = JSON.parse(window.sessionStorage.getItem(this.storageKey));
      return this.isValid(booking) ? booking : null;
    } catch {
      return null;
    }
  }

  static dateTimeLabel(booking) {
    return WeeklyCalendar.displayText(`${WeeklyCalendar.dateLabel(booking.date)} ${booking.startTime}~${booking.endTime}`);
  }

  static notificationMessage(status) {
    if (status === 'failed') return appJa.text('booking.receiptLineFailed');
    if (status === 'not_configured') return appJa.text('booking.receiptLineUnconfigured');
    if (status === 'pending') return appJa.text('booking.receiptLinePending');
    return '';
  }
}
