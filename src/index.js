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

let notifyInterval = 1;
let notifyJob = null;

function startNotifyJob() {
  if (notifyJob) notifyJob.stop();
  let counter = 0;
  notifyJob = cron.schedule('0 7-22 * * *', async () => {
    counter++;
    if (counter % notifyInterval === 0) await sendNotification();
  }, { timezone: 'Asia/Bangkok' });
}

startNotifyJob();

cron.schedule('0 0 * * *', async () => {
  try {
    const count = await resetRoutineTasks();
    console.log(`[Reset] รีเซ็ต Routine ${count} รายการ`);
    if (OWNER_USER_ID && count > 0) {
      await client.pushMessage(OWNER_USER_ID, { type: 'text', text: `🔄 รีเซ็ต Routine ${count} รายการแล้ว พร้อมสำหรับวันใหม่!` });
    }
  } catch (e) { console.error('Reset routine error:', e.message); }
}, { timezone: 'Asia/Bangkok' });

app.post('/webhook', line.middleware(config), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    try { await handleEvent(event); } catch (e) { console.error(e); }
  }
});

app.get('/', (_, res) => res.send('LINE Task Bot is running ✅'));

// ─── Helpers ──────────────────────────────────────────────────────────────────
// [FIX 3] แปลง yyyy-mm-dd → dd-mm-yyyy
function toDisplayDate(dateStr) {
  if (!dateStr) return dateStr;
  const parts = dateStr.split('-');
  if (parts.length === 3 && parts[0].length === 4) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return dateStr;
}
// แปลง dd-mm-yyyy → yyyy-mm-dd สำหรับเก็บข้อมูล
function toISODate(dateStr) {
  if (!dateStr) return dateStr;
  const parts = dateStr.split('-');
  if (parts.length === 3 && parts[0].length === 2) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return dateStr;
}

function statusLabel(status) {
  if (status === 'inprogress') return '🔄 กำลังดำเนินการ';
  if (status === 'done') return '✅ เสร็จแล้ว';
  return '⏸ ยังไม่ดำเนินการ';
}

// ─── Event Handler ────────────────────────────────────────────────────────────
async function handleEvent(event) {
  const { type, source, replyToken } = event;
  const groupId = source.groupId || source.roomId || null;
  const userId  = source.userId;

  if (type === 'postback') return handlePostback(event, groupId, userId);
  if (type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();

  // [FIX 1] @ mention — ตัด @ชื่อbot ออกแล้วเช็ค
  const cleanText = text.replace(/@\S+/g, '').trim();

  if (sessions[userId]) return handleSession(event, groupId, userId, cleanText || text);

  // [FIX 1] ถ้า @ mention หรือพิมพ์เมนู ให้แสดงเมนู
  const isMention = event.message.mention?.mentionees?.some(m => m.type === 'user') || text.startsWith('@');
  if (isMention && !cleanText) return client.replyMessage(replyToken, mainMenu());

  if (cleanText === 'เมนู' || cleanText === 'menu' || cleanText === '/menu') {
    return client.replyMessage(replyToken, mainMenu());
  }
  if (cleanText === 'งานทั้งหมด' || cleanText === '/tasks') {
    return client.replyMessage(replyToken, await taskListMessage(groupId));
  }
  if (cleanText === 'สรุป' || cleanText === '/summary') {
    return client.replyMessage(replyToken, await summaryMessage(groupId));
  }
}

// ─── Postback ────────────────────────────────────────────────────────────────
async function handlePostback(event, groupId, userId) {
  const { replyToken, postback } = event;
  const data = new URLSearchParams(postback.data);
  const action = data.get('action');

  if (action === 'menu') {
    delete sessions[userId];
    return client.replyMessage(replyToken, mainMenu());
  }

  if (action === 'new_task') {
    sessions[userId] = { step: 'ask_type', groupId };
    return client.replyMessage(replyToken, askTaskType());
  }

  if (action === 'set_type') {
    const taskType = data.get('type');
    sessions[userId] = { ...sessions[userId], type: taskType, step: 'ask_name' };
    return client.replyMessage(replyToken, {
      type: 'text',
      text: `📝 พิมพ์ชื่องานที่ต้องการสร้าง:\n(ประเภท: ${taskType === 'routine' ? '🔄 Routine (ทำทุกวัน)' : '📌 งานที่ต้องทำ'})\n\nพิมพ์ "ยกเลิก" เพื่อกลับเมนูหลัก`,
    });
  }

  if (action === 'set_deadline_date') {
    const date = data.get('date');
    const sess = sessions[userId] || {};
    sess.deadlineDate = date;
    sess.step = 'ask_time';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askTime());
  }

  if (action === 'set_deadline_time') {
    const time = data.get('time');
    const sess = sessions[userId] || {};
    sess.deadline = `${toDisplayDate(sess.deadlineDate)} ${time}`;
    sess.step = 'ask_assignee';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askAssignee());
  }

  if (action === 'back_to_type') {
    sessions[userId] = { step: 'ask_type', groupId };
    return client.replyMessage(replyToken, askTaskType());
  }

  if (action === 'back_to_name') {
    const sess = sessions[userId] || {};
    sess.step = 'ask_name';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, {
      type: 'text',
      text: `📝 พิมพ์ชื่องานใหม่:\nพิมพ์ "ยกเลิก" เพื่อกลับเมนูหลัก`,
    });
  }

  if (action === 'back_to_deadline') {
    const sess = sessions[userId] || {};
    sess.step = 'ask_deadline';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askDeadlineDate());
  }

  if (action === 'back_to_time') {
    const sess = sessions[userId] || {};
    sess.step = 'ask_time';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askTime());
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

  if (action === 'notify_settings') {
    return client.replyMessage(replyToken, notifySettingsMenu());
  }

  if (action === 'set_notify') {
    const interval = parseInt(data.get('interval'));
    notifyInterval = interval;
    startNotifyJob();
    const label = interval === 99 ? 'ปิด' : `ทุก ${interval} ชั่วโมง`;
    return client.replyMessage(replyToken, { type: 'text', text: `🔔 ตั้งการแจ้งเตือน: ${label} แล้วครับ` });
  }

  // [FIX 2] อัปเดตสถานะงาน
  if (action === 'update_status_list') {
    return client.replyMessage(replyToken, await updateStatusListMessage(groupId));
  }

  if (action === 'pick_status') {
    const taskId = data.get('id');
    const taskName = data.get('name');
    return client.replyMessage(replyToken, pickStatusMessage(taskId, taskName));
  }

  if (action === 'set_status') {
    const taskId = data.get('id');
    const status = data.get('status');
    await updateTaskStatus(taskId, status);
    return client.replyMessage(replyToken, { type: 'text', text: `อัปเดตสถานะเป็น ${statusLabel(status)} แล้วครับ` });
  }
}

