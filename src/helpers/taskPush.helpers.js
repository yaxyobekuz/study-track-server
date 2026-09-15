/**
 * TOPSHIRIQ PUSH XABARI — matn va `data` ni quradi (sof funksiya).
 *
 * Xodimga to'rt hodisada push boradi:
 *   created   — yangi topshiriq berildi
 *   rejected  — bajarilgan ish rad etildi (`pending_rejected`)
 *   stopped   — topshiriq to'xtatildi
 *   completed — topshiriq muvaffaqiyatli yakunlandi (tasdiqlandi)
 *
 * ⚠️ `data` MOBIL ILOVA BILAN SHARTNOMA: ilova bosilgan bildirishnomadan
 * `taskId` bo'yicha topshiriq sahifasini ochadi. Kalitlarni o'zgartirish
 * ilovani ham yangilashni talab qiladi.
 */

const { formatDateTimeUz } = require("./date.helpers");

const TASK_PUSH_EVENTS = Object.freeze({
  CREATED: "created",
  REJECTED: "rejected",
  STOPPED: "stopped",
  COMPLETED: "completed",
});

// Android kanali — mobil ilova shu id bilan kanal yaratadi.
const TASK_PUSH_CHANNEL = "tasks";

const TITLES = {
  [TASK_PUSH_EVENTS.CREATED]: "Yangi topshiriq",
  [TASK_PUSH_EVENTS.REJECTED]: "Topshiriq rad etildi",
  [TASK_PUSH_EVENTS.STOPPED]: "Topshiriq to'xtatildi",
  [TASK_PUSH_EVENTS.COMPLETED]: "Topshiriq muvaffaqiyatli yakunlandi",
};

const truncate = (text, max) => {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/**
 * @param {string} event - TASK_PUSH_EVENTS qiymati
 * @param {{ id: string, title: string, status: string, dueDate: Date }} task - YANGILANGAN topshiriq
 * @param {{ reason?: string, penaltyPoints?: number, deadlineChanged?: boolean, branchId?: string }} [extra]
 * @returns {{ title: string, body: string, data: object, channelId: string }}
 */
function buildTaskPush(event, task, extra = {}) {
  if (!TITLES[event]) throw new Error(`Noma'lum topshiriq hodisasi: ${event}`);

  const { reason, penaltyPoints, deadlineChanged, branchId } = extra;
  const lines = [truncate(task.title, 120)];

  if (event === TASK_PUSH_EVENTS.CREATED || deadlineChanged) {
    const label = event === TASK_PUSH_EVENTS.CREATED ? "Muddat" : "Yangi muddat";
    lines.push(`${label}: ${formatDateTimeUz(task.dueDate)}`);
  }
  if (reason && event !== TASK_PUSH_EVENTS.CREATED) {
    const label = event === TASK_PUSH_EVENTS.COMPLETED ? "Izoh" : "Sabab";
    lines.push(`${label}: ${truncate(reason, 120)}`);
  }
  if (penaltyPoints > 0) {
    lines.push(`Jarima: ${penaltyPoints} ball`);
  }

  return {
    title: TITLES[event],
    body: lines.join("\n"),
    channelId: TASK_PUSH_CHANNEL,
    data: {
      type: "task",
      event,
      taskId: task.id,
      status: task.status,
      branchId,
    },
  };
}

module.exports = { TASK_PUSH_EVENTS, TASK_PUSH_CHANNEL, buildTaskPush };
