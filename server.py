"""Local development server and reservation API for the Kishin website.

This standard-library server is intended for local development only. Use a
production WSGI/ASGI host, HTTPS, managed secrets, and persistent storage before
accepting public bookings.
"""

import hmac
import json
import os
import re
import secrets
import sqlite3
import uuid
from datetime import date, datetime, time, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = Path(os.environ.get("BOOKING_DB_PATH", str(DATA_DIR / "bookings.sqlite3")))
JST = ZoneInfo("Asia/Tokyo")
PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "127.0.0.1")
DAYS_AHEAD = max(1, min(180, int(os.environ.get("BOOKING_DAYS_AHEAD", "60"))))
SLOT_MINUTES = 30
OPENING_MINUTE = 10 * 60
LAST_START_MINUTE = 18 * 60
CLOSING_MINUTE = 19 * 60
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_OWNER_USER_ID = os.environ.get("LINE_OWNER_USER_ID", "")

MENUS = {
    "first": {"name": "初回：カウンセリング＋施術 30分", "duration": 30, "price": 3850},
    "acupuncture": {"name": "鍼 30分", "duration": 30, "price": 3300},
    "acupuncture_moxa": {"name": "鍼＋灸 30分", "duration": 30, "price": 3850},
    "meridian": {"name": "経絡ケア 60分", "duration": 60, "price": 6600},
}