// ─── Session Flow ─────────────────────────────────────────────────────────────
async function handleSession(event, groupId, userId, text) {
  const { replyToken } = event;
  const sess = sessions[userId];

  // [FIX 4] ยกเลิกกลับเมนูหลัก
  if (text === 'ยกเลิก') {
    delete sessions[userId];
    return client.replyMessage(replyToken, mainMenu());
  }

  if (sess.step === 'ask_name') {
    sess.name = text;
    sessions[userId] = sess;

    if (sess.type === 'routine') {
      sess.deadline = 'ทุกวัน';
      sess.step = 'ask_assignee';
      sessions[userId] = sess;
      return client.replyMessage(replyToken, askAssignee('back_to_name'));
    }

    sess.step = 'ask_deadline';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askDeadlineDate());
  }

  // [FIX 3] รับวันที่พิมพ์เอง format dd-mm-yyyy
  if (sess.step === 'ask_deadline') {
    sess.deadlineDate = toISODate(text);
    sess.step = 'ask_time';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askTime());
  }

  if (sess.step === 'ask_time') {
    sess.deadline = `${toDisplayDate(sess.deadlineDate)} ${text}`;
    sess.step = 'ask_assignee';
    sessions[userId] = sess;
    return client.replyMessage(replyToken, askAssignee('back_to_time'));
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
          menuBtn('🔃 อัปเดตสถานะงาน', 'update_status_list', '#B07D00'),
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

function backBtn(action, label = '◀️ ย้อนกลับ') {
  return {
    type: 'button', style: 'secondary', margin: 'md',
    action: { type: 'postback', label, data: `action=${action}` },
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
          { type: 'button', style: 'primary', color: '#185FA5', action: { type: 'postback', label: '🔄 Routine (ทำทุกวัน)', data: 'action=set_type&type=routine' } },
          { type: 'button', style: 'primary', color: '#639922', margin: 'sm', action: { type: 'postback', label: '📌 งานที่ต้องทำ (มีกำหนด)', data: 'action=set_type&type=task' } },
          backBtn('menu', '◀️ กลับเมนูหลัก'),
        ],
      },
    },
  };
}

// [FIX 3] ปุ่มวันแสดงเป็น dd-mm-yyyy
function askDeadlineDate() {
  const today = new Date();
  const dates = [0, 1, 3, 7].map(d => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() + d);
    const label = d === 0 ? 'วันนี้' : d === 1 ? 'พรุ่งนี้' : `+${d} วัน`;
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();
    const display = `${dd}-${mm}-${yyyy}`;
    const iso = `${yyyy}-${mm}-${dd}`;
    return { label: `${label} (${display})`, data: `action=set_deadline_date&date=${iso}` };
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
          { type: 'text', text: 'หรือพิมพ์วันที่เอง (เช่น 31-12-2026)', size: 'xs', color: '#888888', margin: 'md', wrap: true },
          backBtn('back_to_name'),
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
            contents: times.slice(0, 3).map(t => ({ type: 'button', style: 'secondary', flex: 1, action: { type: 'postback', label: t, data: `action=set_deadline_time&time=${t}` } })),
          },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
            contents: times.slice(3).map(t => ({ type: 'button', style: 'secondary', flex: 1, action: { type: 'postback', label: t, data: `action=set_deadline_time&time=${t}` } })),
          },
          { type: 'text', text: 'หรือพิมพ์เวลาเอง (เช่น 14:30)', size: 'xs', color: '#888888', margin: 'md', wrap: true },
          backBtn('back_to_deadline'),
        ],
      },
    },
  };
}

