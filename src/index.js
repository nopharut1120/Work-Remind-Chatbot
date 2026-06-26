const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { loadTasks, createTask, updateTaskStatus, deleteTask, getStats, resetRoutineTasks } = require('./tasks');
 
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const OWNER_USER_ID = process.env.LINE_OWNER_USER_ID;
const GROUP_ID = process.env.LINE_GROUP_ID;
 
const client = new line.Client(config);
const app = express();
 
const sessions = {};
 
// ความถี่การแจ้งเตือน (ชั่วโมง) — เปลี่ยนได้ผ่านเมนู
let notifyInterval = 1; // default ทุก 1 ชั่วโมง
let notifyJob = null;
 
function startNotifyJob() {
  if (notifyJob) notifyJob.stop();
  // รัน cron ทุกชั่วโมง แล้วเช็คเองว่าถึงรอบแจ้งเตือนหรือยัง
  let counter = 0;
  notifyJob = cron.schedule('0 7-22 * * *', async () => {
    counter++;
    if (counter % notifyInterval === 0) {
      await sendNotification();
    }
  }, { timezone: 'Asia/Bangkok' });
}
 
startNotifyJob();
 
// รีเซ็ต Routine ทุกวัน เที่ยงคืน (00:00 Bangkok)
cron.schedule('0 0 * * *', async () => {
  try {
    const count = await resetRoutineTasks();
    console.log(`[Reset] รีเซ็ต Routine ${count} รายการ`);
    if (OWNER_USER_ID && count > 0) {
      await client.pushMessage(OWNER_USER_ID, {
        type: 'text',
        text: `🔄 รีเซ็ต Routine ${count} รายการแล้ว พร้อมสำหรับวันใหม่!`,
      });
    }
  } catch (e) {
    console.error('Reset routine error:', e.message);
  }
}, { timezone: 'Asia/Bangkok' });
 
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
 
  if (sessions[userId]) {
    return handleSession(event, groupId, userId, text);
  }
 
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
      text: `📝 พิมพ์ชื่องานที่ต้องการสร้าง:\n(ประเภท: ${taskType === 'routine' ? '🔄 Routine (ทำทุกวัน)' : '📌 งานที่ต้องทำ'})`,
    });
  }
 
  // [FIX 2] รับวันที่แล้วไปถามเวลา
  if (action === 'set_deadline_date') {
    const date = data.get('date');
    const sess = sessions[userId] || {};
    sess.deadlineDate = date;
    sess.step = 'ask_time';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askTime());
  }
 
  // [FIX 2] รับเวลาแล้วไปถามผู้รับผิดชอบ
  if (action === 'set_deadline_time') {
    const time = data.get('time');
    const sess = sessions[userId] || {};
    sess.deadline = `${sess.deadlineDate} ${time}`;
    sess.step = 'ask_assignee';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '👤 ระบุชื่อผู้รับผิดชอบ (หรือพิมพ์ "ทีม" ถ้าทำร่วมกัน):',
    });
  }
 
  // [FIX 1] Routine ไม่มี deadline ข้ามไปถามผู้รับผิดชอบเลย
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
    return client.replyMessage(replyToken, { type: 'text', text: '✅ อัปเดตงานเสร็จแล้ว!' });
  }
 
  if (action === 'cancel_task') {
    const taskId = data.get('id');
    await deleteTask(taskId);
    return client.replyMessage(replyToken, { type: 'text', text: '🗑️ ลบงานแล้ว' });
  }
 
  if (action === 'list_tasks') {
    return client.replyMessage(replyToken, await taskListMessage(groupId));
  }
 
  if (action === 'summary') {
    return client.replyMessage(replyToken, await summaryMessage(groupId));
  }
 
  // [FIX 3] ตั้งความถี่แจ้งเตือน
  if (action === 'notify_settings') {
    return client.replyMessage(replyToken, notifySettingsMenu());
  }
 
  if (action === 'set_notify') {
    const interval = parseInt(data.get('interval'));
    notifyInterval = interval;
    startNotifyJob();
    const label = interval === 1 ? 'ทุก 1 ชั่วโมง' : `ทุก ${interval} ชั่วโมง`;
    return client.replyMessage(replyToken, {
      type: 'text', text: `🔔 ตั้งการแจ้งเตือน: ${label} แล้วครับ`,
    });
  }
}
 
