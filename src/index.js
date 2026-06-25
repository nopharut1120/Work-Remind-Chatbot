const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { loadTasks, saveTasks, createTask, updateTaskStatus, deleteTask, getStats } = require('./tasks');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const OWNER_USER_ID = process.env.LINE_OWNER_USER_ID; // ไลน์ส่วนตัวของเจ้าของ

const client = new line.Client(config);
const app = express();

// สถานะชั่วคราวของแต่ละ user (รอรับ input หลายขั้นตอน)
const sessions = {};

app.post('/webhook', line.middleware(config), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    try { await handleEvent(event); } catch (e) { console.error(e); }
  }
});

app.get('/', (_, res) => res.send('LINE Task Bot is running ✅'));

// ─── Event Handler ────────────────────────────────────────────────────────────
async function handleEvent(event) {
  const { type, source, replyToken } = event;
  const groupId = source.groupId || source.roomId || null;
  const userId  = source.userId;

  if (type === 'postback') {
    return handlePostback(event, groupId, userId);
  }
  if (type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();

  // ถ้า user อยู่ใน session (กำลังสร้างงาน)
  if (sessions[userId]) {
    return handleSession(event, groupId, userId, text);
  }

  // เมนูหลัก
  if (text === 'เมนู' || text === 'menu' || text === '/menu') {
    return client.replyMessage(replyToken, mainMenu());
  }
  if (text === 'งานทั้งหมด' || text === '/tasks') {
    return client.replyMessage(replyToken, await taskListMessage(groupId));
  }
  if (text === 'สรุป' || text === '/summary') {
    return client.replyMessage(replyToken, await summaryMessage(groupId));
  }
}

// ─── Postback ────────────────────────────────────────────────────────────────
async function handlePostback(event, groupId, userId) {
  const { replyToken, postback } = event;
  const data = new URLSearchParams(postback.data);
  const action = data.get('action');

  if (action === 'new_task') {
    sessions[userId] = { step: 'ask_type', groupId };
    return client.replyMessage(replyToken, askTaskType());
  }

  if (action === 'set_type') {
    const taskType = data.get('type');
    sessions[userId] = { ...sessions[userId], type: taskType, step: 'ask_name' };
    return client.replyMessage(replyToken, {
      type: 'text',
      text: `📝 พิมพ์ *ชื่องาน* ที่ต้องการสร้าง:\n(ประเภท: ${taskType === 'routine' ? '🔄 Routine' : '📌 งานที่ต้องทำ'})`,
    });
  }

  if (action === 'set_deadline') {
    const deadline = data.get('date');
    const sess = sessions[userId] || {};
    sess.deadline = deadline;
    sess.step = 'ask_assignee';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '👤 ระบุชื่อผู้รับผิดชอบ (หรือพิมพ์ "ทีม" ถ้าทำร่วมกัน):',
    });
  }

  if (action === 'done_task') {
    const taskId = data.get('id');
    await updateTaskStatus(taskId, 'done');
    return client.replyMessage(replyToken, {
      type: 'text', text: '✅ อัปเดตงานเสร็จแล้ว!',
    });
  }

  if (action === 'cancel_task') {
    const taskId = data.get('id');
    await deleteTask(taskId);
    return client.replyMessage(replyToken, {
      type: 'text', text: '🗑️ ลบงานแล้ว',
    });
  }

  if (action === 'list_tasks') {
    return client.replyMessage(replyToken, await taskListMessage(groupId));
  }

  if (action === 'summary') {
    return client.replyMessage(replyToken, await summaryMessage(groupId));
  }
}

// ─── Session Flow ─────────────────────────────────────────────────────────────
async function handleSession(event, groupId, userId, text) {
  const { replyToken } = event;
  const sess = sessions[userId];

  if (sess.step === 'ask_name') {
    sess.name = text;
    sess.step = 'ask_deadline';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askDeadline());
  }

  if (sess.step === 'ask_assignee') {
    sess.assignee = text;
    // สร้างงาน
    const task = await createTask({
      name: sess.name,
      type: sess.type,
      deadline: sess.deadline,
      assignee: text,
      groupId: sess.groupId || groupId,
      createdBy: userId,
    });
    delete sessions[userId];
    return client.replyMessage(replyToken, taskCreatedMessage(task));
  }
}

