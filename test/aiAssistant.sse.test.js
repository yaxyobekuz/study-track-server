const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { formatSseFrame, createSseChannel } = require("../src/controllers/aiAssistant.controller");

/** `res` ning SSE uchun kerakli qismi. */
function fakeResponse() {
  const res = new EventEmitter();
  res.headers = {};
  res.chunks = [];
  res.statusCode = null;
  res.flushed = false;
  res.writableEnded = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (key, value) => {
    res.headers[key] = value;
  };
  res.flushHeaders = () => {
    res.flushed = true;
  };
  res.write = (chunk) => {
    res.chunks.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
    res.writableFinished = true;
    res.emit("close");
  };
  return res;
}

/** Oddiy SSE parser (frontend ham xuddi shunday o'qiydi). */
function parseFrames(raw) {
  return raw
    .split("\n\n")
    .filter((block) => block && !block.startsWith(":"))
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: ")).slice(7);
      const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
      assert.equal(data.length, 1, "data doim bitta qator");
      return { event, data: JSON.parse(data[0]) };
    });
}

test("formatSseFrame: event + bitta qatorli data + bo'sh qator", () => {
  const frame = formatSseFrame("delta", { text: "### Umumiy holat\n- 1\n\n| a | b |" });
  assert.equal(frame.endsWith("\n\n"), true);
  const [head, data, ...rest] = frame.split("\n");
  assert.equal(head, "event: delta");
  assert.ok(data.startsWith("data: "));
  assert.deepEqual(rest, ["", ""]);
  assert.deepEqual(JSON.parse(data.slice(6)), { text: "### Umumiy holat\n- 1\n\n| a | b |" });
});

test("formatSseFrame: bo'sh ma'lumot {} bo'ladi, noto'g'ri hodisa nomi rad etiladi", () => {
  assert.equal(formatSseFrame("done"), "event: done\ndata: {}\n\n");
  assert.throws(() => formatSseFrame("bad\nname", {}));
  assert.throws(() => formatSseFrame("", {}));
});

test("createSseChannel: sarlavhalar, kadrlar tartibi va oxirida doim done", () => {
  const res = fakeResponse();
  const channel = createSseChannel(res, { heartbeatMs: 60000 });
  assert.equal(channel.send("status", { phase: "thinking" }), false, "ochilmasdan yozilmaydi");

  channel.open();
  assert.equal(res.statusCode, 200);
  assert.equal(res.flushed, true);
  assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["Cache-Control"], "no-cache, no-transform");
  assert.equal(res.headers["X-Accel-Buffering"], "no");
  assert.equal(res.headers.Connection, "keep-alive");

  channel.send("status", { phase: "thinking", label: "Tahlil qilinmoqda" });
  channel.send("delta", { text: "Salom" });
  channel.end();
  channel.end();

  const frames = parseFrames(res.chunks.join(""));
  assert.deepEqual(
    frames.map((f) => f.event),
    ["status", "delta", "done"],
  );
  assert.equal(res.writableEnded, true);
  assert.equal(channel.send("delta", { text: "kech" }), false, "yopilgandan keyin yozilmaydi");
});

test("createSseChannel: yurak urishi izoh kadri sifatida ketadi", async () => {
  const res = fakeResponse();
  const channel = createSseChannel(res, { heartbeatMs: 10 });
  channel.open();
  await new Promise((resolve) => setTimeout(resolve, 35));
  channel.end();
  assert.ok(res.chunks.includes(": ping\n\n"));
  assert.deepEqual(parseFrames(res.chunks.join("")).map((f) => f.event), ["done"]);
});

test("createSseChannel: mijoz uzilsa listener chaqiriladi, oddiy tugashda chaqirilmaydi", () => {
  const aborted = fakeResponse();
  const abortChannel = createSseChannel(aborted, { heartbeatMs: 60000 });
  let abortCalls = 0;
  abortChannel.onClientClose(() => {
    abortCalls += 1;
  });
  abortChannel.open();
  aborted.destroyed = true;
  aborted.emit("close");
  assert.equal(abortCalls, 1);
  assert.equal(abortChannel.send("delta", { text: "x" }), false, "uzilgan soketga yozilmaydi");
  abortChannel.end();

  const finished = fakeResponse();
  const finishChannel = createSseChannel(finished, { heartbeatMs: 60000 });
  let finishCalls = 0;
  finishChannel.onClientClose(() => {
    finishCalls += 1;
  });
  finishChannel.open();
  finishChannel.end();
  assert.equal(finishCalls, 0);
});

test("createSseChannel: tinglovchi qo'yilishidan oldin uzilgan ulanish ham darhol aniqlanadi", () => {
  // `close` hodisasi suhbat o'qilayotganda (await) o'tib ketgan — qayta chiqmaydi.
  const res = fakeResponse();
  res.destroyed = true;
  const channel = createSseChannel(res, { heartbeatMs: 60000 });
  let calls = 0;
  channel.onClientClose(() => {
    calls += 1;
  });
  assert.equal(calls, 1);
  channel.open();
  assert.equal(channel.send("delta", { text: "x" }), false);
  assert.doesNotThrow(() => channel.end());
});

test("createSseChannel: yozishda xato otilsa kanal jim false qaytaradi", () => {
  const res = fakeResponse();
  res.write = () => {
    throw new Error("EPIPE");
  };
  const channel = createSseChannel(res, { heartbeatMs: 60000 });
  channel.open();
  assert.equal(channel.send("delta", { text: "x" }), false);
  assert.doesNotThrow(() => channel.end());
});