function askAssignee(backAction = 'back_to_time') {
  return {
    type: 'flex',
    altText: 'ระบุผู้รับผิดชอบ',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '👤 ระบุผู้รับผิดชอบ', weight: 'bold', size: 'lg' },
          { type: 'text', text: 'พิมพ์ชื่อผู้รับผิดชอบ หรือ "ทีม" ถ้าทำร่วมกัน', size: 'sm', color: '#666666', wrap: true },
          backBtn(backAction),
        ],
      },
    },
  };
}

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
          { type: 'text', text: `ความถี่ปัจจุบัน: ${notifyInterval === 99 ? 'ปิด' : 'ทุก ' + notifyInterval + ' ชั่วโมง'}`, size: 'sm', color: '#666666', margin: 'sm' },
          { type: 'separator', margin: 'sm' },
          ...options.map(o => ({
            type: 'button',
            style: notifyInterval === o.interval ? 'primary' : 'secondary',
            color: notifyInterval === o.interval ? '#A32D2D' : undefined,
            margin: 'sm',
            action: { type: 'postback', label: o.label, data: `action=set_notify&interval=${o.interval}` },
          })),
          backBtn('menu', '◀️ กลับเมนูหลัก'),
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

// [FIX 2] รายการงานสำหรับเลือกอัปเดตสถานะ
async function updateStatusListMessage(groupId) {
  const tasks = await loadTasks(groupId);
  const active = tasks.filter(t => t.status !== 'done');
  if (!active.length) return { type: 'text', text: '🎉 ไม่มีงานที่ต้องอัปเดตสถานะ!' };

  const statusIcon = s => s === 'inprogress' ? '🔄' : '⏸';

  return {
    type: 'flex',
    altText: 'เลือกงานที่ต้องการอัปเดตสถานะ',
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#B07D00', paddingAll: '12px',
        contents: [{ type: 'text', text: '🔃 เลือกงานที่ต้องการอัปเดต', color: '#ffffff', weight: 'bold', size: 'lg' }],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: active.slice(0, 10).map(t => ({
          type: 'button', style: 'secondary', margin: 'sm',
          action: {
            type: 'postback',
            label: `${statusIcon(t.status)} ${t.name.substring(0, 30)}`,
            data: `action=pick_status&id=${t.id}&name=${encodeURIComponent(t.name.substring(0, 20))}`,
          },
        })),
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [backBtn('menu', '◀️ กลับเมนูหลัก')],
      },
    },
  };
}

// [FIX 2] เลือกสถานะของงานนั้น
function pickStatusMessage(taskId, taskName) {
  return {
    type: 'flex',
    altText: `เลือกสถานะของ: ${taskName}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#B07D00', paddingAll: '12px',
        contents: [
          { type: 'text', text: '🔃 เลือกสถานะ', color: '#ffffff', weight: 'bold', size: 'lg' },
          { type: 'text', text: decodeURIComponent(taskName), color: '#ffe0a0', size: 'sm', wrap: true },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'secondary', margin: 'sm', action: { type: 'postback', label: '⏸ ยังไม่ดำเนินการ', data: `action=set_status&id=${taskId}&status=pending` } },
          { type: 'button', style: 'primary', color: '#185FA5', margin: 'sm', action: { type: 'postback', label: '🔄 กำลังดำเนินการ', data: `action=set_status&id=${taskId}&status=inprogress` } },
          { type: 'button', style: 'primary', color: '#639922', margin: 'sm', action: { type: 'postback', label: '✅ เสร็จแล้ว', data: `action=set_status&id=${taskId}&status=done` } },
          backBtn('update_status_list', '◀️ กลับรายการงาน'),
        ],
      },
    },
  };
}

async function taskListMessage(groupId) {
  const tasks = await loadTasks(groupId);
  const pending = tasks.filter(t => t.status !== 'done');
  if (!pending.length) return { type: 'text', text: '🎉 ไม่มีงานที่ยังเหลืออยู่เลย!' };

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
              { type: 'text', text: `${statusLabel(t.status)}  📅 ${t.deadline}  👤 ${t.assignee}`, size: 'xs', color: '#888888', wrap: true },
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
          infoRow('⏳ ที่ยังเหลือ', `${stats.pending} รายการ`),
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
  if (notifyInterval === 99) return;
  try {
    const stats = await getStats(null);
    const tasks = await loadTasks(null);
    const pending = tasks.filter(t => t.status !== 'done');
    const overdue = pending.filter(t => t.deadline && t.deadline.split(' ')[0] < new Date().toISOString().split('T')[0]);
    const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });

    // [FIX 5] เปลี่ยน "งานค้าง" เป็น "งานที่ยังเหลือ"
    const lines = [
      `🔔 อัปเดตงาน เวลา ${now}`,
      `⏳ งานที่ยังเหลือ: ${stats.pending} รายการ`,
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