// ─── Messages ─────────────────────────────────────────────────────────────────
function mainMenu() {
  return {
    type: 'flex',
    altText: '📋 เมนูจัดการงาน',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'text', text: '📋 เมนูจัดการงาน',
          weight: 'bold', size: 'xl', color: '#ffffff'
        }],
        backgroundColor: '#185FA5', paddingAll: '16px',
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          menuBtn('➕ สร้างงานใหม่', 'new_task', '#185FA5'),
          menuBtn('📋 ดูงานทั้งหมด', 'list_tasks', '#3B6D11'),
          menuBtn('📊 สรุปสถานะงาน', 'summary', '#7B3FA0'),
        ],
      },
    },
  };
}

function menuBtn(label, action, color) {
  return {
    type: 'button',
    action: { type: 'postback', label, data: `action=${action}` },
    style: 'primary', color, margin: 'sm',
  };
}

function askTaskType() {
  return {
    type: 'flex',
    altText: 'เลือกประเภทงาน',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: 'เลือกประเภทงาน', weight: 'bold', size: 'lg' },
          { type: 'separator', margin: 'sm' },
          {
            type: 'button', style: 'primary', color: '#185FA5',
            action: { type: 'postback', label: '🔄 Routine (งานประจำ)', data: 'action=set_type&type=routine' },
          },
          {
            type: 'button', style: 'primary', color: '#639922', margin: 'sm',
            action: { type: 'postback', label: '📌 งานที่ต้องทำ (One-time)', data: 'action=set_type&type=task' },
          },
        ],
      },
    },
  };
}

function askDeadline() {
  const today = new Date();
  const dates = [0, 1, 3, 7].map(d => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() + d);
    const label = d === 0 ? 'วันนี้' : d === 1 ? 'พรุ่งนี้' : `+${d} วัน`;
    const val = dt.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const iso = dt.toISOString().split('T')[0];
    return { label: `${label} (${val})`, data: `action=set_deadline&date=${iso}` };
  });

  return {
    type: 'flex',
    altText: 'เลือกกำหนดเวลา',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '📅 เลือกกำหนดเวลาเสร็จ', weight: 'bold', size: 'lg' },
          { type: 'separator', margin: 'sm' },
          ...dates.map((d, i) => ({
            type: 'button', style: i === 0 ? 'primary' : 'secondary',
            color: i === 0 ? '#A32D2D' : undefined, margin: 'sm',
            action: { type: 'postback', label: d.label, data: d.data },
          })),
          {
            type: 'text', text: 'หรือพิมพ์วันที่เอง (เช่น 2025-12-31)',
            size: 'xs', color: '#888888', margin: 'md', wrap: true,
          },
        ],
      },
    },
  };
}

