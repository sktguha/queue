// super dumb in-memory queue server
// no dependencies — plain Node http only
// queues are fully dynamic by name: "image_1", "image_2", "data", "whatever"
// any name starting with "image" gets cap 500, everything else gets cap 2000
// each queue is scoped by a clientId (auto-generated if not sent)
// oldest entries get shifted out when cap is hit
//
// cursor: server tracks per client per queue how many items already delivered.
// "latest" returns everything new since last read and advances the cursor.
// if client fell too far behind (evicted), snaps forward and reports droppedCount.

const http = require('http');
const crypto = require('crypto');

const IMAGE_CAP = 500;
const DATA_CAP = 2000;

const store = {};  // store[clientId][queueName] = { items: [], totalPushed: N }
const cursor = {}; // cursor[clientId][queueName] = N already delivered

function newClientId() {
  return crypto.randomBytes(8).toString('hex');
}

function capFor(name) {
  return name.startsWith('image') ? IMAGE_CAP : DATA_CAP;
}

function getQueue(clientId, name) {
  if (!store[clientId]) store[clientId] = {};
  if (!store[clientId][name]) store[clientId][name] = { items: [], totalPushed: 0 };
  return store[clientId][name];
}

function getCursor(clientId, name) {
  if (!cursor[clientId]) cursor[clientId] = {};
  if (cursor[clientId][name] === undefined) cursor[clientId][name] = 0;
  return cursor[clientId][name];
}

function parseQuery(queryString) {
  const q = {};
  if (!queryString) return q;
  for (const pair of queryString.split('&')) {
    const [k, v] = pair.split('=');
    if (k) q[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return q;
}

function json(res, code, data, clientId) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Client-Id': clientId || '',
  });
  res.end(body);
}

http.createServer((req, res) => {
  // preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const [pathPart, queryString] = req.url.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = parseQuery(queryString);

  // expect /queue/:name  or  /queue/:name/latest
  if (parts[0] !== 'queue' || !parts[1]) {
    return json(res, 404, { error: 'not found' });
  }

  const name = parts[1];
  const isLatest = parts[2] === 'latest';
  const method = req.method;

  let clientId = query.clientId || newClientId();

  // ---- PUSH ----
  // POST /queue/:name          body: { id, data }
  // GET  /queue/:name?id=..&data=..
  if (!isLatest && (method === 'POST' || (method === 'GET' && (query.id !== undefined || query.data !== undefined)))) {
    const finish = (body) => {
      const q = getQueue(clientId, name);
      const item = {
        id: body.id !== undefined ? body.id : q.totalPushed,
        data: body.data !== undefined ? body.data : null,
        ts: Date.now(),
        index: q.totalPushed,
      };
      q.items.push(item);
      q.totalPushed += 1;
      while (q.items.length > capFor(name)) q.items.shift();
      json(res, 200, { ok: true, clientId, saved: item, length: q.items.length }, clientId);
    };

    if (method === 'POST') {
      let raw = '';
      req.on('data', chunk => raw += chunk);
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (_) {}
        finish(body);
      });
    } else {
      finish({ id: query.id, data: query.data });
    }
    return;
  }

  // ---- LATEST ----
  // GET /queue/:name/latest?clientId=xyz
  if (isLatest && method === 'GET') {
    const q = getQueue(clientId, name);
    const readSoFar = getCursor(clientId, name);
    const oldestAvailable = Math.max(0, q.totalPushed - q.items.length);

    let droppedCount = 0;
    let startIndex = readSoFar;

    if (readSoFar < oldestAvailable) {
      droppedCount = oldestAvailable - readSoFar;
      startIndex = oldestAvailable;
    }

    const newItems = q.items.slice(startIndex - oldestAvailable);
    cursor[clientId][name] = q.totalPushed;

    return json(res, 200, { clientId, items: newItems, droppedCount, totalPushed: q.totalPushed }, clientId);
  }

  json(res, 404, { error: 'not found' });

}).listen(process.env.PORT || 3000, () => console.log(`dumb queue on :${process.env.PORT || 3000}`));
  