// ─── Session Flow ─────────────────────────────────────────────────────────────
async function handleSession(event, groupId, userId, text) {
  const { replyToken } = event;
  const sess = sessions[userId];
 
  if (sess.step === 'ask_name') {
    sess.name = text;
    sessions[userId] = sess;
 
    // [FIX 1] ถ้าเป็น Routine ข้ามไปถามผู้รับผิดชอบเลย ไม่ต้องถาม deadline
    if (sess.type === 'routine') {
      sess.deadline = 'ทุกวัน';
      sess.step = 'ask_assignee';
      sessions[userId] = sess;
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '👤 ระบุชื่อผู้รับผิดชอบ (หรือพิมพ์ "ทีม" ถ้าทำร่วมกัน):',
      });
    }
 
    // งาน One-time ถามวันกำหนดส่ง
    sess.step = 'ask_deadline';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askDeadlineDate());
  }
 
  // [FIX 2] รับวันที่พิมพ์เอง แล้วไปถามเวลา
  if (sess.step === 'ask_deadline') {
    sess.deadlineDate = text;
    sess.step = 'ask_time';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askTime());
  }
 
  // [FIX 2] รับเวลาพิมพ์เอง
  if (sess.step === 'ask_time') {
    sess.deadline = `${sess.deadlineDate} ${text}`;
    sess.step = 'ask_assignee';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '👤 ระบุชื่อผู้รับผิดชอบ (หรือพิมพ์ "ทีม" ถ้าทำร่วมกัน):',
    });
  }
 
  if (sess.step === 'ask_assignee') {
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
 
// ─── UI Messages ──────────────────────────────────────────────────────────────
function mainMenu() {
  return {
    type: 'flex',
    altText: '📋 เมนูจัดการงาน',
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#185FA5', paddingAll: '16px',
        contents: [{ type: 'text', text: '📋 เมนูจัดการงาน', weight: 'bold', size: 'xl', color: '#ffffff' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          menuBtn('➕ สร้างงานใหม่', 'new_task', '#185FA5'),
          menuBtn('📋 ดูงานทั้งหมด', 'list_tasks', '#3B6D11'),
          menuBtn('📊 สรุปสถานะงาน', 'summary', '#7B3FA0'),
          menuBtn('🔔 ตั้งค่าการแจ้งเตือน', 'notify_settings', '#A32D2D'),
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
            action: { type: 'postback', label: '🔄 Routine (ทำทุกวัน)', data: 'action=set_type&type=routine' },
          },
          {
            type: 'button', style: 'primary', color: '#639922', margin: 'sm',
            action: { type: 'postback', label: '📌 งานที่ต้องทำ (มีกำหนด)', data: 'action=set_type&type=task' },
          },
        ],
      },
    },
  };
}
 
// [FIX 2] แยกเป็น askDeadlineDate และ askTime
function askDeadlineDate() {
  const today = new Date();
  const dates = [0, 1, 3, 7].map(d => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() + d);
    const label = d === 0 ? 'วันนี้' : d === 1 ? 'พรุ่งนี้' : `+${d} วัน`;
    const val = dt.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const iso = dt.toISOString().split('T')[0];
    return { label: `${label} (${val})`, data: `action=set_deadline_date&date=${iso}` };
  });
 
  return {
    type: 'flex',
    altText: 'เลือกวันกำหนดส่ง',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '📅 เลือกวันกำหนดส่ง', weight: 'bold', size: 'lg' },
          { type: 'separator', margin: 'sm' },
          ...dates.map((d, i) => ({
            type: 'button', style: i === 0 ? 'primary' : 'secondary',
            color: i === 0 ? '#A32D2D' : undefined, margin: 'sm',
            action: { type: 'postback', label: d.label, data: d.data },
          })),
          { type: 'text', text: 'หรือพิมพ์วันที่เอง (เช่น 2026-12-31)', size: 'xs', color: '#888888', margin: 'md', wrap: true },
        ],
      },
    },
  };
}
 