function taskCreatedMessage(task) {
  const typeLabel = task.type === 'routine' ? '🔄 Routine' : '📌 งานที่ต้องทำ';
  return {
    type: 'flex',
    altText: `✅ สร้างงาน: ${task.name}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: task.type === 'routine' ? '#185FA5' : '#639922',
        paddingAll: '12px',
        contents: [{ type: 'text', text: '✅ สร้างงานใหม่แล้ว!', color: '#ffffff', weight: 'bold', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          infoRow('📌 ชื่องาน', task.name),
          infoRow('🏷️ ประเภท', typeLabel),
          infoRow('📅 กำหนด', task.deadline),
          infoRow('👤 ผู้รับผิดชอบ', task.assignee),
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          {
            type: 'button', style: 'primary', color: '#639922', flex: 1,
            action: { type: 'postback', label: '✅ เสร็จแล้ว', data: `action=done_task&id=${task.id}` },
          },
          {
            type: 'button', style: 'secondary', flex: 1,
            action: { type: 'postback', label: '🗑️ ลบ', data: `action=cancel_task&id=${task.id}` },
          },
        ],
      },
    },
  };
}

async function taskListMessage(groupId) {
  const tasks = await loadTasks(groupId);
  const pending = tasks.filter(t => t.status !== 'done');

  if (!pending.length) {
    return { type: 'text', text: '🎉 ไม่มีงานค้างอยู่เลย!' };
  }

  const routines = pending.filter(t => t.type === 'routine');
  const onetime  = pending.filter(t => t.type === 'task');

  const makeSection = (title, items, color) => {
    if (!items.length) return [];
    return [
      { type: 'text', text: title, weight: 'bold', color, margin: 'md' },
      ...items.map(t => ({
        type: 'box', layout: 'horizontal', margin: 'sm',
        contents: [
          {
            type: 'box', layout: 'vertical', flex: 1,
            contents: [
              { type: 'text', text: t.name, size: 'sm', weight: 'bold', wrap: true },
              { type: 'text', text: `📅 ${t.deadline}  👤 ${t.assignee}`, size: 'xs', color: '#888888', wrap: true },
            ],
          },
          {
            type: 'button', flex: 0, style: 'primary', color: '#639922',
            action: { type: 'postback', label: '✅', data: `action=done_task&id=${t.id}` },
            height: 'sm',
          },
        ],
      })),
      { type: 'separator', margin: 'md' },
    ];
  };

  return {
    type: 'flex',
    altText: `📋 งานทั้งหมด (${pending.length} รายการ)`,
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#185FA5', paddingAll: '12px',
        contents: [{ type: 'text', text: `📋 งานทั้งหมด (${pending.length} รายการ)`, color: '#ffffff', weight: 'bold', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical',
        contents: [
          ...makeSection('🔄 Routine', routines, '#185FA5'),
          ...makeSection('📌 งานที่ต้องทำ', onetime, '#639922'),
        ],
      },
    },
  };
}

async function summaryMessage(groupId) {
  const stats = await getStats(groupId);
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  return {
    type: 'flex',
    altText: '📊 สรุปสถานะงาน',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#7B3FA0', paddingAll: '12px',
        contents: [{ type: 'text', text: '📊 สรุปสถานะงาน', color: '#ffffff', weight: 'bold', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          infoRow('📌 งานทั้งหมด', `${stats.total} รายการ`),
          infoRow('⏳ ค้างอยู่', `${stats.pending} รายการ`),
          infoRow('✅ เสร็จแล้ว', `${stats.done} รายการ`),
          infoRow('🔄 Routine', `${stats.routine} รายการ`),
          infoRow('📌 One-time', `${stats.task} รายการ`),
          infoRow('🚨 เกินกำหนด', `${stats.overdue} รายการ`),
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: `อัปเดต: ${now}`, size: 'xs', color: '#aaaaaa', margin: 'sm' },
        ],
      },
    },
  };
}

function infoRow(label, value) {
  return {
    type: 'box', layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#666666', flex: 2 },
      { type: 'text', text: String(value), size: 'sm', weight: 'bold', flex: 3, wrap: true },
    ],
  };
}

// ─── Hourly Notification ──────────────────────────────────────────────────────
async function sendHourlyNotification() {
  if (!OWNER_USER_ID) return;
  try {
    // ดึงงานทั้งหมด (ไม่ filter groupId เพราะเป็น personal summary)
    const stats = await getStats(null);
    const tasks = await loadTasks(null);
    const pending = tasks.filter(t => t.status !== 'done');
    const overdue = pending.filter(t => {
      if (!t.deadline) return false;
      return new Date(t.deadline) < new Date(new Date().toISOString().split('T')[0]);
    });

    const now = new Date().toLocaleString('th-TH', {
      timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit',
    });

    const lines = [
      `🔔 อัปเดตงาน เวลา ${now}`,
      `─────────────────`,
      `⏳ งานค้าง: ${stats.pending} รายการ`,
      `✅ เสร็จวันนี้: ${stats.doneToday} รายการ`,
      `🚨 เกินกำหนด: ${stats.overdue} รายการ`,
    ];

    if (overdue.length > 0) {
      lines.push('─────────────────');
      lines.push('🚨 งานที่เกินกำหนด:');
      overdue.slice(0, 5).forEach(t => {
        lines.push(`• ${t.name} (${t.assignee}) — ครบ ${t.deadline}`);
      });
    }

    if (pending.length > 0) {
      lines.push('─────────────────');
      lines.push('📋 งานที่ยังค้างอยู่:');
      pending.slice(0, 5).forEach(t => {
        const icon = t.type === 'routine' ? '🔄' : '📌';
        lines.push(`${icon} ${t.name} (${t.assignee}) — ครบ ${t.deadline}`);
      });
      if (pending.length > 5) lines.push(`... และอีก ${pending.length - 5} รายการ`);
    }

    await client.pushMessage(OWNER_USER_ID, {
      type: 'text', text: lines.join('\n'),
    });

    console.log(`[${now}] Sent hourly notification`);
  } catch (e) {
    console.error('Hourly notification error:', e.message);
  }
}

// ทุกชั่วโมง เวลา :00 น. (07:00–22:00 Bangkok)
cron.schedule('0 0-22 * * *', sendHourlyNotification, { timezone: 'Asia/Bangkok' });

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
