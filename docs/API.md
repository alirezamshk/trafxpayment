# مستندات API درگاه پرداخت TrafxPayment

این راهنما برای توسعه‌دهندگانی است که سایت یا پنل خود را به درگاه وصل می‌کنند.
همهٔ درخواست‌ها **سرور به سرور** هستند؛ کلید API را هرگز در مرورگر یا اپ موبایل نگذارید.

- آدرس پایه: `https://payment.trafx.cloud/v1`
- قالب درخواست و پاسخ: JSON (`Content-Type: application/json`)
- زمان‌ها به‌صورت ISO 8601 (UTC)، مبالغ به‌صورت **رشتهٔ اعشاری** (مثلاً `"25.50"`)

## ۱. شروع سریع

1. در پنل پذیرنده (`/panel`) یک **کلید API** بسازید (شکل کلید: `txp_...`). کلید فقط یک‌بار نمایش داده می‌شود.
2. در تنظیمات، **آدرس Webhook** و **آدرس تسویه** هر ارز را وارد کنید.
3. برای هر سفارش یک فاکتور بسازید و مشتری را به `payment_url` بفرستید.
4. نتیجه را از Webhook بگیرید (امضا را حتماً بررسی کنید) و سفارش را تکمیل کنید.

```bash
curl -X POST https://payment.trafx.cloud/v1/invoices \
  -H "Authorization: Bearer txp_XXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{"price_amount": "25", "price_currency": "USD", "order_id": "1001",
       "success_url": "https://shop.example/thanks", "cancel_url": "https://shop.example/cart"}'
```

## ۲. احراز هویت

در هر درخواست:

```
Authorization: Bearer txp_XXXXXXXX
```

اگر برای کلید «محدودیت IP» تنظیم کرده باشید، فقط از همان IPها پذیرفته می‌شود.

## ۳. خطاها

پاسخ خطا همیشه این شکل را دارد:

```json
{ "error": { "code": "not_found", "message": "Invoice not found" } }
```

| HTTP | code | معنی |
|---|---|---|
| 400 | `asset_not_allowed` یا خطای اعتبارسنجی | ارز برای حساب شما فعال نیست یا ورودی نامعتبر است |
| 401 | `unauthorized` | کلید API نامعتبر یا IP مجاز نیست |
| 404 | `not_found` | فاکتور پیدا نشد |
| 409 | `not_cancellable` | فاکتور پرداخت دارد یا وضعیتش اجازهٔ لغو نمی‌دهد |
| 409 | `nothing_to_pay` | موجودی یا آدرس تسویه برای این ارز نیست |
| 409 | `address_on_hold` | آدرس تسویه به‌تازگی تغییر کرده (۲۴ ساعت انتظار) |
| 503 | `rate_unavailable` | نرخ ارز در این لحظه در دسترس نیست؛ کمی بعد دوباره تلاش کنید |

## ۴. فاکتورها

### ساخت فاکتور — `POST /v1/invoices`

