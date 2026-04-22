// ============================================================
// SUGARUSH ORDER PIPELINE — Google Apps Script
// Deploy as Web App: Execute as Me, Access: Anyone
// ============================================================

const SHEET_NAMES = {
  ORDERS:   'Orders',
  TODAY:    'Today',
  UPCOMING: 'Upcoming',
  HISTORY:  'History',
  BRIEFING: 'DailyBriefing',
};

// ============================================================
// ENTRY POINT — Web App doPost
// ============================================================
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action  = payload.action;

    let result;
    if      (action === 'addOrder')      result = addOrder(payload);
    else if (action === 'markComplete')  result = markComplete(payload);
    else if (action === 'getToday')      result = getToday();
    else if (action === 'getUpcoming')   result = getUpcoming();
    else if (action === 'getDashboard')  result = getDashboard();
    else throw new Error('Unknown action: ' + action);

    return jsonResponse({ ok: true, ...result });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function doGet(e) {
  const action = e.parameter.action || 'getDashboard';
  try {
    let result;
    if      (action === 'getToday')    result = getToday();
    else if (action === 'getUpcoming') result = getUpcoming();
    else if (action === 'getDashboard') result = getDashboard();
    else throw new Error('Unknown action: ' + action);
    return jsonResponse({ ok: true, ...result });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// ACTION: addOrder
// ============================================================
function addOrder(payload) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const orders  = ss.getSheetByName(SHEET_NAMES.ORDERS);

  // Recalculate priority server-side (source of truth)
  const score = serverCalcScore(payload);
  const tier  = scoreTier(score);

  const row = [
    payload.orderId,
    payload.createdAt,
    payload.adminName,
    payload.customer.name,
    payload.customer.phone,
    payload.metode,
    payload.address || '',
    payload.deadline,
    JSON.stringify(payload.items),
    payload.kitchenNote || '',
    payload.barNote || '',
    tier,
    score,
    'active',   // status
    '',         // completedAt
    '',         // crewName
  ];

  orders.appendRow(row);
  syncTodayUpcoming();

  return { orderId: payload.orderId, tier, score };
}

// ============================================================
// ACTION: markComplete
// ============================================================
function markComplete(payload) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const orders  = ss.getSheetByName(SHEET_NAMES.ORDERS);
  const history = ss.getSheetByName(SHEET_NAMES.HISTORY);

  const data = orders.getDataRange().getValues();
  const headers = data[0];
  const idCol   = headers.indexOf('orderId');
  const statusCol = headers.indexOf('status');
  const completedAtCol = headers.indexOf('completedAt');
  const crewCol = headers.indexOf('crewName');

  let found = false;
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === payload.orderId) {
      const now = new Date().toISOString();
      orders.getRange(i + 1, statusCol + 1).setValue('done');
      orders.getRange(i + 1, completedAtCol + 1).setValue(now);
      orders.getRange(i + 1, crewCol + 1).setValue(payload.crewName || '');

      // Log to History
      history.appendRow([
        payload.orderId,
        data[i][headers.indexOf('customer')],
        data[i][headers.indexOf('deadline')],
        data[i][headers.indexOf('priorityTier')],
        now,
        payload.crewName || '',
        data[i][headers.indexOf('items')],
      ]);

      found = true;
      break;
    }
  }

  syncTodayUpcoming();
  return { found, orderId: payload.orderId };
}

// ============================================================
// ACTION: getToday — returns sorted active orders for today
// ============================================================
function getToday() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const orders = ss.getSheetByName(SHEET_NAMES.ORDERS);
  const data   = orders.getDataRange().getValues();
  const headers = data[0];

  const todayStr = Utilities.formatDate(new Date(), 'Asia/Makassar', 'yyyy-MM-dd');

  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const status = row[headers.indexOf('status')];
    if (status === 'done') continue;

    const deadline = row[headers.indexOf('deadline')];
    const deadlineStr = deadline ? deadline.toString().substring(0, 10) : '';
    if (deadlineStr !== todayStr) continue;

    // Recalc live score
    const score = serverCalcScore(rowToPayload(headers, row));
    const tier  = scoreTier(score);

    rows.push({
      orderId:      row[headers.indexOf('orderId')],
      createdAt:    row[headers.indexOf('createdAt')],
      adminName:    row[headers.indexOf('adminName')],
      customer:     { name: row[headers.indexOf('customer')], phone: row[headers.indexOf('phone')] },
      metode:       row[headers.indexOf('metode')],
      address:      row[headers.indexOf('address')],
      deadline:     row[headers.indexOf('deadline')],
      items:        safeParseJSON(row[headers.indexOf('items')]),
      kitchenNote:  row[headers.indexOf('kitchenNote')],
      barNote:      row[headers.indexOf('barNote')],
      status:       row[headers.indexOf('status')],
      priorityTier: tier,
      priorityScore: score,
    });
  }

  // Sort by score descending (highest priority first)
  rows.sort((a, b) => b.priorityScore - a.priorityScore);

  // Also count done today
  let doneToday = 0;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const completedAt = row[headers.indexOf('completedAt')];
    if (!completedAt) continue;
    const completedStr = completedAt.toString().substring(0, 10);
    if (completedStr === todayStr && row[headers.indexOf('status')] === 'done') doneToday++;
  }

  return { orders: rows, doneToday };
}

