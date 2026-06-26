const { google } = require('googleapis');
const crypto = require('crypto');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SHEET_NAME = 'tasks';

const COLS = ['id','name','type','deadline','assignee','groupId','createdBy','status','createdAt','updatedAt','doneAt'];

function getAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

async function readRows() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:K`,
  });
  const rows = res.data.values || [];
  return rows.map(row => {
    const obj = {};
    COLS.forEach((col, i) => obj[col] = row[i] || null);
    return obj;
  });
}

async function appendRow(task) {
  const sheets = getSheets();
  const row = COLS.map(col => task[col] || '');
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

async function updateRow(taskId, fields) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:K`,
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex(r => r[0] === taskId);
  if (idx === -1) return null;

  const rowNum = idx + 2;
  const existing = {};
  COLS.forEach((col, i) => existing[col] = rows[idx][i] || null);
  const updated = { ...existing, ...fields };
  const newRow = COLS.map(col => updated[col] || '');

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${rowNum}:K${rowNum}`,
    valueInputOption: 'RAW',
    requestBody: { values: [newRow] },
  });
  return updated;
}

async function deleteRow(taskId) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:K`,
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex(r => r[0] === taskId);
  if (idx === -1) return;

  const rowNum = idx + 2;
  const sheetRes = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = sheetRes.data.sheets.find(s => s.properties.title === SHEET_NAME);
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum },
        },
      }],
    },
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function loadTasks(groupId) {
  const all = await readRows();
  // แสดงทุกงานเสมอ ไม่ filter ตาม groupId
  return all;
}

async function createTask({ name, type, deadline, assignee, groupId, createdBy }) {
  const task = {
    id: crypto.randomUUID(),
    name,
    type,
    deadline,
    assignee,
    groupId,
    createdBy,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    doneAt: '',
  };
  await appendRow(task);
  return task;
}

async function updateTaskStatus(taskId, status) {
  const fields = {
    status,
    updatedAt: new Date().toISOString(),
    ...(status === 'done' ? { doneAt: new Date().toISOString() } : {}),
  };
  return updateRow(taskId, fields);
}

async function deleteTask(taskId) {
  await deleteRow(taskId);
}

async function getStats(groupId) {
  const tasks = await loadTasks(groupId);
  const today = new Date().toISOString().split('T')[0];
  const todayStart = today + 'T00:00:00.000Z';

  return {
    total:     tasks.length,
    pending:   tasks.filter(t => t.status !== 'done').length,
    done:      tasks.filter(t => t.status === 'done').length,
    routine:   tasks.filter(t => t.type === 'routine' && t.status !== 'done').length,
    task:      tasks.filter(t => t.type === 'task' && t.status !== 'done').length,
    overdue:   tasks.filter(t => t.status !== 'done' && t.deadline && t.deadline < today).length,
    doneToday: tasks.filter(t => t.status === 'done' && t.doneAt && t.doneAt >= todayStart).length,
  };
}

// รีเซ็ต Routine ทุกตัวกลับเป็น pending (รันตอนเที่ยงคืน)
async function resetRoutineTasks() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:K`,
  });
  const rows = res.data.values || [];

  const updates = [];
  rows.forEach((row, idx) => {
    const type   = row[2] || '';
    const status = row[7] || '';
    if (type === 'routine' && status === 'done') {
      const rowNum = idx + 2;
      const updated = [...row];
      updated[7] = 'pending';                        // status
      updated[9] = new Date().toISOString();         // updatedAt
      updated[10] = '';                              // doneAt
      updates.push({
        range: `${SHEET_NAME}!A${rowNum}:K${rowNum}`,
        values: [updated],
      });
    }
  });

  if (!updates.length) return 0;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: updates },
  });

  return updates.length;
}

module.exports = { loadTasks, createTask, updateTaskStatus, deleteTask, getStats, resetRoutineTasks };