| فیلد | نوع | توضیح |
|---|---|---|
| `price_amount` | string/number، **الزامی** | مبلغ سفارش |
| `price_currency` | string | ارز مبلغ؛ پیش‌فرض `USD`. فقط ارزهای قابل‌قیمت‌گذاری: ارز دیجیتال (`USDT`، `TRX`، `BNB`، `ETH`، `TON`، `POL`) یا فیات‌های CoinGecko مثل `USD` و `EUR`. **ریال و تومان (`IRR`/`IRT`) پشتیبانی نمی‌شوند**؛ مبلغ را پیش از ارسال خودتان به یکی از این ارزها (مثلاً USDT) تبدیل کنید |
| `asset` | string | ارز پرداخت، مثل `USDT_BEP20`. اگر نفرستید مشتری در صفحهٔ پرداخت انتخاب می‌کند |
| `order_id` | string (حداکثر ۱۲۸) | شناسهٔ سفارش در سیستم شما |
| `customer_id` | string (حداکثر ۱۲۸) | شناسهٔ کاربر در سیستم شما؛ برای آدرس واریز دائمی هر کاربر |
| `customer_name` | string (حداکثر ۱۲۸) | نام مشتری (اختیاری؛ برای ثبت و نمایش در پنل شما) |
| `customer_email` | string | ایمیل مشتری (اختیاری) |
| `customer_phone` | string (حداکثر ۲۴) | تلفن مشتری (اختیاری)، مثل `+989121234567` |
| `customer_account` | string (حداکثر ۱۲۸) | اکانت یا نام کاربری مشتری در سیستم شما (اختیاری) |
| `description` | string (حداکثر ۵۰۰) | توضیح برای نمایش در صفحهٔ پرداخت |
| `success_url` / `cancel_url` | URL | مقصد بازگشت مشتری |
| `metadata` | object | هر داده‌ای که می‌خواهید در Webhook برگردد |
| `expires_in_minutes` | integer | مهلت پرداخت |
| `fee_paid_by` | `merchant` \| `customer` | کارمزد شبکه از سهم پذیرنده یا اضافه بر مبلغ مشتری |

پاسخ `201` با شیء فاکتور (پایین). مشتری را به `payment_url` هدایت کنید.

> `customer_id` را همیشه از نشست کاربر در سرور خودتان بفرستید، نه از ورودی کاربر.

### شیء فاکتور

```json
{
  "id": "6f1c0c1e-....",
  "invoice_number": 1001,
  "order_id": "ORD-1",
  "customer_id": null,
  "customer_name": "Ali Rezaei",
  "customer_email": "ali@example.com",
  "customer_phone": "+989121234567",
  "customer_account": "ali42",
  "description": null,
  "status": "pending",
  "price_amount": "25",
  "price_currency": "USD",
  "asset": "USDT_BEP20",
  "network": "bsc",
  "address": "0x...",
  "memo": null,
  "pay_amount": "25.000000",
  "amount_received": "0",
  "amount_pending": "0",
  "rate": "1",
  "fee_amount": "0",
  "network_fee": "0",
  "fee_paid_by": "merchant",
  "net_amount": null,
  "is_late": false,
  "payment_url": "https://payment.trafx.cloud/pay/6f1c0c1e-....",
  "success_url": "https://shop.example/thanks",
  "cancel_url": "https://shop.example/cart",
  "metadata": {},
  "expires_at": "2026-11-05T12:30:00.000Z",
  "paid_at": null,
  "created_at": "2026-11-05T12:00:00.000Z",
  "deposits": []
}
```

`invoice_number` شمارهٔ ترتیبی فاکتور برای هر پذیرنده است و خودکار داده می‌شود (`order_id` شناسهٔ سفارش خود شماست). مشخصات مشتری فقط برای ثبت‌اند و در صفحهٔ پرداخت نمایش داده نمی‌شوند.

`asset`، `address`، `pay_amount` تا وقتی مشتری ارز را انتخاب نکرده ممکن است `null` باشند.
`memo` فقط برای TON است (کامنت واریز باید دقیقاً همین باشد).
`net_amount` فقط بعد از `paid` مقدار دارد: دریافتی منهای کارمزد درگاه و کارمزد شبکه.

### وضعیت‌ها

| status | معنی |
|---|---|
| `pending` | منتظر پرداخت |
| `confirming` | واریز دیده شد، منتظر تاییدیهٔ کافی شبکه |
| `paid` | پرداخت کامل و تایید شد ← سفارش را تکمیل کنید |
| `partially_paid` | کمتر از مبلغ پرداخت شده |
| `expired` | مهلت تمام شد |
| `cancelled` | لغو شد |

پرداخت اضافه یا دیرهنگام بعد از `paid` هم اعتبار می‌گیرد و با رویداد `invoice.updated` خبر داده می‌شود.

### دریافت فاکتور — `GET /v1/invoices/:id`

شیء فاکتور به‌همراه آرایهٔ `deposits`:

