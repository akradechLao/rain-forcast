# คู่มือ deploy ขึ้นเซิร์ฟเวอร์ + ตั้งชื่อเว็บ `saha-rain-watch.<โดเมนของคุณ>`
### ด้วย AApanel (เซิร์ฟเวอร์) + Cloudflare (DNS/SSL)

ภาพรวม:

```
ผู้ใช้ → https://saha-rain-watch.example.com
          │   (Cloudflare DNS: A record → IP เซิร์ฟเวอร์, โพร็กซีเปิด)
          ▼
เซิร์ฟเวอร์ AApanel — Nginx (เว็บ subdomain) ── reverse proxy ──► Node.js :8080 (PM2)
                                                          │
                                              data/ เก็บประวัติน้ำฝนบนเซิร์ฟเวอร์
```

---

## ขั้นตอนที่ 1 — เตรียมโค้ดลงเซิร์ฟเวอร์

SSH เข้าเซิร์ฟ (user `root`):

```bash
# ติดตั้ง Node.js 20 (ถ้าเครื่องยังไม่มี)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs   # Debian/Ubuntu
# หรือ: yum install -y nodejs (CentOS — แนะนำใช้ NodeSource แทน)

mkdir -p /www/wwwroot && cd /www/wwwroot
git clone https://github.com/akradechLao/rain-forcast.git
cd rain-forcast/rain-dashboard
npm install
```

> ถ้าเซิร์ฟไม่มี `git` ให้ดาวน์โหลด ZIP จาก GitHub แล้วอัปโหลดผ่าน AApanel (ไฟล์ → อัปโหลด) แล้วแตกไฟล์ที่ `/www/wwwroot/rain-forcast`

## ขั้นตอนที่ 2 — ตั้งค่า `.env` ฝั่งเซิร์ฟเวอร์

```bash
cd /www/wwwroot/rain-forcast/rain-dashboard
cp .env.example .env
openssl rand -hex 24        # สุ่มรหัส สำหรับ INTERNAL_TOKEN → คัดลอกไว้
nano .env                   # แก้ค่าดังนี้
```

ค่าที่ควรแก้:

| ค่า | ตัวอย่าง |
|---|---|
| `DASHBOARD_URL` | `https://saha-rain-watch.example.com` |
| `INTERNAL_TOKEN` | รหัสที่สุ่มไว้ (ใช้ป้องกัน endpoint รับข้อมูลฝน) |
| `TMD_UID` / `TMD_UKEY` | คีย์กรมอุตุฯ (ยังไม่มีใช้ `demo` ไปก่อน) |
| `LINE_*`, `SMTP_*` | เปิดทีหลังเมื่อได้ token/บัญชีแล้ว |
| `MQTT_*` | กรอกเมื่อพร้อมเชื่อมเซนเซอร์ |

## ขั้นตอนที่ 3 — รันแอปด้วย PM2 (ให้ทำงานตลอด)

```bash
npm install -g pm2
cd /www/wwwroot/rain-forcast/rain-dashboard
pm2 start server.js --name rain-dashboard
pm2 save
pm2 startup         # รันคำสั่งที่ขึ้นต้นด้วย sudo ... ตามที่แสดง (ให้สตาร์ทอัตโนมัติเมื่อ reboot)
```

คำสั่งที่ใช้บ่อย: `pm2 logs rain-dashboard`, `pm2 restart rain-dashboard`

## ขั้นตอนที่ 4 — สร้างเว็บ subdomain ใน AApanel

1. เมนู **Website (เว็บไซต์) → Add Site (เพิ่มเว็บไซต์)**
   - Domain: `saha-rain-watch.example.com`
   - PHP: เลือก **Pure static / ไม่ใช้ PHP**
   - Root directory: ใช้ค่าอัตโนมัติ →  Submit
2. เข้าเว็บนั้น → แท็บ **Reverse Proxy (reverse proxy / 代理) → Add (เพิ่ม)**
   - Proxy name: `node`
   - Send domain: `$host`
   - Target URL: `http://127.0.0.1:8080`   ← **สำคัญ**
   - บันทึก
3. ตรวจในเครื่องเซิร์ฟ:
   ```bash
   curl -I http://127.0.0.1:8080        # ต้องขึ้น HTTP/1.1 200
   curl -I https://saha-rain-watch.example.com/api/kpi
   ```