function askTime() {
  const times = ['08:00', '09:00', '12:00', '17:00', '18:00', '20:00'];
  return {
    type: 'flex',
    altText: 'เลือกเวลากำหนดส่ง',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '🕐 เลือกเวลากำหนดส่ง', weight: 'bold', size: 'lg' },
          { type: 'separator', margin: 'sm' },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
            contents: times.slice(0, 3).map(t => ({
              type: 'button', style: 'secondary', flex: 1,
              action: { type: 'postback', label: t, data: `action=set_deadline_time&time=${t}` },
            })),
          },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
            contents: times.slice(3).map(t => ({
              type: 'button', style: 'secondary', flex: 1,
              action: { type: 'postback', label: t, data: `action=set_deadline_time&time=${t}` },
            })),
          },
          { type: 'text', text: 'หรือพิมพ์เวลาเอง (เช่น 14:30)', size: 'xs', color: '#888888', margin: 'md', wrap: true },
        ],
      },
    },
  };
}
 
// [FIX 3] เมนูตั้งค่าความถี่แจ้งเตือน
function notifySettingsMenu() {
  const options = [
    { label: '🔔 ทุก 1 ชั่วโมง', interval: 1 },
    { label: '🔔 ทุก 2 ชั่วโมง', interval: 2 },
    { label: '🔔 ทุก 3 ชั่วโมง', interval: 3 },
    { label: '🔕 ปิดการแจ้งเตือน', interval: 99 },
  ];
  return {
    type: 'flex',
    altText: 'ตั้งค่าการแจ้งเตือน',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#A32D2D', paddingAll: '12px',
        contents: [{ type: 'text', text: '🔔 ตั้งค่าการแจ้งเตือน', color: '#ffffff', weight: 'bold', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: `ความถี่ปัจจุบัน: ทุก ${notifyInterval === 99 ? 'ปิด' : notifyInterval + ' ชั่วโมง'}`, size: 'sm', color: '#666666', margin: 'sm' },
          { type: 'separator', margin: 'sm' },
          ...options.map(o => ({
            type: 'button',
            style: notifyInterval === o.interval ? 'primary' : 'secondary',
            color: notifyInterval === o.interval ? '#A32D2D' : undefined,
            margin: 'sm',
            action: { type: 'postback', label: o.label, data: `action=set_notify&interval=${o.interval}` },
          })),
        ],
      },
    },
  };
}
 
function taskCreatedMessage(task) {
  const typeLabel = task.type === 'routine' ? '🔄 Routine (ทุกวัน)' : '📌 งานที่ต้องทำ';
  return {
    type: 'flex',
    altText: `✅ สร้างงาน: ${task.name}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: task.type === 'routine' ? '#185FA5' : '#639922', paddingAll: '12px',
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
          { type: 'button', style: 'primary', color: '#639922', flex: 1, action: { type: 'postback', label: '✅ เสร็จแล้ว', data: `action=done_task&id=${task.id}` } },
          { type: 'button', style: 'secondary', flex: 1, action: { type: 'postback', label: '🗑️ ลบ', data: `action=cancel_task&id=${task.id}` } },
        ],
      },
    },
  };
}
 
async function taskListMessage(groupId) {
  const tasks = await loadTasks(groupId);
  const pending = tasks.filter(t => t.status !== 'done');
  if (!pending.length) return { type: 'text', text: '🎉 ไม่มีงานค้างอยู่เลย!' };
 
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
          { type: 'button', flex: 0, style: 'primary', color: '#639922', height: 'sm', action: { type: 'postback', label: '✅', data: `action=done_task&id=${t.id}` } },
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
 
// ─── Notification ─────────────────────────────────────────────────────────────
async function sendNotification() {
  if (!OWNER_USER_ID || notifyInterval === 99) return;
  try {
    const stats = await getStats(null);
    const tasks = await loadTasks(null);
    const pending = tasks.filter(t => t.status !== 'done');
    const overdue = pending.filter(t => t.deadline && t.deadline.split(' ')[0] < new Date().toISOString().split('T')[0]);
    const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
 
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
      overdue.slice(0, 5).forEach(t => lines.push(`• ${t.name} (${t.assignee}) — ครบ ${t.deadline}`));
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
 
    const msg = { type: 'text', text: lines.join('\n') };
    if (OWNER_USER_ID) await client.pushMessage(OWNER_USER_ID, msg);
    if (GROUP_ID) await client.pushMessage(GROUP_ID, msg);
    console.log(`[${now}] Sent notification`);
  } catch (e) {
    console.error('Notification error:', e.message);
  }
}
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
 