class BookingService:
    """Own booking data, validation, availability, and LINE notifications."""
    @staticmethod
    def load_dotenv():
        """Load a simple project-local .env file without overriding shell values."""
        env_path = ROOT / ".env"
        if not env_path.is_file():
            return
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("\"'")
            if key and key not in os.environ:
                os.environ[key] = value

    @staticmethod
    def refresh_secrets_from_env():
        global ADMIN_TOKEN, LINE_CHANNEL_ACCESS_TOKEN, LINE_OWNER_USER_ID, DAYS_AHEAD, PORT, HOST, DB_PATH
        ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
        LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
        LINE_OWNER_USER_ID = os.environ.get("LINE_OWNER_USER_ID", "")
        DAYS_AHEAD = max(1, min(180, int(os.environ.get("BOOKING_DAYS_AHEAD", "60"))))
        PORT = int(os.environ.get("PORT", "8000"))
        HOST = os.environ.get("HOST", "127.0.0.1")
        configured_db_path = Path(os.environ.get("BOOKING_DB_PATH", str(DATA_DIR / "bookings.sqlite3")))
        DB_PATH = configured_db_path if configured_db_path.is_absolute() else ROOT / configured_db_path

    @staticmethod
    def get_db():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(DB_PATH), timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    @staticmethod
    def initialize_db():
        connection = BookingService.get_db()
        connection.execute("PRAGMA journal_mode=WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS bookings (
                id TEXT PRIMARY KEY,
                booking_number TEXT NOT NULL UNIQUE,
                idempotency_key TEXT NOT NULL UNIQUE,
                start_at TEXT NOT NULL,
                end_at TEXT NOT NULL,
                menu TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                phone TEXT NOT NULL,
                email TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL CHECK(status IN ('confirmed', 'cancelled')),
                notification_status TEXT NOT NULL DEFAULT 'pending',
                notification_error TEXT NOT NULL DEFAULT '',
                line_retry_key TEXT NOT NULL DEFAULT '',
                line_retry_created_at TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_bookings_start_status
              ON bookings(start_at, status);
            """
        )
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(bookings)")}
        if "line_retry_key" not in columns:
            connection.execute("ALTER TABLE bookings ADD COLUMN line_retry_key TEXT NOT NULL DEFAULT ''")
        if "line_retry_created_at" not in columns:
            connection.execute("ALTER TABLE bookings ADD COLUMN line_retry_created_at TEXT NOT NULL DEFAULT ''")
        connection.close()

    @staticmethod
    def now_jst():
        return datetime.now(JST)

    @staticmethod
    def parse_booking_date(raw_value):
        try:
            selected = date.fromisoformat(raw_value)
        except (TypeError, ValueError):
            raise ValueError("予約日を選び直してください。")
        today = BookingService.now_jst().date()
        if selected < today or selected > today + timedelta(days=DAYS_AHEAD):
            raise ValueError("予約できる期間外の日付です。")
        if selected.weekday() == 6:
            raise ValueError("日曜日は休院日です。別の日をお選びください。")
        return selected

    @staticmethod
    def parse_menu(menu_code):
        if not isinstance(menu_code, str) or menu_code not in MENUS:
            raise ValueError("施術メニューを選び直してください。")
        return MENUS[menu_code]

    @staticmethod
    def parse_start_datetime(selected_date, selected_time, duration_minutes):
        if not isinstance(selected_time, str) or not re.fullmatch(r"(?:1[0-8]|10):(?:00|30)", selected_time):
            raise ValueError("営業時間内の30分単位の時刻を選んでください。")
        hour, minute = map(int, selected_time.split(":"))
        start_minute = hour * 60 + minute
        if start_minute < OPENING_MINUTE or start_minute > LAST_START_MINUTE or start_minute % SLOT_MINUTES != 0:
            raise ValueError("営業時間内の30分単位の時刻を選んでください。")
        start = datetime.combine(selected_date, time(hour, minute), tzinfo=JST)
        if start <= BookingService.now_jst():
            raise ValueError("過去の時間は予約できません。")
        end = start + timedelta(minutes=duration_minutes)
        if end.hour * 60 + end.minute > CLOSING_MINUTE:
            raise ValueError("施術終了が閉院時刻を過ぎます。")
        return start, end

    @staticmethod
    def iso_local(value):
        return value.astimezone(JST).isoformat(timespec="minutes")

    @staticmethod
    def is_valid_phone(value):
        if not re.fullmatch(r"[+0-9()\-ー－\s]{8,30}", value):
            return False
        digits = re.sub(r"\D", "", value)
        return 8 <= len(digits) <= 15

    @staticmethod
    def get_available_slots(selected_date, menu_code, exclude_id=None):
        menu = BookingService.parse_menu(menu_code)
        current = BookingService.now_jst()
        slots = []
        db = BookingService.get_db()
        try:
            cursor = db.cursor()
            start_minute = OPENING_MINUTE
            while start_minute <= LAST_START_MINUTE:
                hour, minute = divmod(start_minute, 60)
                start = datetime.combine(selected_date, time(hour, minute), tzinfo=JST)
                end = start + timedelta(minutes=menu["duration"])
                if end.hour * 60 + end.minute <= CLOSING_MINUTE and start > current:
                    query = (
                        "SELECT 1 FROM bookings WHERE status = 'confirmed' "
                        "AND start_at < ? AND end_at > ?"
                    )
                    args = [BookingService.iso_local(end), BookingService.iso_local(start)]
                    if exclude_id:
                        query += " AND id != ?"
                        args.append(exclude_id)
                    if cursor.execute(query + " LIMIT 1", args).fetchone() is None:
                        slots.append(start.strftime("%H:%M"))
                start_minute += SLOT_MINUTES
        finally:
            db.close()
        return slots

    @staticmethod
    def line_push_message(booking, event_label="予約が入りました", retry_key=""):
        if not LINE_CHANNEL_ACCESS_TOKEN or not LINE_OWNER_USER_ID:
            return "not_configured", ""
        menu = MENUS[booking["menu"]]
        start = datetime.fromisoformat(booking["start_at"]).astimezone(JST)
        weekday_names = "月火水木金土日"
        message = "\n".join(
            [
                "【よもん はりきゅう治療院】" + event_label,
                "予約番号：" + booking["booking_number"],
                "日時：" + start.strftime("%Y年%m月%d日") + "（" + weekday_names[start.weekday()] + "） " + start.strftime("%H:%M"),
                "メニュー：" + menu["name"],
                "お名前：" + booking["customer_name"],
                "電話番号：" + booking["phone"],
            ]
        )
        body = json.dumps(
            {"to": LINE_OWNER_USER_ID, "messages": [{"type": "text", "text": message}]},
            ensure_ascii=False,
        ).encode("utf-8")
        request = Request(
            "https://api.line.me/v2/bot/message/push",
            data=body,
            headers={
                "Authorization": "Bearer " + LINE_CHANNEL_ACCESS_TOKEN,
                "Content-Type": "application/json",
                "X-Line-Retry-Key": retry_key,
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=10) as response:
                if 200 <= response.status < 300:
                    return "sent", ""
                return "failed", "LINE API returned HTTP " + str(response.status)
        except HTTPError as error:
            if error.code == 409:
                return "sent", ""
            return "failed", "LINE API returned HTTP " + str(error.code)
        except (URLError, TimeoutError, OSError):
            return "failed", "LINE API could not be reached"

    @staticmethod
    def send_and_record_notification(booking_id, event_label="予約が入りました", reset_retry=False):
        db = BookingService.get_db()
        try:
            booking = db.execute("SELECT * FROM bookings WHERE id = ?", (booking_id,)).fetchone()
        finally:
            db.close()
        if booking is None or booking["status"] != "confirmed":
            return "failed", "予約が見つかりません。"
        if not LINE_CHANNEL_ACCESS_TOKEN or not LINE_OWNER_USER_ID:
            status, error, retry_key = "not_configured", "", ""
        else:
            retry_key = booking["line_retry_key"]
            retry_created_at = booking["line_retry_created_at"]
            if reset_retry or not retry_key:
                retry_key = str(uuid.uuid4())
                retry_created_at = BookingService.now_jst().isoformat(timespec="seconds")
            elif retry_created_at:
                created = datetime.fromisoformat(retry_created_at)
                if BookingService.now_jst() - created > timedelta(hours=24):
                    return "failed", "LINEの安全な再送期限（24時間）を過ぎています。重複通知を避けるため自動再送しません。"

            db = BookingService.get_db()
            try:
                db.execute(
                    "UPDATE bookings SET line_retry_key = ?, line_retry_created_at = ? WHERE id = ?",
                    (retry_key, retry_created_at, booking_id),
                )
            finally:
                db.close()
            status, error = BookingService.line_push_message(booking, event_label, retry_key)
        db = BookingService.get_db()
        try:
            db.execute(
                "UPDATE bookings SET notification_status = ?, notification_error = ?, line_retry_key = ?, line_retry_created_at = ?, updated_at = ? WHERE id = ?",
                (status, error, retry_key, booking["line_retry_created_at"] if status == "not_configured" else (retry_created_at if LINE_CHANNEL_ACCESS_TOKEN and LINE_OWNER_USER_ID else ""), BookingService.now_jst().isoformat(timespec="seconds"), booking_id),
            )
        finally:
            db.close()
        return status, error

    @staticmethod
    def booking_dict(row):
        start = datetime.fromisoformat(row["start_at"]).astimezone(JST)
        end = datetime.fromisoformat(row["end_at"]).astimezone(JST)
        return {
            "id": row["id"],
            "bookingNumber": row["booking_number"],
            "date": start.strftime("%Y-%m-%d"),
            "startTime": start.strftime("%H:%M"),
            "endTime": end.strftime("%H:%M"),
            "menu": row["menu"],
            "customerName": row["customer_name"],
            "phone": row["phone"],
            "email": row["email"],
            "status": row["status"],
            "notificationStatus": row["notification_status"],
            "notificationError": row["notification_error"],
        }

class BookingHandler(SimpleHTTPRequestHandler):
    server_version = "KishinLocal/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        if self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Do not write request bodies, tokens, phone numbers, or email addresses to logs.
        super().log_message(fmt, *args)

    def translate_path(self, path):
        translated = Path(super().translate_path(path)).resolve()
        try:
            relative = translated.relative_to(ROOT)
        except ValueError:
            return str(ROOT / "__not_found__")
        if not relative.parts:
            return str(ROOT / "page" / "customer_page" / "home_page.html")
        allowed_root_files = {"index.html", "favicon.ico"}
        allowed_directories = {"assets", "css", "js", "page"}
        if any(part.startswith(".") for part in relative.parts):
            return str(ROOT / "__not_found__")
        if not relative.parts or (len(relative.parts) == 1 and relative.name not in allowed_root_files):
            return str(ROOT / "__not_found__")
        if len(relative.parts) > 1 and relative.parts[0] not in allowed_directories:
            return str(ROOT / "__not_found__")
        if relative.parts[0] == "page":
            allowed_pages = {
                ("page", "customer_page"): {"home_page.html", "price_page.html", "treatment_page.html", "reservation_page.html"},
                ("page", "admin"): {"admin_page.html"},
            }
            if len(relative.parts) != 3 or relative.name not in allowed_pages.get(relative.parts[:2], set()):
                return str(ROOT / "__not_found__")
        return str(translated)

    def json_response(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("送信内容を確認できませんでした。")
        if content_length < 1 or content_length > 20000:
            raise ValueError("送信内容のサイズが正しくありません。")
        try:
            return json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("送信内容を読み取れませんでした。")

    def require_admin(self):
        if not ADMIN_TOKEN:
            self.json_response(503, {"error": "管理機能は未設定です。.envにADMIN_TOKENを設定してください。"})
            return False
        supplied = self.headers.get("Authorization", "")
        expected = "Bearer " + ADMIN_TOKEN
        if not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
            self.json_response(401, {"error": "管理用トークンが正しくありません。"})
            return False
        return True

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/api/config":
            today = BookingService.now_jst().date()
            return self.json_response(
                200,
                {
                    "daysAhead": DAYS_AHEAD,
                    "minDate": today.isoformat(),
                    "maxDate": (today + timedelta(days=DAYS_AHEAD)).isoformat(),
                    "menus": MENUS,
                    "closedWeekdays": [6],
                },
            )
        if parsed.path == "/api/availability":
            query = parse_qs(parsed.query)
            try:
                selected_date = BookingService.parse_booking_date(query.get("date", [""])[0])
                menu_code = query.get("menu", [""])[0]
                slots = BookingService.get_available_slots(selected_date, menu_code)
                return self.json_response(200, {"date": selected_date.isoformat(), "slots": slots})
            except ValueError as error:
                return self.json_response(400, {"error": str(error)})
        if parsed.path == "/api/admin/bookings":
            if not self.require_admin():
                return
            query = parse_qs(parsed.query)
            try:
                selected_date = date.fromisoformat(query.get("date", [""])[0])
            except ValueError:
                return self.json_response(400, {"error": "日付を選択してください。"})
            db = BookingService.get_db()
            try:
                start = datetime.combine(selected_date, time.min, tzinfo=JST)
                end = start + timedelta(days=1)
                rows = db.execute(
                    "SELECT * FROM bookings WHERE start_at >= ? AND start_at < ? ORDER BY start_at",
                    (BookingService.iso_local(start), BookingService.iso_local(end)),
                ).fetchall()
                return self.json_response(200, {"bookings": [BookingService.booking_dict(row) for row in rows]})
            finally:
                db.close()
        return super().do_GET()

    def do_POST(self):
        parsed = urlsplit(self.path)
        if parsed.path == "/api/bookings":
            return self.create_booking()
        match = re.fullmatch(r"/api/admin/bookings/([a-f0-9-]+)/(?P<action>cancel|notify)", parsed.path)
        if match:
            if not self.require_admin():
                return
            booking_id = match.group(1)
            action = match.group("action")
            try:
                self.read_json()
            except ValueError as error:
                return self.json_response(400, {"error": str(error)})
            if action == "cancel":
                db = BookingService.get_db()
                try:
                    now = BookingService.now_jst().isoformat(timespec="seconds")
                    cursor = db.execute(
                        "UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'confirmed'",
                        (now, booking_id),
                    )
                    if cursor.rowcount != 1:
                        return self.json_response(404, {"error": "有効な予約が見つかりません。"})
                finally:
                    db.close()
                return self.json_response(200, {"ok": True})
            status, error = BookingService.send_and_record_notification(booking_id)
            if status == "sent":
                return self.json_response(200, {"ok": True, "notificationStatus": status})
            if status == "not_configured":
                return self.json_response(503, {"error": "LINE通知設定がありません。.envを設定してください。"})
            return self.json_response(502, {"error": "LINE通知を送信できませんでした。設定と接続を確認してください。", "notificationStatus": status})

        return self.json_response(404, {"error": "APIが見つかりません。"})

    def do_PUT(self):
        parsed = urlsplit(self.path)
        match = re.fullmatch(r"/api/admin/bookings/([a-f0-9-]+)", parsed.path)
        if not match:
            return self.json_response(404, {"error": "APIが見つかりません。"})
        if not self.require_admin():
            return
        booking_id = match.group(1)
        try:
            body = self.read_json()
            selected_date = BookingService.parse_booking_date(body.get("date", ""))
            selected_time = body.get("time", "")
        except (AttributeError, ValueError) as error:
            return self.json_response(400, {"error": str(error)})

        db = BookingService.get_db()
        try:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM bookings WHERE id = ?", (booking_id,)).fetchone()
            if existing is None or existing["status"] != "confirmed":
                db.rollback()
                return self.json_response(404, {"error": "有効な予約が見つかりません。"})
            try:
                start, end = BookingService.parse_start_datetime(selected_date, selected_time, MENUS[existing["menu"]]["duration"])
            except ValueError as error:
                db.rollback()
                return self.json_response(400, {"error": str(error)})
            if start == datetime.fromisoformat(existing["start_at"]):
                db.commit()
                return self.json_response(200, {"ok": True})
            collision = db.execute(
                "SELECT 1 FROM bookings WHERE status = 'confirmed' AND id != ? AND start_at < ? AND end_at > ? LIMIT 1",
                (booking_id, BookingService.iso_local(end), BookingService.iso_local(start)),
            ).fetchone()
            if collision:
                db.rollback()
                return self.json_response(409, {"error": "その時間はすでに予約されています。別の日時を選んでください。"})
            db.execute(
                "UPDATE bookings SET start_at = ?, end_at = ?, notification_status = 'pending', notification_error = '', updated_at = ? WHERE id = ?",
                (BookingService.iso_local(start), BookingService.iso_local(end), BookingService.now_jst().isoformat(timespec="seconds"), booking_id),
            )
            db.commit()
        except sqlite3.Error:
            db.rollback()
            return self.json_response(500, {"error": "予約日時を保存できませんでした。"})
        finally:
            db.close()
        status, _ = BookingService.send_and_record_notification(booking_id, "予約日時が変更されました", reset_retry=True)
        return self.json_response(200, {"ok": True, "notificationStatus": status})

    def create_booking(self):
        try:
            body = self.read_json()
            if body.get("website", ""):
                return self.json_response(400, {"error": "予約を送信できませんでした。"})
            idempotency_key = body.get("idempotencyKey", "")
            if not isinstance(idempotency_key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,100}", idempotency_key):
                raise ValueError("ページを再読み込みしてから、もう一度お試しください。")
            selected_date = BookingService.parse_booking_date(body.get("date", ""))
            menu_code = body.get("menu", "")
            menu = BookingService.parse_menu(menu_code)
            selected_time = body.get("time", "")
            start, end = BookingService.parse_start_datetime(selected_date, selected_time, menu["duration"])
            name = body.get("name", "").strip()
            phone = body.get("phone", "").strip()
            email = body.get("email", "").strip()
            if not name or len(name) > 80:
                raise ValueError("お名前を入力してください（80文字以内）。")
            if not BookingService.is_valid_phone(phone):
                raise ValueError("電話番号を確認してください。")
            if len(email) > 254 or (email and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email)):
                raise ValueError("メールアドレスを確認してください。")
        except (AttributeError, ValueError) as error:
            return self.json_response(400, {"error": str(error)})

        booking_id = str(uuid.uuid4())
        booking_number = "YOM-" + selected_date.strftime("%Y%m%d") + "-" + secrets.token_hex(2).upper()
        created_at = BookingService.now_jst().isoformat(timespec="seconds")
        db = BookingService.get_db()
        try:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute(
                "SELECT * FROM bookings WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
            if previous:
                db.commit()
                return self.json_response(
                    200,
                    {"ok": True, "bookingNumber": previous["booking_number"], "notificationStatus": previous["notification_status"]},
                )
            collision = db.execute(
                "SELECT 1 FROM bookings WHERE status = 'confirmed' AND start_at < ? AND end_at > ? LIMIT 1",
                (BookingService.iso_local(end), BookingService.iso_local(start)),
            ).fetchone()
            if collision:
                db.rollback()
                return self.json_response(409, {"error": "申し訳ありません。その時間は予約済みです。別の時間をお選びください。"})
            db.execute(
                "INSERT INTO bookings (id, booking_number, idempotency_key, start_at, end_at, menu, customer_name, phone, email, status, notification_status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'pending', ?, ?)",
                (
                    booking_id,
                    booking_number,
                    idempotency_key,
                    BookingService.iso_local(start),
                    BookingService.iso_local(end),
                    menu_code,
                    name,
                    phone,
                    email,
                    created_at,
                    created_at,
                ),
            )
            db.commit()
        except sqlite3.IntegrityError:
            db.rollback()
            return self.json_response(409, {"error": "その時間は予約済みです。空き時間を更新してください。"})
        except sqlite3.Error:
            db.rollback()
            return self.json_response(500, {"error": "予約を保存できませんでした。時間をおいて再度お試しください。"})
        finally:
            db.close()

        notification_status, _ = BookingService.send_and_record_notification(booking_id)
        return self.json_response(
            201,
            {"ok": True, "bookingNumber": booking_number, "notificationStatus": notification_status},
        )


def main():
    BookingService.load_dotenv()
    BookingService.refresh_secrets_from_env()
    BookingService.initialize_db()
    server = ThreadingHTTPServer((HOST, PORT), BookingHandler)
    print("Local site and booking API: http://127.0.0.1:" + str(PORT))
    print("Press Ctrl+C to stop. This server is for local development only.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping local server…")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