## ขั้นตอนที่ 5 — ตั้ง DNS บน Cloudflare

1. Cloudflare Dashboard → เลือกโดเมน → **DNS → Records → Add record**
   - Type: `A` · Name: `saha-rain-watch` · IPv4: `IP เซิร์ฟเวอร์` · Proxy: **ปิด (DNS only, สีเทา)** ก่อน
2. กลับ AApanel → เว็บนั้น → **SSL → Let's Encrypt → Issue (ขอใบรับรอง)**
   - ต้องรอ DNS ชี้มาที่เซิร์ฟก่อน ~1-5 นาที
   - เปิด **Force HTTPS**
3. เมื่อ HTTPS ใช้ได้แล้ว → กลับ Cloudflare → เปลี่ยน Proxy เป็น **เปิด (สีส้ม)**
4. Cloudflare → **SSL/TLS → Overview → เลือก Full (strict)**

> ลำดับนี้ทำให้ Let's Encrypt ตรวจผ่านง่ายที่สุด และเมื่อเปิดโพร็กซีแล้วใช้ Full (strict) ได้ทันที
> (ทางเลือกอื่น: ใช้ Cloudflare Origin Certificate แล้วใส่ที่ AApanel → SSL/TLS → Full strict)

## ขั้นตอนที่ 6 — ตรวจใช้งานจริง

เปิด `https://saha-rain-watch.example.com`
- KPI/กราฟ/แผนที่ขึ้นครบ, แถบสถานะแหล่งข้อมูลเขียว
- `.../api/kpi` ต้องตอบ JSON
- เปลี่ยน `DASHBOARD_URL` ใน `.env` แล้ว `pm2 restart rain-dashboard` (ข้อความแจ้งเตือน LINE/อีเมลจะแนบลิงก์นี้)

## ความปลอดภัยที่ควรทำ

- **ปิดการเข้าถึง port 8080 จากภายนอก** — ใน firewall ของเซิร์ฟ (AApanel → 安全组/防火墙 หรือ cloud firewall) เปิดเฉพาะ 80/443; 8080 ให้รับเฉพาะ 127.0.0.1
- ตั้ง `INTERNAL_TOKEN` แล้ว — endpoint `/api/internal/*` จะปฏิเสธทุกคำขอที่ไม่มี token ถูกต้อง (หน้าเว็บจะถามรหัสเมื่ออัปโหลด CSV)
- กฎแจ้งเตือน/หน้าเว็บยังไม่มี login — ถ้าต้องการกันบุคคลทั่วไปเข้า ให้เปิด **Basic Auth** ที่ AApanel (เว็บ → ความปลอดภัย/Security → Directory encryption) หรือ Cloudflare Access
- สำรองข้อมูล: โฟลเดอร์ `data/` (ประวัติน้ำฝน + กฎแจ้งเตือน)

## เปิดใช้ LINE / อีเมล / MQTT บนเซิร์ฟ

แก้ `.env` ใน `/www/wwwroot/rain-forcast/rain-dashboard/.env` แล้ว:

```bash
pm2 restart rain-dashboard
```

ทดสอบจากหน้าเว็บ: แผง "ช่องทางแจ้งเตือน" → **ทดสอบส่ง**

## แก้ปัญหาที่พบบ่อย

| อาการ | วิธีแก้ |
|---|---|
| 502 Bad Gateway | PM2 ไม่ได้รัน → `pm2 status`, `pm2 logs rain-dashboard`; ตรวจ reverse proxy ชี้ `127.0.0.1:8080` |
| Let's Encrypt ขอไม่ผ่าน | DNS ยังไม่ชี้/ยังเปิดโพร็กซีอยู่ → ตั้ง DNS only ก่อน รอ 5 นาที แล้วลองใหม่ |
| แผนที่/กราฟไม่ขึ้น | เซิร์ฟออกอินเทอร์เน็ตไม่ได้ (CDN) → ตรวจ firewall/ outbound |
| ข้อมูลย้อนหลังหาย | ดูว่า `data/` ถูกลบ/เปลี่ยน root directory → ชี้กลับที่เดิม |
| ต้องการเปลี่ยนชื่อ subdomain | เพิ่ม A record ใหม่ใน Cloudflare + เพิ่ม domain ใน AApanel แล้วผูก reverse proxy เดิม |
