class ReservationCompletePage {
  constructor(documentRoot = document) {
    this.document = documentRoot;
  }

  start() {
    const booking = BookingReceipt.read();
    if (!booking) return;
    this.document.getElementById('complete-title').textContent = 'ご予約ありがとうございます';
    this.document.getElementById('receiptNumber').textContent = booking.bookingNumber;
    this.document.getElementById('receiptName').textContent = booking.customerName;
    this.document.getElementById('receiptDateTime').textContent = BookingReceipt.dateTimeLabel(booking);
    this.document.getElementById('receiptMenu').textContent = booking.menuName;

    const notification = this.document.getElementById('receiptNotification');
    notification.textContent = BookingReceipt.notificationMessage(booking.notificationStatus);
    notification.hidden = !notification.textContent;

    this.document.getElementById('receiptMissing').hidden = true;
    this.document.getElementById('bookingReceipt').hidden = false;
  }
}

new ReservationCompletePage().start();
