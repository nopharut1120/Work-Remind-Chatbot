const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '../data/tasks.json');

async function readData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeData(tasks) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(tasks, null, 2));
}

async function loadTasks(groupId) {
  const all = await readData();
  if (!groupId) return all; // ถ้าไม่ระบุ groupId ให้ return ทั้งหมด
  return all.filter(t => t.groupId === groupId);
}

async function createTask({ name, type, deadline, assignee, groupId, createdBy }) {
  const tasks = await readData();
  const task = {
    id: crypto.randomUUID(),
    name,
    type,         // 'routine' | 'task'
    deadline,     // 'YYYY-MM-DD'
    assignee,
    groupId,
    createdBy,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    doneAt: null,
  };
  tasks.push(task);
  await writeData(tasks);
  return task;
}

async function updateTaskStatus(taskId, status) {
  const tasks = await readData();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return null;
  tasks[idx].status = status;
  tasks[idx].updatedAt = new Date().toISOString();
  if (status === 'done') tasks[idx].doneAt = new Date().toISOString();
  await writeData(tasks);
  return tasks[idx];
}

async function deleteTask(taskId) {
  let tasks = await readData();
  tasks = tasks.filter(t => t.id !== taskId);
  await writeData(tasks);
}

async function getStats(groupId) {
  const tasks = await loadTasks(groupId);
  const today = new Date().toISOString().split('T')[0];
  const todayStart = today + 'T00:00:00.000Z';

  const total   = tasks.length;
  const pending = tasks.filter(t => t.status !== 'done').length;
  const done    = tasks.filter(t => t.status === 'done').length;
  const routine = tasks.filter(t => t.type === 'routine' && t.status !== 'done').length;
  const task    = tasks.filter(t => t.type === 'task' && t.status !== 'done').length;
  const overdue = tasks.filter(t =>
    t.status !== 'done' && t.deadline && t.deadline < today
  ).length;
  const doneToday = tasks.filter(t =>
    t.status === 'done' && t.doneAt && t.doneAt >= todayStart
  ).length;

  return { total, pending, done, routine, task, overdue, doneToday };
}

module.exports = { loadTasks, createTask, updateTaskStatus, deleteTask, getStats };
