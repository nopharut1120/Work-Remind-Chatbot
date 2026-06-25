# 📋 LINE Task Bot — คู่มือติดตั้ง

Bot จัดการงานในกลุ่ม LINE พร้อมแจ้งเตือนส่วนตัวทุกชั่วโมง

---

## ✨ ฟีเจอร์

- ➕ สร้างงานใหม่ (Routine / งานที่ต้องทำ)
- 📅 กำหนดกำหนดเวลา + ผู้รับผิดชอบ
- ✅ อัปเดตสถานะงานเสร็จ
- 📋 ดูรายการงานทั้งหมด
- 📊 สรุปสถานะงาน
- 🔔 แจ้งเตือนส่วนตัวทุกชั่วโมง (07:00–22:00)

---

## 🚀 ขั้นตอนติดตั้ง

### ขั้นตอนที่ 1 — สร้าง LINE Bot

1. ไปที่ [developers.line.biz](https://developers.line.biz)
2. Login > Create Provider (ถ้ายังไม่มี)
3. Create Channel > **Messaging API**
4. ตั้งชื่อ Bot ตามต้องการ
5. ไปที่แท็บ **Messaging API**:
   - เปิด **Allow bot to join group chats**
   - ปิด **Auto-reply messages**
   - ปิด **Greeting messages**
6. Copy **Channel Secret** (แท็บ Basic settings)
7. กด **Issue** Channel Access Token (แท็บ Messaging API) แล้ว Copy

---

### ขั้นตอนที่ 2 — Deploy บน Render (ฟรี)

1. ไปที่ [render.com](https://render.com) > Sign Up ด้วย GitHub
2. Push โค้ดนี้ขึ้น GitHub repo ก่อน:
   ```bash
   git init
   git add .
   git commit -m "LINE Task Bot"
   git remote add origin https://github.com/YOUR_USER/line-task-bot.git
   git push -u origin main
   ```
3. Render > **New Web Service** > Connect GitHub repo
4. ตั้งค่า:
   - **Build Command**: `npm install`
   - **Start Command**: `node src/index.js`
   - **Instance Type**: Free
5. เพิ่ม Environment Variables:
   ```
   LINE_CHANNEL_ACCESS_TOKEN = (จากขั้นตอน 1)
   LINE_CHANNEL_SECRET       = (จากขั้นตอน 1)
   LINE_OWNER_USER_ID        = (หาวิธีด้านล่าง)
   ```
6. กด **Create Web Service** รอ Deploy เสร็จ (2-3 นาที)
7. Copy URL เช่น `https://line-task-bot.onrender.com`

---

### ขั้นตอนที่ 3 — ตั้ง Webhook

1. กลับไป LINE Developers Console > แท็บ Messaging API
2. **Webhook URL**: `https://line-task-bot.onrender.com/webhook`
3. กด **Verify** → ต้องขึ้น Success
4. เปิด **Use webhook**: ON

---

### ขั้นตอนที่ 4 — หา LINE User ID ของคุณ

1. เพิ่ม Bot เป็นเพื่อน (QR Code อยู่ใน LINE Developers Console)
2. ส่งข้อความ "เมนู" ให้ Bot
3. ดู Server Log ใน Render > **Logs** จะเห็น `userId: Uxxxxxxxx...`
4. Copy userId นั้นมาใส่ใน `LINE_OWNER_USER_ID`
5. กด **Save** แล้วรอ Redeploy

---

### ขั้นตอนที่ 5 — เพิ่ม Bot เข้ากลุ่ม

1. เปิดกลุ่ม LINE > เพิ่มสมาชิก
2. ค้นหา Bot ด้วย QR Code หรือ LINE ID
3. พิมพ์ "เมนู" ในกลุ่ม → Bot จะตอบกลับ 🎉

---

## 💬 คำสั่งที่ใช้ได้

| พิมพ์ | ผล |
|-------|-----|
| `เมนู` หรือ `menu` | เปิดเมนูหลัก |
| `งานทั้งหมด` | ดูรายการงานค้าง |
| `สรุป` | ดูสถานะภาพรวม |

---

## 🔔 การแจ้งเตือน

Bot จะส่งสรุปงานไปยัง LINE ส่วนตัวของเจ้าของ **ทุกชั่วโมง** ตั้งแต่ 07:00–22:00 น. โดยแสดง:
- จำนวนงานค้าง
- งานที่เกินกำหนด
- งานที่เสร็จวันนี้

---

## ⚠️ หมายเหตุ Render Free Tier

Render Free จะ sleep หลังไม่มี request 15 นาที ทำให้แจ้งเตือนอาจช้า 1-2 นาทีแรก
แก้ไขได้โดยใช้ [UptimeRobot](https://uptimerobot.com) ping URL ทุก 10 นาทีฟรี

**URL ที่ต้อง ping**: `https://YOUR_APP.onrender.com/`