```json
{ "tx_hash": "0x...", "from": "0x...", "amount": "25.000000",
  "confirmations": 12, "status": "confirmed", "detected_at": "2026-11-05T12:05:00.000Z" }
```

وضعیت واریز: `pending` (دیده شده، تاییدیه کافی نیست)، `confirmed` (تایید شده و در فاکتور حساب می‌شود)، `orphaned` (تراکنش به‌خاطر reorg یا شکست شبکه از بین رفته و حساب نمی‌شود).

### فهرست فاکتورها — `GET /v1/invoices`

پارامترها: `status`، `limit` (۱ تا ۱۰۰، پیش‌فرض ۲۰)، `before` (زمان ISO برای صفحه‌بندی؛ فاکتورهای قدیمی‌تر از آن).
پاسخ: `{ "data": [ ...فاکتور ] }` مرتب از جدید به قدیم.

### لغو فاکتور — `POST /v1/invoices/:id/cancel`

فقط فاکتورهای `pending` یا `expired` که هیچ پرداختی نداشته‌اند. در غیر این صورت خطای `409 not_cancellable`.

## ۵. ارزها — `GET /v1/currencies`

ارزهای فعال برای حساب شما:

```json
{ "data": [ { "id": "USDT_BEP20", "symbol": "USDT", "name": "Tether (BEP20)",
              "network": "bsc", "network_name": "BNB Smart Chain",
              "decimals": 18, "contract": "0x...", "confirmations": 15 } ] }
```

`GET /v1/assets` همین فهرست را برای کل درگاه (بدون کلید و بدون محدودیت حساب شما) می‌دهد.

مقدار `id` را در فیلد `asset` هنگام ساخت فاکتور بدهید. شناسه‌های رایج: `TRX`، `USDT_TRC20`، `ETH`، `USDT_ERC20`، `BNB`، `USDT_BEP20`، `POL`، `USDT_POLYGON`، `TON`، `USDT_TON` (هر کدام فقط اگر مدیر فعال کرده باشد).

## ۶. موجودی و تسویه

- `GET /v1/balances` ← `{ "data": [ { "asset": "USDT_BEP20", "balance": "120.5" } ] }` (موجودی قابل تسویه)
- `GET /v1/payouts` ← تاریخچهٔ تسویه‌ها
- `POST /v1/payouts` با بدنهٔ `{ "asset": "USDT_BEP20" }` ← درخواست تسویهٔ دستی (پاسخ `201`)

تسویهٔ خودکار طبق زمان‌بندی حساب شما (روزانه/هفتگی/دستی) انجام می‌شود. مبلغ تسویه = موجودی منهای «کارمزد شبکه تسویه» آن ارز.

وضعیت تسویه (`status`): `pending_approval` (منتظر تایید مدیر، اگر تایید دستی فعال باشد)، `approved`، `sending`، `sent` (ارسال شد، منتظر تایید شبکه)، `completed`، `failed`، `rejected`. در شکست یا رد، مبلغ به موجودی شما برمی‌گردد.

شیء تسویه:

```json
{ "id": "...", "asset": "USDT_BEP20", "network": "bsc", "address": "0x...",
  "amount": "119.5", "fee": "1", "status": "pending", "tx_hash": null, "error": null,
  "created_at": "...", "sent_at": null, "completed_at": null }
```

## ۷. Webhook

هر رویداد با `POST` به آدرس Webhook شما فرستاده می‌شود:

```json
{ "id": "uuid", "event": "invoice.paid", "created_at": "2026-11-05T12:10:00.000Z",
  "data": { ...شیء فاکتور یا تسویه } }
```

**رویدادها:** `invoice.confirming`، `invoice.paid`، `invoice.partially_paid`، `invoice.expired`، `invoice.cancelled`، `invoice.updated`، `payout.created`، `payout.completed`، `payout.failed`، `payout.rejected`.

**هدرها:**