// ============================================================
// ACTION: getUpcoming — next 7 days (not today)
// ============================================================
function getUpcoming() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const orders = ss.getSheetByName(SHEET_NAMES.ORDERS);
  const data   = orders.getDataRange().getValues();
  const headers = data[0];

  const now      = new Date();
  const todayStr = Utilities.formatDate(now, 'Asia/Makassar', 'yyyy-MM-dd');
  const limit    = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const status = row[headers.indexOf('status')];
    if (status === 'done') continue;

    const deadline = row[headers.indexOf('deadline')];
    if (!deadline) continue;
    const deadlineDate = new Date(deadline);
    const deadlineStr  = deadline.toString().substring(0, 10);

    if (deadlineStr === todayStr) continue;
    if (deadlineDate > limit)    continue;

    rows.push({
      orderId:   row[headers.indexOf('orderId')],
      customer:  { name: row[headers.indexOf('customer')], phone: row[headers.indexOf('phone')] },
      metode:    row[headers.indexOf('metode')],
      deadline:  deadline,
      items:     safeParseJSON(row[headers.indexOf('items')]),
      status:    row[headers.indexOf('status')],
    });
  }

  rows.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  return { upcoming: rows };
}

// ============================================================
// ACTION: getDashboard — combined summary
// ============================================================
function getDashboard() {
  const today    = getToday();
  const upcoming = getUpcoming();

  const now      = new Date();
  const todayStr = Utilities.formatDate(now, 'Asia/Makassar', 'yyyy-MM-dd');

  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const orders = ss.getSheetByName(SHEET_NAMES.ORDERS);
  const data   = orders.getDataRange().getValues();
  const headers = data[0];

  let doneToday = 0;
  let activeToday = today.orders.length;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const completedAt = row[headers.indexOf('completedAt')];
    if (!completedAt) continue;
    const completedStr = completedAt.toString().substring(0, 10);
    if (completedStr === todayStr && row[headers.indexOf('status')] === 'done') doneToday++;
  }

  return {
    today:    today.orders,
    upcoming: upcoming.upcoming,
    stats: {
      activeToday,
      doneToday,
      upcomingCount: upcoming.upcoming.length,
      lastSync: now.toISOString(),
    },
  };
}

// ============================================================
// PRIORITY ENGINE — mirrors admin-form & kitchen-display
// ============================================================
function serverCalcScore(payload) {
  const now      = new Date();
  const deadline = new Date(payload.deadline);
  const diffMin  = (deadline - now) / 60000;

  // Early-morning rule
  const deadlineStr = Utilities.formatDate(deadline, 'Asia/Makassar', 'yyyy-MM-dd');
  const tomorrowStr = Utilities.formatDate(
    new Date(now.getTime() + 24 * 60 * 60 * 1000), 'Asia/Makassar', 'yyyy-MM-dd'
  );
  const deadlineHour = deadline.getHours();
  const nowHour      = now.getHours();

  let effectiveMin = diffMin;

  // Penalties
  if (payload.metode === 'delivery')          effectiveMin -= 20;
  const items = payload.items || [];
  const uniqueCount = items.length;
  if (uniqueCount >= 6)       effectiveMin -= 30;
  else if (uniqueCount >= 3)  effectiveMin -= 15;
  if (payload.kitchenNote && payload.kitchenNote.trim()) effectiveMin -= 10;
  const totalQty = items.reduce((s, it) => s + (it.qty || 1), 0);
  if (totalQty > 5)           effectiveMin -= 10;

  // Early-morning override
  if (
    deadlineStr === tomorrowStr &&
    deadlineHour >= 8 && deadlineHour < 10 &&
    nowHour >= 19
  ) {
    effectiveMin = 150; // force TINGGI band
  }

  return Math.round(effectiveMin);
}

function scoreTier(score) {
  if (score < 90)  return 'urgent';
  if (score < 240) return 'tinggi';
  if (score < 330) return 'normal';
  return 'santai';
}

// ============================================================
// SYNC — write Today & Upcoming sheets (for Cowork/briefing)
// ============================================================
function syncTodayUpcoming() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Today sheet
  const todaySheet = ss.getSheetByName(SHEET_NAMES.TODAY);
  todaySheet.clearContents();
  const todayData = getToday();
  if (todayData.orders.length === 0) {
    todaySheet.appendRow(['Tidak ada order aktif hari ini.']);
  } else {
    todaySheet.appendRow(['orderId','customer','deadline','metode','items','kitchenNote','barNote','tier','score','status']);
    todayData.orders.forEach(o => {
      todaySheet.appendRow([
        o.orderId, o.customer.name, o.deadline, o.metode,
        JSON.stringify(o.items), o.kitchenNote, o.barNote,
        o.priorityTier, o.priorityScore, o.status,
      ]);
    });
  }

  // Upcoming sheet
  const upcomingSheet = ss.getSheetByName(SHEET_NAMES.UPCOMING);
  upcomingSheet.clearContents();
  const upcomingData = getUpcoming();
  if (upcomingData.upcoming.length === 0) {
    upcomingSheet.appendRow(['Tidak ada order upcoming.']);
  } else {
    upcomingSheet.appendRow(['orderId','customer','deadline','metode','items','status']);
    upcomingData.upcoming.forEach(o => {
      upcomingSheet.appendRow([
        o.orderId, o.customer.name, o.deadline, o.metode,
        JSON.stringify(o.items), o.status,
      ]);
    });
  }

  // Update DailyBriefing
  writeDailyBriefing(todayData, upcomingData);
}

