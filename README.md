# سامانه آزمون

نسخه قابل نصب روی سرور، با حفظ سؤال‌ها، مقیاس‌ها، ظاهر و تنظیمات آزمون مبدأ.
فایل JSON داوطلبان در این مخزن `[]` است. اطلاعات ورود، نتایج، گزارش‌ها، فایل‌های اکسل و نسخه‌های پشتیبان مبدأ منتشر نشده‌اند.

## نصب با Docker Compose

```sh
git clone https://github.com/MhFarhoud/Azmoon.git
cd Azmoon
cp .env.example .env
# فایل .env را ویرایش و SECRET_KEY و STAFF_PASSWORD را تعیین کنید
docker compose up -d --build
```

برنامه روی `http://127.0.0.1:5001` اجرا می‌شود. رمز پذیرش از `STAFF_PASSWORD` خوانده می‌شود.
روی سرور برای دسترسی راه دور از پراکسی معکوس با HTTPS و پشتیبانی WebSocket استفاده کنید.
برای دسترسی موقت از رایانه خود می‌توانید تونل SSH بسازید:

```sh
ssh -L 5001:127.0.0.1:5001 user@server
```

داده‌های داوطلبان، تنظیم زمان آزمون و نتایج در volume به نام `exam_data` ماندگارند.
داوطلبان را از بخش پذیرش اضافه کنید. حذف volume با `docker compose down -v` داده‌ها را پاک می‌کند.
برای پشتیبان‌گیری، از محتوای `/data` در کانتینر نسخه بگیرید.

## نصب بدون Docker

به Python 3.11 نیاز دارید.

```sh
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export SECRET_KEY='your-long-random-secret'
export STAFF_PASSWORD='your-staff-password'
export DATA_DIR="$PWD/data"
gunicorn --worker-class geventwebsocket.gunicorn.workers.GeventWebSocketWorker --workers 1 --bind 127.0.0.1:5001 --timeout 120 app:app
```

فقط یک worker اجرا کنید؛ وضعیت زنده آزمون در حافظه نگهداری می‌شود.
فایل‌های سؤال و `exam_config.json` را برای حفظ آزمون تغییر ندهید.
در صورت نیاز به انتقال تنظیمات زمان، `settings.json` را به پوشه داده سرور منتقل کنید.

## محدوده دسترسی

منطق دسترسی نسخه فعلی حفظ شده است: رمز پذیرش فقط ورود رابط کاربری را کنترل می‌کند و تمام APIها و رویدادهای Socket.IO احراز هویت سمت سرور ندارند.
این نسخه را در شبکه قابل اعتماد یا پشت کنترل دسترسی شبکه/VPN اجرا کنید؛ برای انتشار عمومی اینترنت، احراز هویت و مجوزدهی سمت سرور باید تکمیل شود.

## به‌روزرسانی

```sh
git pull
docker compose up -d --build
```

فایل‌های `.env` و داده‌های زمان اجرا را در Git ثبت نکنید. سؤال‌ها و تنظیمات داخل مخزن هنگام به‌روزرسانی حفظ یا طبق تغییرات مخزن جایگزین می‌شوند؛ از تغییرات اختصاصی سرور پشتیبان بگیرید.
