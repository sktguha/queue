// super dumb in-memory queue server
// queues are fully dynamic by name: "image_1", "image_2", "data", "whatever"
// any name starting with "image" gets cap 500, everything else gets cap 2000
// each queue is scoped by a clientId (auto-generated if not sent)
// oldest entries get shifted out when cap is hit (array push/shift)
//
// cursor: server remembers, per client per queue, how many items it has
// already handed back. "latest" returns everything new since last read
// and moves the cursor forward. if the client fell behind further than
// the cap (their stuff got evicted), we just snap them back to current
// end and tell them so, instead of silently hiding the gap.

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '25mb' })); // images as base64 can be big-ish

const IMAGE_CAP = 500;
const DATA_CAP = 2000;

// store[clientId][queueName] = { items: [...], totalPushed: N }
const store = {};
// cursor[clientId][queueName] = totalPushed count already delivered
const cursor = {};

function newClientId() {
  return crypto.randomBytes(8).toString('hex');
}

function capFor(queueName) {
  return queueName.startsWith('image') ? IMAGE_CAP : DATA_CAP;
}

function getQueue(clientId, queueName) {
  if (!store[clientId]) store[clientId] = {};
  if (!store[clientId][queueName]) {
    store[clientId][queueName] = { items: [], totalPushed: 0 };
  }
  return store[clientId][queueName];
}

function getCursor(clientId, queueName) {
  if (!cursor[clientId]) cursor[clientId] = {};
  if (cursor[clientId][queueName] === undefined) cursor[clientId][queueName] = 0;
  return cursor[clientId][queueName];
}

function resolveClientId(req, res) {
  let clientId = req.query.clientId;
  if (!clientId) clientId = newClientId();
  res.set('X-Client-Id', clientId); // so caller can grab it even on first call
  return clientId;
}

// push item: POST /queue/:name?clientId=xyz  body: { id, data }
app.post('/queue/:name', (req, res) => {
  const { name } = req.params;
  const clientId = resolveClientId(req, res);
  const q = getQueue(clientId, name);

  const item = {
    id: req.body?.id ?? q.totalPushed,
    data: req.body?.data,
    ts: Date.now(),
    index: q.totalPushed, // position in this queue's overall sequence (0-based, never reused)
  };
  q.items.push(item);
  q.totalPushed += 1;

  const cap = capFor(name);
  while (q.items.length > cap) q.items.shift();

  res.json({ ok: true, clientId, saved: item, length: q.items.length });
});

// get latest (new-since-last-read): GET /queue/:name/latest?clientId=xyz
app.get('/queue/:name/latest', (req, res) => {
  const { name } = req.params;
  const clientId = resolveClientId(req, res);
  const q = getQueue(clientId, name);
  const cap = capFor(name);

  const readSoFar = getCursor(clientId, name);
  const oldestAvailableIndex = Math.max(0, q.totalPushed - q.items.length);

  let droppedCount = 0;
  let startIndex = readSoFar;

  // edge case: client fell behind further than the cap, their unread
  // items already got evicted. snap forward instead of hiding it.
  if (readSoFar < oldestAvailableIndex) {
    droppedCount = oldestAvailableIndex - readSoFar;
    startIndex = oldestAvailableIndex;
  }

  const sliceStart = startIndex - oldestAvailableIndex; // index within q.items
  const newItems = q.items.slice(sliceStart);

  cursor[clientId][name] = q.totalPushed; // advance cursor to current end

  res.json({
    clientId,
    items: newItems,
    droppedCount, // >0 means client was behind and lost some items to cap eviction
    totalPushed: q.totalPushed,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`dumb queue server on :${PORT}`));
      