// ============================================================
// DAILY BRIEFING — for Cowork 07:00
// ============================================================
function writeDailyBriefing(todayData, upcomingData) {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const sheet    = ss.getSheetByName(SHEET_NAMES.BRIEFING);
  const now      = new Date();
  const dateStr  = Utilities.formatDate(now, 'Asia/Makassar', 'EEEE, dd MMMM yyyy');

  sheet.clearContents();

  const lines = [];
  lines.push(['=== SUGARUSH DAILY BRIEFING ===']);
  lines.push([dateStr]);
  lines.push(['']);
  lines.push(['ORDER AKTIF HARI INI: ' + todayData.orders.length]);

  todayData.orders.forEach((o, idx) => {
    const itemStr = (o.items || []).map(it => `${it.name} ×${it.qty}`).join(', ');
    lines.push([`${idx+1}. [${o.priorityTier.toUpperCase()}] ${o.orderId} — ${o.customer.name} — ${itemStr} — deadline ${o.deadline}`]);
    if (o.kitchenNote) lines.push([`   🔥 Kitchen: ${o.kitchenNote}`]);
    if (o.barNote)     lines.push([`   🎀 Bar: ${o.barNote}`]);
  });

  lines.push(['']);
  lines.push(['UPCOMING 7 HARI: ' + upcomingData.upcoming.length]);
  upcomingData.upcoming.forEach((o, idx) => {
    const itemStr = (o.items || []).map(it => `${it.name} ×${it.qty}`).join(', ');
    lines.push([`${idx+1}. ${o.orderId} — ${o.customer.name} — ${itemStr} — deadline ${o.deadline}`]);
  });

  lines.push(['']);
  lines.push(['Last sync: ' + now.toISOString()]);

  lines.forEach(l => sheet.appendRow(l));
}

// ============================================================
// CLEANUP — midnight reset (trigger: Day timer 00:00–01:00)
// ============================================================
function cleanupMidnight() {
  syncTodayUpcoming();
  // Optional: archive very old orders (>30 days) from Orders sheet
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const orders = ss.getSheetByName(SHEET_NAMES.ORDERS);
  const data   = orders.getDataRange().getValues();
  const headers = data[0];
  const statusCol = headers.indexOf('status');
  const deadlineCol = headers.indexOf('deadline');
  const cutoff    = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Delete from bottom to preserve row indices
  for (let i = data.length - 1; i >= 1; i--) {
    if (
      data[i][statusCol] === 'done' &&
      new Date(data[i][deadlineCol]) < cutoff
    ) {
      orders.deleteRow(i + 1);
    }
  }
}

// ============================================================
// SETUP — run once after paste
// ============================================================
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const configs = [
    {
      name: SHEET_NAMES.ORDERS,
      headers: ['orderId','createdAt','adminName','customer','phone','metode','address',
                'deadline','items','kitchenNote','barNote','priorityTier','priorityScore',
                'status','completedAt','crewName'],
    },
    {
      name: SHEET_NAMES.TODAY,
      headers: ['orderId','customer','deadline','metode','items','kitchenNote','barNote',
                'tier','score','status'],
    },
    {
      name: SHEET_NAMES.UPCOMING,
      headers: ['orderId','customer','deadline','metode','items','status'],
    },
    {
      name: SHEET_NAMES.HISTORY,
      headers: ['orderId','customer','deadline','priorityTier','completedAt','crewName','items'],
    },
    {
      name: SHEET_NAMES.BRIEFING,
      headers: ['briefing'],
    },
  ];

  configs.forEach(cfg => {
    let sheet = ss.getSheetByName(cfg.name);
    if (!sheet) sheet = ss.insertSheet(cfg.name);
    sheet.clearContents();
    sheet.appendRow(cfg.headers);
    sheet.getRange(1, 1, 1, cfg.headers.length)
         .setFontWeight('bold')
         .setBackground('#f5e6d3');
  });

  SpreadsheetApp.getUi().alert('✅ Sugarush sheets berhasil di-setup! Sekarang deploy sebagai Web App.');
}

// ============================================================
// HELPERS
// ============================================================
function rowToPayload(headers, row) {
  return {
    orderId:     row[headers.indexOf('orderId')],
    deadline:    row[headers.indexOf('deadline')],
    metode:      row[headers.indexOf('metode')],
    items:       safeParseJSON(row[headers.indexOf('items')]),
    kitchenNote: row[headers.indexOf('kitchenNote')],
    barNote:     row[headers.indexOf('barNote')],
  };
}

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return []; }
}