| هدر | توضیح |
|---|---|
| `x-webhook-id` | شناسهٔ یکتا؛ برای جلوگیری از پردازش تکراری ذخیره کنید |
| `x-webhook-timestamp` | زمان ارسال (ثانیهٔ یونیکس) |
| `x-webhook-signature` | `HMAC_SHA256(secret, timestamp + "." + rawBody)` به‌صورت hex |

**قواعد:**

- پاسخ `2xx` یعنی دریافت شد. هر پاسخ دیگر یا timeout (۱۰ ثانیه) باعث تکرار می‌شود: تا ۱۲ بار، با فاصلهٔ ۳۰ ثانیه، ۱ دقیقه، ۲ دقیقه، ۴ دقیقه و ... حداکثر ۶ ساعت.
- ممکن است یک رویداد بیش از یک‌بار برسد؛ پردازش را idempotent بنویسید (با `x-webhook-id` یا `data.id` + `status`).
- ترتیب رسیدن تضمین نشده است. اگر تردید داشتید، وضعیت را با `GET /v1/invoices/:id` بخوانید.
- امضا را روی **بدنهٔ خام** (قبل از JSON.parse) بررسی کنید و زمان را حداکثر ۵ دقیقه تلورانس بدهید.
- ریدایرکت دنبال نمی‌شود؛ آدرس Webhook باید مستقیم جواب دهد.

### نمونه: Node.js (Express)

```js
import crypto from 'node:crypto';
import express from 'express';

const app = express();
const SECRET = process.env.TRAFX_WEBHOOK_SECRET;

app.post('/trafx-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const ts = req.header('x-webhook-timestamp');
  const sig = req.header('x-webhook-signature') || '';
  const body = req.body.toString('utf8');

  const expected = crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  const ok = sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) &&
    Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  if (!ok) return res.sendStatus(400);

  const evt = JSON.parse(body);
  if (evt.event === 'invoice.paid') {
    // سفارش evt.data.order_id را تکمیل کنید (فقط یک‌بار)
  }
  res.sendStatus(200);
});
```

### نمونه: PHP

```php
$secret = getenv('TRAFX_WEBHOOK_SECRET');
$body   = file_get_contents('php://input');
$ts     = $_SERVER['HTTP_X_WEBHOOK_TIMESTAMP'] ?? '';
$sig    = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '';

$expected = hash_hmac('sha256', $ts . '.' . $body, $secret);
if (!hash_equals($expected, $sig) || abs(time() - (int)$ts) > 300) {
    http_response_code(400); exit;
}

$evt = json_decode($body, true);
if ($evt['event'] === 'invoice.paid') {
    // سفارش $evt['data']['order_id'] را تکمیل کنید (فقط یک‌بار)
}
http_response_code(200);
```

### نمونه: ساخت فاکتور (Node.js)

```js
const res = await fetch('https://payment.trafx.cloud/v1/invoices', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.TRAFX_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ price_amount: '25', price_currency: 'USD', order_id: '1001' }),
});
const invoice = await res.json();
// redirect کاربر به invoice.payment_url
```

## ۸. نکات مهم یکپارچه‌سازی

- تکمیل سفارش را **فقط** با Webhook `invoice.paid` (یا خواندن وضعیت از API) انجام دهید، نه با بازگشت مشتری به `success_url`.
- مبلغ سفارش را با ارزی بفرستید که درگاه پشتیبانی می‌کند (مثلاً USDT یا USD). تبدیل تومان به آن ارز با خود شماست و بهتر است نرخ را هنگام ساخت فاکتور در سفارش ذخیره کنید.
- نرخ ارز هنگام صدور فاکتور قفل می‌شود؛ مبلغ `pay_amount` را همان‌طور که هست به مشتری نشان دهید.
- پرداخت ناقص یا اضافه به‌صورت خودکار در وضعیت و ledger لحاظ می‌شود؛ موارد مبهم را مدیر درگاه بررسی می‌کند.
- پیش از راه‌اندازی واقعی، چرخهٔ کامل را با مبلغ کم تست کنید.
