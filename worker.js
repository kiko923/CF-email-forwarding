// ==========================================
// 0. 共享配置与工具
// ==========================================
const DURATION_OPTIONS = [
  { value: '1', label: '1 小时' },
  { value: '8', label: '8 小时' },
  { value: '24', label: '24 小时' },
  { value: '48', label: '48 小时' },
  { value: '72', label: '72 小时' },
  { value: '168', label: '168 小时' },
  { value: 'permanent', label: '永久' }
];

const DURATION_VALUES = new Set(DURATION_OPTIONS.map((i) => i.value));
const BOOLEAN_CONFIG_KEYS = new Set(['allow_registration', 'enable_invitation_code', 'enable_random_inbox']);
const DURATION_CONFIG_KEYS = new Set(['max_destination_duration_hours', 'max_route_duration_hours']);
const WILDCARD_PREFIX = '*';
const ROUTE_PREFIX_RE = /^[a-z0-9._+-]{1,64}$/;
const RANDOM_INBOX_PREFIX_RE = /^[a-z0-9]{8,32}$/;
const RANDOM_INBOX_TOKEN_RE = /^[A-Za-z0-9_-]{24,128}$/;
const RANDOM_INBOX_MAX_RAW_CHARS = 1200000;
const RANDOM_INBOX_MAX_BODY_CHARS = 500000;

const DEFAULT_CONFIGS = [
  ['max_users', '1000'],
  ['max_routes_per_user', '10'],
  ['max_total_destinations', '180'],
  ['max_regs_per_ip_24h', '1'],
  ['unverified_user_expiry_hours', '24'],
  ['pending_dest_expiry_hours', '24'],
  ['allowed_countries', 'ALL'],
  ['allow_registration', 'true'],
  ['enable_invitation_code', 'false'],
  ['enable_random_inbox', 'false'],
  ['random_inbox_domain', ''],
  ['max_destination_duration_hours', '168'],
  ['max_route_duration_hours', '72']
];

let schemaReady = false;

const durationRank = (value) => value === 'permanent' ? Number.POSITIVE_INFINITY : parseInt(value, 10);
const isValidDuration = (value) => DURATION_VALUES.has(String(value));
const isWithinMaxDuration = (value, maxValue) => durationRank(String(value)) <= durationRank(String(maxValue || 'permanent'));
const sqlDateFromMs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const expiryFromDuration = (durationHours) => durationHours === 'permanent' ? null : sqlDateFromMs(Date.now() + parseInt(durationHours, 10) * 3600000);
const dbDateMs = (value) => {
  if (!value) return null;
  const raw = String(value);
  return Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
};
const minExpiry = (a, b) => {
  if (!a) return b || null;
  if (!b) return a || null;
  return dbDateMs(a) <= dbDateMs(b) ? a : b;
};

const randomString = (length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
};

const normalizeEmailAddress = (value) => {
  const match = String(value || '').trim().toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}/i);
  return match ? match[0].toLowerCase() : '';
};

const normalizeRandomInboxPrefix = (value) => {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
  return RANDOM_INBOX_PREFIX_RE.test(clean) ? clean : randomString(12);
};

const randomInboxIsEnabled = (cfg) => cfg.enable_random_inbox === 'true' && isValidDomainName(normalizeDomain(cfg.random_inbox_domain));
const isRandomInboxRecipient = (cfg, value) => {
  const email = normalizeEmailAddress(value);
  return randomInboxIsEnabled(cfg) && !!email && email.endsWith('@' + normalizeDomain(cfg.random_inbox_domain));
};

const readEmailRaw = async (message) => {
  try {
    if (!message.raw) return '';
    return (await new Response(message.raw).text()).slice(0, RANDOM_INBOX_MAX_RAW_CHARS);
  } catch (_) {
    return '';
  }
};

const getRawHeader = (raw, name) => {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(raw || '').match(new RegExp('^' + escaped + ':\\s*([\\s\\S]*?)(?=\\r?\\n[^\\s]|\\r?\\n\\r?\\n|$)', 'im'));
  return match ? match[1].replace(/\r?\n[\t ]+/g, ' ').trim() : '';
};

const decodeMimeHeader = (value) => String(value || '').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (all, charset, mode, data) => {
  try {
    let binary = '';
    if (String(mode).toUpperCase() === 'B') {
      binary = atob(String(data).replace(/\s/g, ''));
    } else {
      binary = String(data)
        .replace(/_/g, ' ')
        .replace(/=([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const enc = String(charset || '').toLowerCase();
    return new TextDecoder(enc.includes('gb') ? 'gb18030' : 'utf-8').decode(bytes);
  } catch (_) {
    return all;
  }
});

const decodeBytesToText = (bytes, charset = 'utf-8') => {
  const enc = String(charset || 'utf-8').toLowerCase();
  try {
    if (enc.includes('gb')) return new TextDecoder('gb18030').decode(bytes);
    return new TextDecoder(enc || 'utf-8').decode(bytes);
  } catch (_) {
    return new TextDecoder('utf-8').decode(bytes);
  }
};

const decodeBase64Text = (value, charset) => {
  try {
    const binary = atob(String(value || '').replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return decodeBytesToText(bytes, charset);
  } catch (_) {
    return String(value || '');
  }
};

const decodeQuotedPrintableText = (value, charset) => {
  try {
    const normalized = String(value || '').replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < normalized.length; i++) {
      if (normalized[i] === '=' && /^[0-9a-fA-F]{2}$/.test(normalized.slice(i + 1, i + 3))) {
        bytes.push(parseInt(normalized.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(normalized.charCodeAt(i));
      }
    }
    return decodeBytesToText(new Uint8Array(bytes), charset);
  } catch (_) {
    return String(value || '');
  }
};

const parseHeaderBlock = (value) => {
  const headers = {};
  String(value || '').replace(/\r?\n[\t ]+/g, ' ').split(/\r?\n/).forEach((line) => {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
  });
  return headers;
};

const getHeaderParam = (header, name) => {
  const match = String(header || '').match(new RegExp(`${name}="?([^";]+)"?`, 'i'));
  return match ? match[1].trim() : '';
};

const decodeMimePartBody = (body, headers) => {
  const charset = getHeaderParam(headers['content-type'], 'charset') || 'utf-8';
  const transfer = String(headers['content-transfer-encoding'] || '').toLowerCase();
  if (transfer.includes('base64')) return decodeBase64Text(body, charset);
  if (transfer.includes('quoted-printable')) return decodeQuotedPrintableText(body, charset);
  return String(body || '').trim();
};

const cleanContentId = (value) => String(value || '').trim().replace(/^</, '').replace(/>$/, '');
const cleanBase64Value = (value) => String(value || '').replace(/\s/g, '');
const cleanMimeType = (value) => String(value || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
const hasMalformedInlineImage = (html) => /src=(["'])data:image\/[^"']*;\s*name=/i.test(String(html || ''));

const walkMimeParts = (raw, parentHeaders = {}) => {
  const split = String(raw || '').split(/\r?\n\r?\n/);
  const headerText = split.shift() || '';
  const headers = {...parentHeaders, ...parseHeaderBlock(headerText)};
  const body = split.join('\n\n');
  const contentType = String(headers['content-type'] || '').toLowerCase();
  const boundary = getHeaderParam(headers['content-type'], 'boundary');

  if (contentType.includes('multipart/') && boundary) {
    const marker = '--' + boundary;
    return body.split(marker)
      .map((part) => part.replace(/^\r?\n/, '').replace(/\r?\n--\s*$/, '').trim())
      .filter((part) => part && part !== '--')
      .flatMap((part) => walkMimeParts(part, {}));
  }

  return [{
    contentType,
    contentId: cleanContentId(headers['content-id']),
    transferEncoding: String(headers['content-transfer-encoding'] || '').toLowerCase(),
    rawBody: body,
    text: decodeMimePartBody(body, headers)
  }];
};

const sanitizeEmailHTML = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
  .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
  .replace(/javascript:/gi, '');

const inlineCidImages = (html, parts) => {
  let out = String(html || '');
  const images = parts.filter((part) => part.contentId && part.contentType.startsWith('image/'));
  for (const image of images) {
    const data = image.transferEncoding.includes('base64')
      ? cleanBase64Value(image.rawBody)
      : cleanBase64Value(btoa(image.rawBody || ''));
    if (!data) continue;
    const cid = image.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dataUrl = `data:${cleanMimeType(image.contentType)};base64,${data}`;
    out = out.replace(new RegExp(`cid:${cid}`, 'gi'), dataUrl);
  }
  return out;
};

const extractEmailBodies = (raw) => {
  const parts = walkMimeParts(raw);
  const plain = parts.find((part) => part.contentType.includes('text/plain'));
  const html = parts.find((part) => part.contentType.includes('text/html'));
  const fallback = parts.find((part) => part.text);
  const renderedHtml = inlineCidImages(html?.text || '', parts);
  return {
    text: String((plain || fallback)?.text || '').slice(0, RANDOM_INBOX_MAX_BODY_CHARS),
    html: sanitizeEmailHTML(renderedHtml).slice(0, RANDOM_INBOX_MAX_BODY_CHARS)
  };
};

const looksLikeRawMimeText = (value) => /Content-Type:|Content-Transfer-Encoding:|This is a multi-part message|^-{2,}[=_A-Za-z0-9-]+/im.test(String(value || ''));

const ensureSystem = async (db) => {
  if (schemaReady) return;

  await db.prepare("CREATE TABLE IF NOT EXISTS invitation_codes (code TEXT PRIMARY KEY, max_uses INTEGER NOT NULL, used_count INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS random_inboxes (token TEXT PRIMARY KEY, prefix TEXT NOT NULL, email TEXT NOT NULL UNIQUE, domain TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS random_inbox_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, inbox_email TEXT NOT NULL, message_id TEXT, from_email TEXT, to_email TEXT NOT NULL, subject TEXT, text TEXT, html TEXT, raw TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS mail_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, mail_type TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT, from_email TEXT, to_email TEXT NOT NULL, destination_email TEXT, subject TEXT, text TEXT, html TEXT, raw TEXT, route_id INTEGER, user_id INTEGER, error TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_random_inboxes_email ON random_inboxes(email)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_random_inbox_messages_email_created ON random_inbox_messages(inbox_email, created_at DESC)").run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_random_inbox_messages_unique ON random_inbox_messages(inbox_email, message_id)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_mail_logs_created ON mail_logs(created_at DESC)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_mail_logs_type_created ON mail_logs(mail_type, created_at DESC)").run();

  for (const [key, value] of DEFAULT_CONFIGS) {
    await db.prepare("INSERT OR IGNORE INTO sys_config (key, value) VALUES (?, ?)").bind(key, value).run();
  }
  await db.prepare("DELETE FROM sys_config WHERE key='expired_data_retention_days'").run();

  try { await db.prepare("ALTER TABLE user_destinations ADD COLUMN duration_hours TEXT").run(); } catch (_) {}
  try { await db.prepare("ALTER TABLE email_routes ADD COLUMN duration_hours TEXT").run(); } catch (_) {}
  try { await db.prepare("ALTER TABLE random_inbox_messages ADD COLUMN html TEXT").run(); } catch (_) {}

  schemaReady = true;
};

const getConfigMap = async (db) => {
  const rows = (await db.prepare("SELECT key, value FROM sys_config").all()).results || [];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
};

const getPendingExpiryHours = (cfg) => {
  const hours = parseInt(cfg.pending_dest_expiry_hours || '24', 10);
  return Number.isFinite(hours) && hours > 0 ? hours : 24;
};

const expireLocalForUser = async (db, env, userId, cfg) => {
  await db.prepare("DELETE FROM email_routes WHERE user_id=? AND status='expired'").bind(userId).run();
  await db.prepare("DELETE FROM user_destinations WHERE user_id=? AND status='expired'").bind(userId).run();

  const expiredRoutes = (await db.prepare("SELECT r.id,r.cf_rule_id,r.tag,d.zone_id FROM email_routes r JOIN domains d ON r.domain_id=d.id WHERE r.user_id=? AND r.status='active' AND r.expires_at IS NOT NULL AND datetime(r.expires_at)<datetime('now')").bind(userId).all()).results || [];
  for (const route of expiredRoutes) {
    await cfRemoveEmailRoute(route, env);
    await db.prepare("DELETE FROM email_routes WHERE id=?").bind(route.id).run();
  }

  const expiredDestinations = (await db.prepare("SELECT * FROM user_destinations WHERE user_id=? AND status!='expired' AND expires_at IS NOT NULL AND datetime(expires_at)<datetime('now')").bind(userId).all()).results || [];
  for (const dest of expiredDestinations) {
    await deleteUserDestination(db, env, userId);
  }

  const pendingHours = getPendingExpiryHours(cfg);
  const expiredPending = (await db.prepare("SELECT * FROM user_destinations WHERE user_id=? AND status='pending' AND created_at<datetime('now','-'||?||' hours')").bind(userId, pendingHours).all()).results || [];
  for (const dest of expiredPending) {
    if(dest.cf_address_id) await cfDelete(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses/${dest.cf_address_id}`, env);
    await db.prepare("DELETE FROM user_destinations WHERE id=?").bind(dest.id).run();
  }
};

const getPublicConfig = async (db, cfg) => {
  const codeCount = (await db.prepare("SELECT COUNT(*) AS c FROM invitation_codes").first())?.c || 0;
  return {
    allowRegistration: cfg.allow_registration === 'true',
    inviteRequired: cfg.allow_registration === 'true' && cfg.enable_invitation_code === 'true' && codeCount > 0,
    randomInboxEnabled: randomInboxIsEnabled(cfg),
    randomInboxDomain: randomInboxIsEnabled(cfg) ? normalizeDomain(cfg.random_inbox_domain) : '',
    durationOptions: DURATION_OPTIONS
  };
};

const createRandomInbox = async (db, cfg, oldToken = '') => {
  if (!randomInboxIsEnabled(cfg)) return {error: "随机邮箱未启用或后缀未配置"};
  const domain = normalizeDomain(cfg.random_inbox_domain);
  const previous = RANDOM_INBOX_TOKEN_RE.test(String(oldToken || '')) ? await db.prepare("SELECT token,prefix,email,domain,created_at FROM random_inboxes WHERE token=?").bind(oldToken).first() : null;
  if (previous && previous.domain === domain) return previous;

  for (let i = 0; i < 8; i++) {
    const prefix = normalizeRandomInboxPrefix(randomString(12));
    const email = `${prefix}@${domain}`;
    const token = randomString(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-');
    try {
      await db.prepare("INSERT INTO random_inboxes(token,prefix,email,domain) VALUES(?,?,?,?)").bind(token, prefix, email, domain).run();
      return {token, prefix, email, domain, created_at: sqlDateFromMs(Date.now())};
    } catch (_) {}
  }
  return {error: "随机邮箱生成失败，请稍后重试"};
};

const getRandomInboxByToken = async (db, cfg, token) => {
  if (!randomInboxIsEnabled(cfg)) return {error: "随机邮箱未启用或后缀未配置"};
  if (!RANDOM_INBOX_TOKEN_RE.test(String(token || ''))) return {error: "随机邮箱令牌无效"};
  const inbox = await db.prepare("SELECT token,prefix,email,domain,created_at FROM random_inboxes WHERE token=?").bind(token).first();
  if (!inbox) return {error: "随机邮箱不存在，请重新获取"};
  if (inbox.domain !== normalizeDomain(cfg.random_inbox_domain)) return {error: "随机邮箱后缀已变更，请重新获取"};
  return inbox;
};

const storeRandomInboxMessage = async (db, cfg, message, snapshot = null) => {
  if (!randomInboxIsEnabled(cfg)) return false;

  const toEmail = normalizeEmailAddress(message.to);
  const domain = normalizeDomain(cfg.random_inbox_domain);
  if (!toEmail || !toEmail.endsWith('@' + domain)) return false;

  const inbox = await db.prepare("SELECT email FROM random_inboxes WHERE email=?").bind(toEmail).first();
  if (!inbox) return false;

  const raw = snapshot?.raw || await readEmailRaw(message);
  const messageId = snapshot?.messageId || getRawHeader(raw, 'Message-ID') || `${Date.now()}-${randomString(10)}`;
  const subject = snapshot?.subject || decodeMimeHeader(message.headers?.get?.('subject') || getRawHeader(raw, 'Subject') || '(无主题)').slice(0, 500);
  const fromEmail = snapshot?.fromEmail || decodeMimeHeader(message.from || getRawHeader(raw, 'From') || '').slice(0, 500);
  const bodies = snapshot ? {text: snapshot.text, html: snapshot.html} : extractEmailBodies(raw);

  await db.prepare(`
    INSERT OR IGNORE INTO random_inbox_messages(inbox_email,message_id,from_email,to_email,subject,text,html,raw,created_at)
    VALUES(?,?,?,?,?,?,?,?,datetime('now'))
  `).bind(toEmail, messageId.slice(0, 500), fromEmail, toEmail, subject, bodies.text, bodies.html, raw).run();
  return true;
};

const buildMailSnapshot = (message, raw) => {
  const bodies = extractEmailBodies(raw);
  return {
    messageId: (getRawHeader(raw, 'Message-ID') || `${Date.now()}-${randomString(10)}`).slice(0, 500),
    fromEmail: decodeMimeHeader(message.from || getRawHeader(raw, 'From') || '').slice(0, 500),
    toEmail: normalizeEmailAddress(message.to) || normalizeEmailAddress(getRawHeader(raw, 'To')) || String(message.to || '').slice(0, 500),
    subject: decodeMimeHeader(message.headers?.get?.('subject') || getRawHeader(raw, 'Subject') || '(无主题)').slice(0, 500),
    text: bodies.text,
    html: bodies.html,
    raw: String(raw || '').slice(0, RANDOM_INBOX_MAX_RAW_CHARS)
  };
};

const writeMailLog = async (db, entry) => {
  await db.prepare(`
    INSERT INTO mail_logs(mail_type,status,message_id,from_email,to_email,destination_email,subject,text,html,raw,route_id,user_id,error,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `).bind(
    entry.mailType,
    entry.status,
    entry.messageId || null,
    entry.fromEmail || null,
    entry.toEmail || '',
    entry.destinationEmail || null,
    entry.subject || null,
    entry.text || null,
    entry.html || null,
    entry.raw || null,
    entry.routeId || null,
    entry.userId || null,
    entry.error || null
  ).run();
};

const findUserRouteForMessage = async (db, message) => {
  const toEmail = normalizeEmailAddress(message.to);
  if (!toEmail || !toEmail.includes('@')) return null;
  const [prefix, domain] = toEmail.split('@');

  return await db.prepare(`
    SELECT r.id AS route_id, r.user_id, r.tag, ud.email AS destination_email
    FROM email_routes r
    JOIN domains d ON r.domain_id=d.id
    JOIN user_destinations ud ON r.user_id=ud.user_id
    WHERE d.domain=?
      AND r.status='active'
      AND ud.status='verified'
      AND (r.expires_at IS NULL OR datetime(r.expires_at)>datetime('now'))
      AND (ud.expires_at IS NULL OR datetime(ud.expires_at)>datetime('now'))
      AND (r.tag=? OR r.tag=?)
    ORDER BY CASE WHEN r.tag=? THEN 0 ELSE 1 END
    LIMIT 1
  `).bind(domain, prefix, WILDCARD_PREFIX, prefix).first();
};

const forwardUserRouteMessage = async (db, message) => {
  const route = await findUserRouteForMessage(db, message);
  if (!route?.destination_email) return null;
  await message.forward(route.destination_email);
  return route;
};

const getUserState = async (db, env, userId, cfg) => {
  await expireLocalForUser(db, env, userId, cfg);

  const destination = await db.prepare("SELECT id,email,status,expires_at,created_at,duration_hours FROM user_destinations WHERE user_id=? ORDER BY id DESC LIMIT 1").bind(userId).first();
  if (destination?.status === 'pending') {
    const pendingExpiry = dbDateMs(destination.created_at) + getPendingExpiryHours(cfg) * 3600000;
    destination.pending_expires_at = sqlDateFromMs(pendingExpiry);
  }

  const routes = (await db.prepare(`
    SELECT r.id, r.tag, r.expires_at, r.duration_hours, d.domain
    FROM email_routes r
    JOIN domains d ON r.domain_id=d.id
    WHERE r.user_id=? AND r.status='active' AND (r.expires_at IS NULL OR datetime(r.expires_at)>datetime('now'))
    ORDER BY r.id DESC
  `).bind(userId).all()).results || [];

  const domains = (await db.prepare("SELECT id,domain FROM domains ORDER BY domain ASC").all()).results || [];
  const maxRoutes = parseInt(cfg.max_routes_per_user || '10', 10);

  return {
    destination: destination?.status === 'expired' ? null : destination,
    routes,
    domains,
    quota: {
      used: routes.length,
      max: Number.isFinite(maxRoutes) && maxRoutes >= 0 ? maxRoutes : 10
    },
    limits: {
      destinationMax: cfg.max_destination_duration_hours || '168',
      routeMax: cfg.max_route_duration_hours || '72'
    },
    durationOptions: DURATION_OPTIONS
  };
};

const cfDelete = async (url, env) => {
  try {
    const res = await fetch(url, {method:'DELETE', headers:{'Authorization':`Bearer ${env.CF_API_TOKEN}`}});
    const data = await res.json().catch(() => ({success: res.ok}));
    return res.ok || data.success === true;
  } catch (_) {
    return false;
  }
};

const cfJson = async (url, env, options = {}) => {
  try {
    const headers = {'Authorization':`Bearer ${env.CF_API_TOKEN}`, ...(options.headers || {})};
    const res = await fetch(url, {...options, headers});
    const data = await res.json().catch(() => ({success: res.ok}));
    return {ok: res.ok && data.success !== false, data};
  } catch (e) {
    return {ok: false, data: {errors: [{message: e.message}]}};
  }
};

const cfCatchAllUrl = (zoneId) => `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/catch_all`;
const cfGetCatchAll = (zoneId, env) => cfJson(cfCatchAllUrl(zoneId), env);
const cfSetCatchAll = (zoneId, env, payload) => cfJson(cfCatchAllUrl(zoneId), env, {
  method: 'PUT',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(payload)
});

const cfEnableCatchAll = (zoneId, env, userId, destinationEmail) => cfSetCatchAll(zoneId, env, {
  actions: [{type: 'forward', value: [destinationEmail]}],
  matchers: [{type: 'all'}],
  enabled: true,
  name: `U-${userId}-catch-all`
});

const cfEnableCatchAllWorker = (zoneId, env, workerName) => cfSetCatchAll(zoneId, env, {
  actions: [{type: 'worker', value: [workerName]}],
  matchers: [{type: 'all'}],
  enabled: true,
  name: `Random inbox -> ${workerName}`
});

const cfDisableCatchAll = (zoneId, env) => cfSetCatchAll(zoneId, env, {
  actions: [{type: 'drop'}],
  matchers: [{type: 'all'}],
  enabled: false,
  name: 'Disabled catch-all'
});

const cfRemoveEmailRoute = async (route, env) => {
  if (route.tag === WILDCARD_PREFIX) return true;
  if (route.cf_rule_id) return cfDelete(`https://api.cloudflare.com/client/v4/zones/${route.zone_id}/email/routing/rules/${route.cf_rule_id}`, env);
  return true;
};

const normalizeDomain = (domain) => String(domain || '').trim().toLowerCase().replace(/\.$/, '');
const isValidDomainName = (domain) => /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
const domainBelongsToZone = (domain, zoneName) => domain === zoneName || domain.endsWith('.' + zoneName);

const getWorkerNameFromRequest = (env, requestUrl) => {
  const configured = String(env.CF_WORKER_NAME || env.WORKER_NAME || '').trim();
  if (configured) return configured;
  try {
    const host = new URL(requestUrl).hostname;
    return host.endsWith('.workers.dev') ? host.split('.')[0] : '';
  } catch (_) {
    return '';
  }
};

const resolveCfZoneForDomain = async (db, env, domain) => {
  const cleanDomain = normalizeDomain(domain);
  const existing = await db.prepare("SELECT domain,zone_id FROM domains WHERE domain=?").bind(cleanDomain).first();
  if (existing) return {ok: true, zoneId: existing.zone_id, zoneName: existing.domain, domain: cleanDomain};

  const zones = await cfJson('https://api.cloudflare.com/client/v4/zones?per_page=100', env);
  if (!zones.ok) return {ok: false, error: "无法读取 Cloudflare 域名列表", details: zones.data?.errors || zones.data};

  const match = (zones.data?.result || [])
    .filter((zone) => domainBelongsToZone(cleanDomain, normalizeDomain(zone.name)))
    .sort((a, b) => String(b.name).length - String(a.name).length)[0];
  if (!match) return {ok: false, error: "随机邮箱后缀不属于当前 Cloudflare 账号下的任何 Zone"};
  return {ok: true, zoneId: match.id, zoneName: normalizeDomain(match.name), domain: cleanDomain};
};

const cfEnableEmailRoutingDomain = async (zoneId, domain, env) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/dns`, {
    method: 'POST',
    headers: {'Authorization':`Bearer ${env.CF_API_TOKEN}`,'Content-Type':'application/json'},
    body: JSON.stringify({name: domain})
  });
  const data = await res.json().catch(() => ({success: res.ok}));
  return {ok: res.ok && data.success !== false, data};
};

const ensureRandomInboxCfRouting = async (db, env, cfg, requestUrl) => {
  const domain = normalizeDomain(cfg.random_inbox_domain);
  if (!randomInboxIsEnabled(cfg)) return {ok: false, error: "随机邮箱未启用或后缀未配置"};

  const workerName = getWorkerNameFromRequest(env, requestUrl);
  if (!workerName) return {ok: false, error: "无法识别 Worker 名称。使用自定义域名访问后台时，请配置环境变量 CF_WORKER_NAME 为当前 Worker 名称"};

  const zone = await resolveCfZoneForDomain(db, env, domain);
  if (!zone.ok) return zone;

  if (domain !== zone.zoneName) {
    const dns = await cfEnableEmailRoutingDomain(zone.zoneId, domain, env);
    const details = JSON.stringify(dns.data?.errors || dns.data?.messages || dns.data || {});
    if (!dns.ok && !/already|exist|enabled|configured/i.test(details)) {
      return {ok: false, error: "无法为随机邮箱后缀启用 Email Routing DNS", details: dns.data?.errors || dns.data};
    }
  }

  const current = await cfGetCatchAll(zone.zoneId, env);
  if (!current.ok) return {ok: false, error: "无法读取 Cloudflare 泛匹配路由状态", details: current.data?.errors || current.data};

  const currentRule = current.data?.result || {};
  const currentActions = currentRule.actions || [];
  const alreadyTargetWorker = currentActions.some((action) => action.type === 'worker' && (action.value || []).includes(workerName));
  const managedWildcard = await db.prepare(`
    SELECT 1
    FROM email_routes r
    JOIN domains d ON r.domain_id=d.id
    WHERE d.zone_id=?
      AND r.tag=?
      AND r.status='active'
      AND (r.expires_at IS NULL OR datetime(r.expires_at)>datetime('now'))
    LIMIT 1
  `).bind(zone.zoneId, WILDCARD_PREFIX).first();
  if (currentRule.enabled && !alreadyTargetWorker && !managedWildcard) {
    return {ok: false, error: "该 Zone 已存在启用中的泛匹配路由。为避免覆盖现有收信规则，请先在 Cloudflare Email Routing 里移除或改用独立子域/Zone", details: currentActions};
  }

  const route = await cfEnableCatchAllWorker(zone.zoneId, env, workerName);
  if (!route.ok) return {ok: false, error: "随机邮箱泛匹配路由创建失败，请确认 API Token 具备 Email Routing 编辑权限", details: route.data?.errors || route.data};
  return {ok: true, zoneId: zone.zoneId, workerName, domain};
};

const runTimedCleanup = async (db, env, cfg) => {
  const tok = `Bearer ${env.CF_API_TOKEN}`, acc = env.CF_ACCOUNT_ID;

  const eR = await db.prepare("SELECT r.*,d.zone_id FROM email_routes r JOIN domains d ON r.domain_id=d.id WHERE r.expires_at IS NOT NULL AND datetime(r.expires_at)<datetime('now') AND r.status='active'").all();
  for(let r of eR.results){ await cfRemoveEmailRoute(r, env); await db.prepare("DELETE FROM email_routes WHERE id=?").bind(r.id).run(); }

  const eD = await db.prepare("SELECT * FROM user_destinations WHERE expires_at IS NOT NULL AND datetime(expires_at)<datetime('now') AND status!='expired'").all();
  for(let d of eD.results){
    if(d.cf_address_id) await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/email/routing/addresses/${d.cf_address_id}`,{method:'DELETE',headers:{'Authorization':tok}});
    const rr = await db.prepare("SELECT r.*,d.zone_id FROM email_routes r JOIN domains d ON r.domain_id=d.id WHERE r.user_id=? AND r.status='active'").bind(d.user_id).all();
    for(let r of rr.results){ await cfRemoveEmailRoute(r, env); await db.prepare("DELETE FROM email_routes WHERE id=?").bind(r.id).run(); }
    await db.prepare("DELETE FROM user_destinations WHERE id=?").bind(d.id).run();
  }

  const pH = getPendingExpiryHours(cfg);
  const eP = await db.prepare("SELECT * FROM user_destinations WHERE status='pending' AND created_at<datetime('now','-'||?||' hours')").bind(pH).all();
  for(let d of eP.results){ if(d.cf_address_id) await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/email/routing/addresses/${d.cf_address_id}`,{method:'DELETE',headers:{'Authorization':tok}}); await db.prepare("DELETE FROM user_destinations WHERE id=?").bind(d.id).run(); }

  const zH = parseInt(cfg.unverified_user_expiry_hours || '24', 10);
  const zs = await db.prepare("SELECT id FROM users WHERE created_at<datetime('now','-'||?||' hours') AND id NOT IN (SELECT user_id FROM user_destinations WHERE status!='expired')").bind(zH).all();
  for(let z of zs.results){ await db.prepare("DELETE FROM sessions WHERE user_id=?").bind(z.id).run(); await db.prepare("DELETE FROM users WHERE id=?").bind(z.id).run(); }

  await db.prepare("DELETE FROM email_routes WHERE status='expired'").run();
  await db.prepare("DELETE FROM user_destinations WHERE status='expired'").run();
  await db.prepare("DELETE FROM sessions WHERE expires_at<datetime('now')").run();
  await db.prepare("DELETE FROM sessions WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)").run();
};

const deleteRouteById = async (db, env, routeId, userId) => {
  const route = await db.prepare(`
    SELECT r.id,r.cf_rule_id,r.tag,r.status,d.zone_id
    FROM email_routes r
    JOIN domains d ON r.domain_id=d.id
    WHERE r.id=? AND r.user_id=?
  `).bind(routeId, userId).first();
  if (!route) return false;
  if (route.status === 'active') {
    await cfRemoveEmailRoute(route, env);
  }
  await db.prepare("DELETE FROM email_routes WHERE id=?").bind(route.id).run();
  return true;
};

const deleteUserRoutes = async (db, env, userId) => {
  const routes = (await db.prepare(`
    SELECT r.id,r.cf_rule_id,r.tag,d.zone_id
    FROM email_routes r
    JOIN domains d ON r.domain_id=d.id
    WHERE r.user_id=? AND r.status='active'
  `).bind(userId).all()).results || [];
  for (const route of routes) {
    await cfRemoveEmailRoute(route, env);
    await db.prepare("DELETE FROM email_routes WHERE id=?").bind(route.id).run();
  }
  return routes.length;
};

const deleteUserDestination = async (db, env, userId) => {
  const dest = await db.prepare("SELECT * FROM user_destinations WHERE user_id=? AND status!='expired'").bind(userId).first();
  if (!dest) return false;
  await deleteUserRoutes(db, env, userId);
  if (dest.cf_address_id) {
    await cfDelete(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses/${dest.cf_address_id}`, env);
  }
  await db.prepare("DELETE FROM user_destinations WHERE id=?").bind(dest.id).run();
  return true;
};

const deleteUserAccount = async (db, env, userId) => {
  await deleteUserDestination(db, env, userId);
  await deleteUserRoutes(db, env, userId);
  await db.prepare("DELETE FROM email_routes WHERE user_id=?").bind(userId).run();
  await db.prepare("DELETE FROM user_destinations WHERE user_id=?").bind(userId).run();
  await db.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId).run();
  await db.prepare("DELETE FROM users WHERE id=?").bind(userId).run();
};

// ==========================================
// 1. 普通用户网页 HTML
// ==========================================
const renderUserHTML = (sitekey) => `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>云端邮件路由系统</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <style>.fade-in { animation: fadeIn 0.4s ease-out; } @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }</style>
</head>
<body class="bg-gray-900 text-gray-200 font-sans min-h-screen flex items-center justify-center p-4">
    <div id="toast-container" class="fixed top-5 right-5 z-50 flex flex-col gap-2"></div>

    <div id="auth-panel" class="bg-gray-800 w-full max-w-md rounded-2xl shadow-2xl p-8 border border-gray-700 fade-in">
        <div class="flex border-b border-gray-700 mb-6">
            <button type="button" class="w-1/2 pb-3 font-bold text-center text-emerald-400 border-b-2 border-emerald-500 transition-all" id="tab-login" onclick="switchTab('login')">用户登录</button>
            <button type="button" class="w-1/2 pb-3 font-medium text-center text-gray-500 hover:text-gray-300 transition-all border-b border-transparent" id="tab-register" onclick="switchTab('register')">注册账号</button>
        </div>
        <form id="auth-form" onsubmit="handleAuth(event)" class="space-y-5">
            <input type="text" id="username" class="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-xl text-white focus:ring-2 focus:ring-emerald-500 outline-none" placeholder="用户名" required>
            <input type="password" id="password" class="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-xl text-white focus:ring-2 focus:ring-emerald-500 outline-none" placeholder="密码" required>
            <div id="invite-wrap" class="hidden">
                <input type="text" id="invite-code" class="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-xl text-white focus:ring-2 focus:ring-emerald-500 outline-none" placeholder="邀请码">
            </div>
            <div class="cf-turnstile flex justify-center py-2" data-sitekey="${sitekey}"></div>
            <button type="submit" id="submit-btn" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl shadow-lg transition-all active:scale-95">登 录</button>
        </form>
    </div>

    <div id="dashboard-panel" class="hidden bg-gray-800 w-full max-w-4xl rounded-2xl shadow-2xl border border-gray-700 overflow-hidden fade-in">
        <div class="bg-gray-900/80 px-8 py-5 border-b border-gray-700 flex justify-between items-center">
            <h2 class="text-xl font-bold text-white flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>云端控制台</h2>
            <button onclick="logout()" class="text-gray-400 hover:text-white text-sm">锁定退出</button>
        </div>
        <div class="p-8 space-y-6">
            <div class="bg-gray-900/50 rounded-xl p-6 border border-gray-700">
                <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
                    <div>
                        <h3 class="text-emerald-400 font-bold mb-2">1. 绑定底层收件箱</h3>
                        <p class="text-xs text-gray-400">验证完成后，专属域名邮箱会转发到这个真实邮箱。</p>
                    </div>
                    <div id="dest-summary" class="text-sm text-gray-400 md:text-right"></div>
                </div>
                <form onsubmit="handleDest(event)" class="grid grid-cols-1 md:grid-cols-[1fr_160px_140px] gap-3">
                    <input type="email" id="dest-email" class="px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-emerald-500 outline-none" placeholder="如: real-email@qq.com" required>
                    <select id="dest-duration" class="px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white outline-none"></select>
                    <button type="submit" id="dest-btn" class="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2 rounded-lg font-medium transition-colors">发送验证</button>
                </form>
                <div id="dest-actions" class="hidden mt-4 flex justify-end">
                    <button onclick="deleteDestination()" class="text-sm bg-rose-900/40 hover:bg-rose-900/70 text-rose-300 border border-rose-800 px-4 py-2 rounded-lg transition-colors">删除底层收件箱</button>
                </div>
            </div>
            <div class="bg-gray-900/50 rounded-xl p-6 border border-gray-700">
                <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-4">
                    <div>
                        <h3 class="text-emerald-400 font-bold mb-2">2. 创建专属域名邮箱</h3>
                    </div>
                    <div id="route-quota" class="text-sm text-gray-400 md:text-right"></div>
                </div>
                <form onsubmit="handleRoute(event)" class="grid grid-cols-1 lg:grid-cols-[1fr_160px_140px] gap-3">
                    <div class="flex w-full shadow-sm rounded-lg">
                        <input type="text" id="route-prefix" class="w-1/2 px-4 py-2 bg-gray-900 border border-r-0 border-gray-700 rounded-l-lg text-white focus:ring-2 focus:ring-emerald-500 outline-none" placeholder="前缀 (如 admin 或 *)" required>
                        <span class="inline-flex items-center px-3 border-y border-gray-700 bg-gray-800 text-gray-500">@</span>
                        <select id="route-domain" class="w-1/2 px-4 py-2 bg-gray-900 border border-l-0 border-gray-700 rounded-r-lg text-white outline-none"></select>
                    </div>
                    <select id="route-duration" class="px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white outline-none"></select>
                    <button type="submit" id="route-btn" class="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2 rounded-lg font-medium transition-colors">立刻生成</button>
                </form>
                <div id="route-list" class="mt-5 space-y-2 text-sm"></div>
            </div>
            <div class="bg-gray-900/50 rounded-xl p-6 border border-gray-700">
                <h3 class="text-emerald-400 font-bold mb-4">3. 账号安全</h3>
                <form onsubmit="changePassword(event)" class="grid grid-cols-1 md:grid-cols-[1fr_1fr_140px] gap-3">
                    <input type="password" id="old-password" class="px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-emerald-500 outline-none" placeholder="当前密码" required>
                    <input type="password" id="new-password" class="px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-emerald-500 outline-none" placeholder="新密码" required>
                    <button type="submit" class="bg-gray-700 hover:bg-gray-600 text-white px-5 py-2 rounded-lg font-medium transition-colors">修改密码</button>
                </form>
                <div class="grid grid-cols-1 md:grid-cols-[1fr_140px] gap-3 mt-4">
                    <input type="password" id="delete-account-password" class="px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white focus:ring-2 focus:ring-rose-500 outline-none" placeholder="输入当前密码确认注销账号">
                    <button onclick="deleteAccount()" class="bg-rose-900/50 hover:bg-rose-900/80 text-rose-200 border border-rose-800 px-5 py-2 rounded-lg font-medium transition-colors">注销账号</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        var mode = 'login';
        var publicConfig = { allowRegistration: true, inviteRequired: false, durationOptions: [] };
        var dashboardState = null;
        var destMode = 'send';

        function escapeHTML(s) {
            var map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'};
            return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch){ return map[ch]; });
        }
        function durationRank(v){ return v === 'permanent' ? Infinity : parseInt(v, 10); }
        function durationOptions(){ return publicConfig.durationOptions && publicConfig.durationOptions.length ? publicConfig.durationOptions : [{value:'1',label:'1 小时'},{value:'8',label:'8 小时'},{value:'24',label:'24 小时'},{value:'48',label:'48 小时'},{value:'72',label:'72 小时'},{value:'168',label:'168 小时'},{value:'permanent',label:'永久'}]; }
        function durationLabel(v){ var hit = durationOptions().find(function(o){ return o.value === String(v); }); return hit ? hit.label : String(v); }
        function parseDbDate(v){ if(!v) return null; v = String(v); return new Date(v.indexOf('T') >= 0 ? v : v.replace(' ', 'T') + 'Z'); }
        function formatDate(v){ if(!v) return '永久'; var d = parseDbDate(v); return isNaN(d.getTime()) ? v : d.toLocaleString(); }
        function remainingText(v){ if(!v) return '永久'; var diff = parseDbDate(v).getTime() - Date.now(); if(diff <= 0) return '已过期'; return '约 ' + Math.ceil(diff / 3600000) + ' 小时'; }
        function showToast(msg, isErr) {
            var c=document.getElementById('toast-container'), t=document.createElement('div');
            t.className='px-6 py-3 rounded-lg shadow-xl text-white font-medium text-sm transition-all duration-300 translate-x-full opacity-0 ' + (isErr?'bg-rose-600':'bg-emerald-600');
            t.innerText=msg; c.appendChild(t);
            setTimeout(function(){ t.classList.remove('translate-x-full','opacity-0'); },10);
            setTimeout(function(){ t.classList.add('translate-x-full','opacity-0'); setTimeout(function(){t.remove();},300); },3000);
        }
        function fillDurationSelect(id, maxValue, filterFn) {
            var s = document.getElementById(id);
            var opts = durationOptions().filter(function(o){
                return durationRank(o.value) <= durationRank(maxValue || 'permanent') && (!filterFn || filterFn(o.value));
            });
            s.innerHTML = opts.length ? opts.map(function(o){ return '<option value="' + escapeHTML(o.value) + '">' + escapeHTML(o.label) + '</option>'; }).join('') : '<option value="" disabled>暂无可用有效期</option>';
            return opts;
        }
        async function loadPublicConfig() {
            try {
                var res = await fetch('/api/public-config');
                if (res.ok) publicConfig = await res.json();
            } catch (_) {}
            updateInviteField();
        }
        function updateInviteField() {
            var show = mode === 'register' && publicConfig.inviteRequired;
            document.getElementById('invite-wrap').classList.toggle('hidden', !show);
            document.getElementById('invite-code').required = show;
        }
        window.onload = async function() {
            await loadPublicConfig();
            var session = await fetch('/api/check-session');
            if (session.ok) {
                document.getElementById('auth-panel').classList.add('hidden');
                document.getElementById('dashboard-panel').classList.remove('hidden');
                await loadDashboard();
            }
        };
        function switchTab(m) {
            mode = m;
            document.getElementById('submit-btn').innerText = m==='login'?'登 录':'注 册';
            document.getElementById('tab-login').className = m==='login'?'w-1/2 pb-3 font-bold text-center text-emerald-400 border-b-2 border-emerald-500 transition-all':'w-1/2 pb-3 font-medium text-center text-gray-500 hover:text-gray-300 border-b border-transparent transition-all';
            document.getElementById('tab-register').className = m==='register'?'w-1/2 pb-3 font-bold text-center text-emerald-400 border-b-2 border-emerald-500 transition-all':'w-1/2 pb-3 font-medium text-center text-gray-500 hover:text-gray-300 border-b border-transparent transition-all';
            updateInviteField();
            if (window.turnstile) window.turnstile.reset();
        }
        async function handleAuth(e) {
            e.preventDefault();
            var t = new FormData(e.target).get('cf-turnstile-response');
            if(!t) return showToast('请完成人机验证', true);
            var payload = {
                username: document.getElementById('username').value,
                password: document.getElementById('password').value,
                turnstileToken: t
            };
            if (mode === 'register' && publicConfig.inviteRequired) payload.invitationCode = document.getElementById('invite-code').value.trim();
            var res = await fetch('/api/'+mode, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
            if(res.ok){
                mode==='login' ? location.reload() : (showToast('注册成功，请登录'), switchTab('login'));
            } else {
                var d = await res.json();
                showToast(d.error || '请求失败', true);
                if (window.turnstile) window.turnstile.reset();
            }
        }
        async function loadDashboard() {
            var res = await fetch('/api/me');
            if(!res.ok) return location.reload();
            dashboardState = await res.json();
            publicConfig.durationOptions = dashboardState.durationOptions || publicConfig.durationOptions;
            applyDashboardState();
        }
        function applyDashboardState() {
            var d = dashboardState.destination;
            var destSummary = document.getElementById('dest-summary');
            var destEmail = document.getElementById('dest-email');
            var destDuration = document.getElementById('dest-duration');
            var destBtn = document.getElementById('dest-btn');
            var destActions = document.getElementById('dest-actions');
            fillDurationSelect('dest-duration', dashboardState.limits.destinationMax);
            if (d && d.duration_hours) destDuration.value = d.duration_hours;
            var destDurationText = d && d.duration_hours ? durationLabel(d.duration_hours) : (d && !d.expires_at ? '永久' : '按过期时间');
            destActions.classList.toggle('hidden', !d);

            if(!d) {
                destMode = 'send';
                destEmail.disabled = false;
                destDuration.disabled = false;
                destBtn.disabled = false;
                destBtn.innerText = '发送验证';
                destBtn.className = 'bg-gray-700 hover:bg-gray-600 text-white px-5 py-2 rounded-lg font-medium transition-colors';
                destEmail.value = '';
                destSummary.innerHTML = '<span class="text-gray-500">尚未绑定邮箱</span>';
            } else if(d.status === 'pending') {
                destMode = 'refresh';
                destEmail.value = d.email;
                destEmail.disabled = true;
                destDuration.disabled = true;
                destBtn.disabled = false;
                destBtn.innerText = '刷新验证';
                destBtn.className = 'bg-blue-600 hover:bg-blue-500 text-white px-5 py-2 rounded-lg font-medium transition-colors';
                destSummary.innerHTML = '<span class="text-blue-300 font-bold">等待验证</span><br><span class="text-xs text-gray-500">' + escapeHTML(d.email) + '，邮箱有效期 ' + escapeHTML(destDurationText) + '，验证截止 ' + escapeHTML(formatDate(d.pending_expires_at)) + '</span>';
            } else {
                destMode = 'verified';
                destEmail.value = d.email;
                destEmail.disabled = true;
                destDuration.disabled = true;
                destBtn.disabled = true;
                destBtn.innerText = '已验证';
                destBtn.className = 'bg-emerald-900/50 text-emerald-300 px-5 py-2 rounded-lg font-medium cursor-not-allowed';
                destSummary.innerHTML = '<span class="text-emerald-300 font-bold">已验证</span><br><span class="text-xs text-gray-500">' + escapeHTML(d.email) + '，邮箱有效期 ' + escapeHTML(destDurationText) + '，剩余 ' + escapeHTML(remainingText(d.expires_at)) + '</span>';
            }

            var quota = dashboardState.quota;
            document.getElementById('route-quota').innerHTML = '已创建 <span class="text-emerald-300 font-bold">' + quota.used + '</span> / ' + quota.max + ' 个';
            var domains = dashboardState.domains || [];
            document.getElementById('route-domain').innerHTML = domains.length ? domains.map(function(x){ return '<option value="' + x.id + '">' + escapeHTML(x.domain) + '</option>'; }).join('') : '<option value="" disabled>管理员暂未开放可用域名</option>';
            var routeOptions = fillDurationSelect('route-duration', dashboardState.limits.routeMax, function(value){
                if(!d || d.status !== 'verified') return false;
                if(d.duration_hours && durationRank(value) > durationRank(d.duration_hours)) return false;
                if(!d.expires_at) return true;
                if(value === 'permanent') return false;
                return true;
            });
            var canCreate = !!d && d.status === 'verified' && domains.length > 0 && quota.used < quota.max && routeOptions.length > 0;
            ['route-prefix','route-domain','route-duration','route-btn'].forEach(function(id){ document.getElementById(id).disabled = !canCreate; });
            document.getElementById('route-btn').className = canCreate ? 'bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2 rounded-lg font-medium transition-colors' : 'bg-gray-700 text-gray-400 px-6 py-2 rounded-lg font-medium cursor-not-allowed';

            var routes = dashboardState.routes || [];
            document.getElementById('route-list').innerHTML = routes.length ? routes.map(function(r){
                var routeDurationText = r.duration_hours ? durationLabel(r.duration_hours) : (r.expires_at ? '按过期时间' : '永久');
                return '<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 bg-gray-800 border border-gray-700 rounded-lg"><div><span class="font-mono text-emerald-300">' + escapeHTML(r.tag + '@' + r.domain) + '</span><div class="text-xs text-gray-500 mt-1">有效期：' + escapeHTML(routeDurationText) + '，至：' + escapeHTML(formatDate(r.expires_at)) + '</div></div><button onclick="deleteRoute(' + r.id + ')" class="self-start sm:self-center text-xs bg-rose-900/50 hover:bg-rose-900/80 text-rose-300 border border-rose-800 px-3 py-1.5 rounded transition-colors">删除</button></div>';
            }).join('') : '<div class="text-gray-500 text-sm">还没有创建专属域名邮箱</div>';
        }
        async function handleDest(e) {
            e.preventDefault();
            var url = destMode === 'refresh' ? '/api/destination/refresh' : '/api/destination';
            var payload = destMode === 'refresh' ? {} : {email:document.getElementById('dest-email').value, durationHours:document.getElementById('dest-duration').value};
            var res = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
            var d = await res.json();
            showToast(d.message || d.error || '请求完成', !res.ok);
            await loadDashboard();
        }
        async function handleRoute(e) {
            e.preventDefault();
            var res = await fetch('/api/routes', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prefix:document.getElementById('route-prefix').value.trim(), domainId:document.getElementById('route-domain').value, durationHours:document.getElementById('route-duration').value})});
            var d = await res.json();
            showToast(d.success ? '专属邮箱创建成功' : (d.error || '创建失败'), !d.success);
            if(d.success) {
                document.getElementById('route-prefix').value = '';
                await loadDashboard();
            }
        }
        async function deleteRoute(id) {
            if(!confirm('确定删除这个专属域名邮箱吗？删除后 Cloudflare 路由也会一起移除。')) return;
            var res = await fetch('/api/routes/' + id, {method:'DELETE'});
            var d = await res.json();
            showToast(d.message || d.error || '请求完成', !res.ok);
            await loadDashboard();
        }
        async function deleteDestination() {
            if(!confirm('确定删除底层收件箱吗？这个操作会同时删除当前账号下所有专属域名邮箱。')) return;
            var res = await fetch('/api/destination', {method:'DELETE'});
            var d = await res.json();
            showToast(d.message || d.error || '请求完成', !res.ok);
            await loadDashboard();
        }
        async function changePassword(e) {
            e.preventDefault();
            var oldPassword = document.getElementById('old-password').value;
            var newPassword = document.getElementById('new-password').value;
            if(newPassword.length < 6) return showToast('新密码至少 6 位', true);
            var res = await fetch('/api/password', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({oldPassword:oldPassword,newPassword:newPassword})});
            var d = await res.json();
            showToast(d.message || d.error || '请求完成', !res.ok);
            if(res.ok){ document.getElementById('old-password').value=''; document.getElementById('new-password').value=''; }
        }
        async function deleteAccount() {
            var password = document.getElementById('delete-account-password').value;
            if(!password) return showToast('请输入当前密码确认注销', true);
            if(!confirm('确定永久删除自己的账号吗？账号、底层收件箱和所有专属域名邮箱都会被删除。')) return;
            var res = await fetch('/api/account', {method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:password})});
            var d = await res.json();
            showToast(d.message || d.error || '请求完成', !res.ok);
            if(res.ok) setTimeout(function(){ location.reload(); }, 600);
        }
        async function logout(){ await fetch('/api/logout',{method:'POST'}); location.reload();}
    </script>
</body>
</html>`;

// ==========================================
// 2. 随机邮箱网页 HTML
// ==========================================
const renderRandomInboxHTML = () => `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>随机邮箱</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      .fade-in{animation:fadeIn .25s ease-out}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      pre{white-space:pre-wrap;word-break:break-word}
    </style>
</head>
<body class="bg-gray-950 text-gray-200 min-h-screen font-sans">
  <div id="toast-container" class="fixed top-5 right-5 z-50 flex flex-col gap-2"></div>
  <main class="max-w-5xl mx-auto px-4 py-8">
    <section class="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden fade-in">
      <div class="px-6 py-5 border-b border-gray-800 bg-gray-900/80 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-white">随机临时邮箱</h1>
          <p class="text-sm text-gray-500 mt-1">首次进入自动分配，刷新页面保持不变；只有点击“获取新邮箱”才会更换。</p>
        </div>
        <button onclick="newInbox()" class="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-lg font-medium transition-colors">获取新邮箱</button>
      </div>

      <div class="p-6 space-y-5">
        <div id="disabled-panel" class="hidden p-5 rounded-xl border border-rose-800 bg-rose-950/40 text-rose-200">
          随机邮箱暂未启用，请联系管理员在后台开启并配置邮箱后缀。
        </div>

        <div id="inbox-panel" class="space-y-5">
          <div class="grid grid-cols-1 md:grid-cols-[1fr_160px] gap-3">
            <div class="bg-gray-950 border border-gray-800 rounded-xl p-4">
              <div class="text-xs text-gray-500 mb-2">当前邮箱</div>
              <div id="email-address" class="font-mono text-xl md:text-2xl text-emerald-300 break-all">加载中...</div>
            </div>
            <button onclick="copyEmail()" class="bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl text-white font-medium transition-colors">复制邮箱</button>
          </div>

          <div class="flex items-center justify-between">
            <div class="text-sm text-gray-500">邮件会自动刷新，仅显示当前邮箱收到的邮件。</div>
            <button onclick="loadMessages(true)" class="text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-2 rounded-lg transition-colors">手动刷新</button>
          </div>

          <div id="mail-list-view">
            <div id="mail-list" class="overflow-hidden rounded-xl border border-gray-800"></div>
          </div>
          <div id="mail-detail-view" class="hidden space-y-4">
            <button onclick="showMessageList()" class="text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 px-3 py-2 rounded-lg transition-colors">返回列表</button>
            <div id="mail-detail-body" class="bg-gray-950 border border-gray-800 rounded-xl p-4"></div>
          </div>
        </div>
      </div>
    </section>
  </main>

  <script>
    var inboxToken = localStorage.getItem('randomInboxToken') || '';
    var inboxEmail = '';
    var refreshTimer = null;
    var currentMessageId = null;

    function escapeHTML(s) {
      var map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'};
      return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch){ return map[ch]; });
    }
    function showToast(msg, isErr) {
      var c=document.getElementById('toast-container'), t=document.createElement('div');
      t.className='px-4 py-2 rounded-lg shadow-xl text-white text-sm transition-all translate-x-full opacity-0 ' + (isErr?'bg-rose-600':'bg-emerald-600');
      t.innerText=msg; c.appendChild(t);
      setTimeout(function(){ t.classList.remove('translate-x-full','opacity-0'); },10);
      setTimeout(function(){ t.classList.add('translate-x-full','opacity-0'); setTimeout(function(){t.remove();},300); },2600);
    }
    function formatDate(v){ if(!v) return ''; var d=new Date(String(v).replace(' ','T') + 'Z'); return isNaN(d.getTime()) ? v : d.toLocaleString(); }
    function senderParts(raw) {
      var value = String(raw || '').trim();
      var m = value.match(/^(.*?)\s*<([^>]+)>$/);
      var name = m ? m[1].replace(/^"|"$/g, '').trim() : '';
      var email = m ? m[2].trim() : value;
      if(!name) name = email && email.indexOf('@') > 0 ? email.split('@')[0] : (email || '未知发件人');
      return {name:name, email:email || '-'};
    }

    async function ensureInbox(forceNew) {
      var res = await fetch('/api/random-inbox', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({token: forceNew ? '' : inboxToken})
      });
      var d = await res.json().catch(function(){ return {}; });
      if(!res.ok) {
        document.getElementById('disabled-panel').classList.remove('hidden');
        document.getElementById('inbox-panel').classList.add('hidden');
        showToast(d.error || '随机邮箱不可用', true);
        return false;
      }
      inboxToken = d.token;
      inboxEmail = d.email;
      localStorage.setItem('randomInboxToken', inboxToken);
      document.getElementById('email-address').innerText = inboxEmail;
      document.getElementById('disabled-panel').classList.add('hidden');
      document.getElementById('inbox-panel').classList.remove('hidden');
      return true;
    }

    async function loadMessages(manual) {
      if(!inboxToken) return;
      var res = await fetch('/api/random-inbox/messages?token=' + encodeURIComponent(inboxToken));
      var d = await res.json().catch(function(){ return {}; });
      if(!res.ok) {
        if(manual) showToast(d.error || '读取失败', true);
        return;
      }
      var list = d.messages || [];
      var table = '<div class="hidden md:grid grid-cols-[1.2fr_1.8fr_90px] gap-4 bg-gray-900 px-5 py-4 text-sm font-bold text-white"><div>发件人</div><div>主题</div><div class="text-right">浏览</div></div>';
      table += list.length ? list.map(function(m){
        var sender = senderParts(m.from_email);
        var icon = Number(m.has_attachment) ? '<span class="ml-2 text-gray-400">📎</span>' : '';
        return '<button type="button" onclick="openMessage(' + Number(m.id) + ')" class="w-full grid grid-cols-[1fr_26px] md:grid-cols-[1.2fr_1.8fr_90px] gap-3 md:gap-4 items-center text-left px-5 py-4 bg-gray-950 hover:bg-gray-900 border-t border-gray-800 transition-colors fade-in"><div class="min-w-0"><div class="font-bold text-white truncate">' + escapeHTML(sender.name) + '</div><div class="text-sm text-gray-500 truncate">' + escapeHTML(sender.email) + '</div></div><div class="min-w-0 hidden md:block"><div class="text-gray-200 truncate">' + escapeHTML(m.subject || '(无主题)') + icon + '</div><div class="text-xs text-gray-500 mt-1">' + escapeHTML(formatDate(m.created_at)) + '</div></div><div class="text-right text-gray-500 text-2xl leading-none">›</div><div class="md:hidden col-span-2 min-w-0"><div class="text-gray-200 truncate">' + escapeHTML(m.subject || '(无主题)') + icon + '</div><div class="text-xs text-gray-500 mt-1">' + escapeHTML(formatDate(m.created_at)) + '</div></div></button>';
      }).join('') : '<div class="text-center text-gray-500 bg-gray-950 py-12">暂未收到邮件，页面会自动刷新。</div>';
      document.getElementById('mail-list').innerHTML = table;
      if(manual) showToast('邮件已刷新');
    }

    function showMessageList() {
      currentMessageId = null;
      document.getElementById('mail-detail-view').classList.add('hidden');
      document.getElementById('mail-list-view').classList.remove('hidden');
    }

    async function openMessage(id) {
      if(!inboxToken || !id) return;
      currentMessageId = id;
      var res = await fetch('/api/random-inbox/messages/' + encodeURIComponent(id) + '?token=' + encodeURIComponent(inboxToken));
      var d = await res.json().catch(function(){ return {}; });
      if(!res.ok) return showToast(d.error || '邮件详情读取失败', true);
      var m = d.message || {};
      var sender = senderParts(m.from_email);
      var body = m.html
        ? '<iframe sandbox="" class="mt-4 w-full min-h-[560px] bg-white rounded-lg border border-gray-800" srcdoc="' + escapeHTML(m.html) + '"></iframe>'
        : '<pre class="mt-4 text-sm text-gray-300 bg-gray-900/70 border border-gray-800 rounded-lg p-4 max-h-[70vh] overflow-auto">' + escapeHTML(m.text || '(暂无正文)') + '</pre>';
      document.getElementById('mail-detail-body').innerHTML =
        '<div class="flex flex-col md:flex-row md:items-start md:justify-between gap-3 border-b border-gray-800 pb-4">' +
        '<div class="min-w-0"><div class="text-xl font-bold text-white break-words">' + escapeHTML(m.subject || '(无主题)') + '</div><div class="text-sm text-gray-500 mt-2">发件人：<span class="text-gray-300">' + escapeHTML(sender.name) + '</span> &lt;' + escapeHTML(sender.email) + '&gt;</div><div class="text-sm text-gray-500 mt-1">收件人：' + escapeHTML(m.to_email || inboxEmail || '-') + '</div></div>' +
        '<div class="text-xs text-gray-500 whitespace-nowrap">' + escapeHTML(formatDate(m.created_at)) + '</div></div>' + body;
      document.getElementById('mail-list-view').classList.add('hidden');
      document.getElementById('mail-detail-view').classList.remove('hidden');
    }

    async function newInbox() {
      if(!confirm('确定获取新邮箱吗？旧邮箱的邮件不会在当前页面继续显示。')) return;
      if(await ensureInbox(true)) {
        showToast('已分配新邮箱');
        await loadMessages(false);
      }
    }
    async function copyEmail() {
      if(!inboxEmail) return;
      await navigator.clipboard.writeText(inboxEmail);
      showToast('邮箱已复制');
    }

    window.onload = async function() {
      if(await ensureInbox(false)) {
        await loadMessages(false);
        refreshTimer = setInterval(function(){ loadMessages(false); }, 8000);
      }
    };
  </script>
</body>
</html>`;

// ==========================================
// 3. 现代化管理员网页 HTML
// ==========================================
const renderAdminHTML = (adminPath) => `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>超级管理员台</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>.fade-in{animation:fadeIn 0.3s} @keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:#4b5563;border-radius:3px}</style>
</head>
<body class="bg-gray-900 text-gray-200 font-sans min-h-screen p-4 flex justify-center items-center">
    <div id="toast-container" class="fixed top-5 right-5 z-50 flex flex-col gap-2"></div>

    <div id="login-panel" class="bg-gray-800 w-full max-w-sm rounded-2xl shadow-2xl p-8 border border-gray-700 fade-in">
        <h2 class="text-2xl font-bold text-center text-white mb-6">系统底座管理</h2>
        <form onsubmit="handleAdminLogin(event)" class="space-y-4">
            <input type="text" id="admin-user" class="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-xl text-white outline-none focus:border-emerald-500" placeholder="Admin ID" required>
            <input type="password" id="admin-pass" class="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-xl text-white outline-none focus:border-emerald-500" placeholder="Password" required>
            <button type="submit" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl transition-all">解 锁</button>
        </form>
    </div>

    <div id="dashboard-panel" class="hidden bg-gray-800 w-full max-w-6xl rounded-2xl shadow-2xl border border-gray-700 overflow-hidden fade-in flex flex-col h-[90vh]">
        <div class="bg-gray-900/80 px-6 py-4 border-b border-gray-700 flex justify-between items-center">
            <div class="flex gap-4">
                <button onclick="nav('domains')" id="nav-domains" class="text-emerald-400 font-bold border-b-2 border-emerald-400 pb-1">域名与配置</button>
                <button onclick="nav('invites')" id="nav-invites" class="text-gray-400 hover:text-white font-bold pb-1 transition-colors">邀请码</button>
                <button onclick="nav('users')" id="nav-users" class="text-gray-400 hover:text-white font-bold pb-1 transition-colors">用户管理中心</button>
                <button onclick="nav('mails')" id="nav-mails" class="text-gray-400 hover:text-white font-bold pb-1 transition-colors">邮件记录</button>
            </div>
            <button onclick="logout()" class="text-rose-400 hover:text-rose-300 text-sm">锁定退出</button>
        </div>

        <div class="p-6 overflow-y-auto flex-1">
            <div id="view-domains" class="space-y-6">
                <div class="bg-gray-900/40 p-5 rounded-xl border border-gray-700">
                    <div class="flex justify-between items-center mb-4"><h3 class="font-bold text-white">域名引擎拉取</h3><button onclick="syncDomains()" class="text-xs bg-blue-600 px-3 py-1.5 rounded text-white hover:bg-blue-500 transition-colors">重新拉取 CF 域名</button></div>
                    <div id="domain-list" class="space-y-2 text-sm"></div>
                    <div class="mt-5 pt-5 border-t border-gray-700">
                        <h4 class="font-bold text-white mb-3">开放子域名邮箱</h4>
                        <form onsubmit="addSubdomain(event)" class="grid grid-cols-1 md:grid-cols-[180px_1fr_120px] gap-3">
                            <select id="sub-zone" class="px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm outline-none"></select>
                            <input type="text" id="sub-name" class="px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm outline-none focus:border-emerald-500" placeholder="子域名前缀，如 mail 或 corp">
                            <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-lg text-white text-sm transition-colors">添加子域名</button>
                        </form>
                        <div id="authorized-domain-list" class="mt-4 space-y-2 text-sm"></div>
                    </div>
                </div>
                <div class="bg-gray-900/40 p-5 rounded-xl border border-gray-700">
                    <div class="flex justify-between items-center mb-4"><h3 class="font-bold text-white">核心参数设定</h3><button onclick="runCleanup()" class="text-xs bg-gray-700 px-3 py-1.5 rounded text-white hover:bg-gray-600 transition-colors">手动清理过期数据</button></div>
                    <div id="config-list" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
                </div>
            </div>

            <div id="view-invites" class="hidden space-y-4">
                <div class="bg-gray-900/40 p-5 rounded-xl border border-gray-700">
                    <h3 class="font-bold text-white mb-4">邀请码管理</h3>
                    <form onsubmit="createInvite(event)" class="grid grid-cols-1 md:grid-cols-[1fr_160px_120px_120px] gap-3 mb-5">
                        <input type="text" id="new-invite-code" class="px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm outline-none focus:border-emerald-500" placeholder="邀请码，如 ABCD-2026" required>
                        <input type="number" min="1" id="new-invite-max" class="px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm outline-none focus:border-emerald-500" placeholder="可用次数" required>
                        <button type="button" onclick="randomInvite()" class="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-white text-sm transition-colors">随机生成</button>
                        <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-lg text-white text-sm transition-colors">新增</button>
                    </form>
                    <div class="overflow-x-auto border border-gray-700 rounded-xl">
                        <table class="w-full text-left text-sm text-gray-300">
                            <thead class="bg-gray-900 text-gray-400 border-b border-gray-700"><tr><th class="p-3">邀请码</th><th class="p-3">最大次数</th><th class="p-3">已使用</th><th class="p-3">剩余</th><th class="p-3">创建时间</th><th class="p-3">操作</th></tr></thead>
                            <tbody id="invite-table-body" class="divide-y divide-gray-700"></tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div id="view-users" class="hidden space-y-4">
                <div class="flex gap-2">
                    <input type="text" id="search-user" class="flex-1 px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm outline-none focus:border-emerald-500 transition-colors" placeholder="搜索用户名...">
                    <button onclick="loadUsers(1)" class="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-white text-sm transition-colors">精准搜索</button>
                </div>
                <div class="overflow-x-auto border border-gray-700 rounded-xl">
                    <table class="w-full text-left text-sm text-gray-300">
                        <thead class="bg-gray-900 text-gray-400 border-b border-gray-700"><tr><th class="p-3">ID</th><th class="p-3">用户名</th><th class="p-3">注册IP</th><th class="p-3">真实邮箱</th><th class="p-3">路由数</th><th class="p-3">注册时间</th><th class="p-3">操作</th></tr></thead>
                        <tbody id="user-table-body" class="divide-y divide-gray-700"></tbody>
                    </table>
                </div>
                <div class="flex justify-between items-center text-sm">
                    <span id="page-info" class="text-gray-500 font-medium"></span>
                    <div class="flex gap-2">
                        <button onclick="changePage(-1)" class="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 transition-colors">上一页</button>
                        <button onclick="changePage(1)" class="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 transition-colors">下一页</button>
                    </div>
                </div>
            </div>

            <div id="view-mails" class="hidden space-y-4">
                <div class="bg-gray-900/40 p-5 rounded-xl border border-gray-700">
                    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
                        <h3 class="font-bold text-white">邮件记录</h3>
                        <div class="flex flex-col md:flex-row gap-2">
                            <select id="mail-type-filter" onchange="loadMailLogs(1)" class="px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm outline-none focus:border-emerald-500">
                                <option value="all">全部类型</option>
                                <option value="temporary">临时邮箱</option>
                                <option value="user">用户邮箱</option>
                                <option value="wildcard">泛匹配</option>
                                <option value="rejected">拒收</option>
                            </select>
                            <input type="text" id="mail-search" class="px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm outline-none focus:border-emerald-500" placeholder="搜索发件人/收件人/主题">
                            <button onclick="loadMailLogs(1)" class="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-white text-sm transition-colors">搜索</button>
                        </div>
                    </div>
                    <div class="overflow-x-auto border border-gray-700 rounded-xl">
                        <table class="w-full text-left text-sm text-gray-300">
                            <thead class="bg-gray-900 text-gray-400 border-b border-gray-700"><tr><th class="p-3">ID</th><th class="p-3">类型</th><th class="p-3">状态</th><th class="p-3">发件人</th><th class="p-3">收件人</th><th class="p-3">转发到</th><th class="p-3">主题</th><th class="p-3">时间</th><th class="p-3">操作</th></tr></thead>
                            <tbody id="mail-table-body" class="divide-y divide-gray-700"></tbody>
                        </table>
                    </div>
                    <div class="flex justify-between items-center text-sm mt-4">
                        <span id="mail-page-info" class="text-gray-500 font-medium"></span>
                        <div class="flex gap-2">
                            <button onclick="changeMailPage(-1)" class="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 transition-colors">上一页</button>
                            <button onclick="changeMailPage(1)" class="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 transition-colors">下一页</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div id="mail-detail-modal" class="hidden fixed inset-0 bg-black/70 z-40 p-4 overflow-y-auto">
        <div class="max-w-5xl mx-auto bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl my-8 overflow-hidden">
            <div class="bg-gray-900 px-5 py-4 border-b border-gray-700 flex justify-between items-center">
                <h3 class="font-bold text-white">邮件详情</h3>
                <button onclick="closeMailLog()" class="text-gray-400 hover:text-white text-sm">关闭</button>
            </div>
            <div id="mail-detail-body" class="p-5 space-y-4"></div>
        </div>
    </div>

    <script>
        const basePath = '${adminPath}';
        const durationOptions = [{value:'1',label:'1 小时'},{value:'8',label:'8 小时'},{value:'24',label:'24 小时'},{value:'48',label:'48 小时'},{value:'72',label:'72 小时'},{value:'168',label:'168 小时'},{value:'permanent',label:'永久'}];
        const durationConfigKeys = ['max_destination_duration_hours','max_route_duration_hours'];
        const booleanConfigKeys = ['allow_registration','enable_invitation_code','enable_random_inbox'];
        const cfgOrder = ['allow_registration','enable_invitation_code','enable_random_inbox','random_inbox_domain','max_users','max_routes_per_user','max_total_destinations','max_regs_per_ip_24h','max_destination_duration_hours','max_route_duration_hours','pending_dest_expiry_hours','unverified_user_expiry_hours','allowed_countries'];
        const cfgDict = {
            'max_users': '系统最大注册总人数',
            'max_routes_per_user': '单用户专属域名邮箱上限',
            'max_total_destinations': '全局目标邮箱总配额',
            'max_regs_per_ip_24h': '单IP每24小时注册上限',
            'unverified_user_expiry_hours': '无邮箱僵尸号清理时间(时)',
            'pending_dest_expiry_hours': '验证邮件未确认超时(时)',
            'allowed_countries': '允许注册的国家代码(ALL不限)',
            'allow_registration': '是否开放新注册',
            'enable_invitation_code': '是否启用邀请码',
            'enable_random_inbox': '是否启用随机邮箱页面',
            'random_inbox_domain': '随机邮箱后缀域名',
            'max_destination_duration_hours': '绑定验证邮箱最大有效期',
            'max_route_duration_hours': '专属域名邮箱最大有效期'
        };
        let currPage = 1;
        let mailPage = 1;
        let cfZones = [];

        function escapeHTML(s) {
            var map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'};
            return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch){ return map[ch]; });
        }
        function showT(msg, e){ const c=document.getElementById('toast-container'),t=document.createElement('div');t.className='px-4 py-2 rounded shadow-lg text-white text-sm transition-all translate-x-full opacity-0 ' + (e?'bg-rose-600':'bg-emerald-600');t.innerText=msg;c.appendChild(t); setTimeout(function(){t.classList.remove('translate-x-full','opacity-0');},10); setTimeout(function(){t.classList.add('translate-x-full','opacity-0');setTimeout(function(){t.remove();},300);},3000); }
        function configControl(i) {
            if (durationConfigKeys.indexOf(i.key) >= 0) {
                return '<select id="cfg-' + escapeHTML(i.key) + '" class="w-full px-3 py-1.5 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm outline-none focus:border-emerald-500">' + durationOptions.map(function(o){ return '<option value="' + o.value + '"' + (String(i.value) === o.value ? ' selected' : '') + '>' + o.label + '</option>'; }).join('') + '</select>';
            }
            if (booleanConfigKeys.indexOf(i.key) >= 0) {
                return '<select id="cfg-' + escapeHTML(i.key) + '" class="w-full px-3 py-1.5 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm outline-none focus:border-emerald-500"><option value="true"' + (String(i.value) === 'true' ? ' selected' : '') + '>true</option><option value="false"' + (String(i.value) === 'false' ? ' selected' : '') + '>false</option></select>';
            }
            return '<input type="text" id="cfg-' + escapeHTML(i.key) + '" value="' + escapeHTML(i.value) + '" class="w-full px-3 py-1.5 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm outline-none focus:border-emerald-500">';
        }
        window.onload = async function() {
            if((await fetch(basePath+'/config')).ok){
                document.getElementById('login-panel').style.display='none';
                document.getElementById('dashboard-panel').classList.remove('hidden');
                loadConfigs(); syncDomains(); loadUsers(1); loadInvites();
            }
        };
        function nav(tab){
            ['domains','invites','users','mails'].forEach(function(name){
                document.getElementById('view-'+name).style.display = tab===name?'block':'none';
                document.getElementById('nav-'+name).className = tab===name?'text-emerald-400 font-bold border-b-2 border-emerald-400 pb-1':'text-gray-400 hover:text-white font-bold pb-1 transition-colors';
            });
            if(tab === 'invites') loadInvites();
            if(tab === 'mails') loadMailLogs(1);
        }
        async function handleAdminLogin(e){ e.preventDefault(); const res=await fetch(basePath+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('admin-user').value,password:document.getElementById('admin-pass').value})}); if(res.ok)location.reload();else showT('验证失败，请检查账号密码',true);}
        async function loadConfigs(){
            const d = await (await fetch(basePath+'/config')).json();
            const rows = (d.data || []).sort(function(a,b){
                var ai = cfgOrder.indexOf(a.key), bi = cfgOrder.indexOf(b.key);
                return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
            });
            document.getElementById('config-list').innerHTML = rows.map(function(i){
                return '<div class="bg-gray-800 p-4 rounded-xl border border-gray-700 flex flex-col justify-between"><span class="text-sm font-bold text-emerald-400 mb-2">' + escapeHTML(cfgDict[i.key]||i.key) + ' <span class="text-gray-500 font-normal text-xs">(' + escapeHTML(i.key) + ')</span></span><div class="flex gap-2">' + configControl(i) + '<button onclick="saveC(\\'' + escapeHTML(i.key) + '\\')" class="bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/50 px-4 py-1.5 rounded-lg text-sm transition-colors whitespace-nowrap">保存</button></div></div>';
            }).join('');
        }
        async function saveC(k){
            const v=document.getElementById('cfg-'+k).value;
            const r=await fetch(basePath+'/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k,value:v})});
            const d = await r.json().catch(function(){ return {}; });
            showT(r.ok?'参数已保存':(d.error || '保存失败'),!r.ok);
            if(r.ok) loadConfigs();
        }
        async function syncDomains(){
            document.getElementById('domain-list').innerHTML='<span class="text-emerald-500 animate-pulse">正在穿透 CF 接口拉取全量域名...</span>';
            try {
                const cfResRaw = await fetch(basePath+'/cf-zones');
                const cfRes = await cfResRaw.json();
                if (cfRes.error) {
                    return document.getElementById('domain-list').innerHTML='<div class="p-4 bg-rose-900/30 border border-rose-800 rounded-lg text-rose-300"><b>CF 接口拒绝访问：</b><br/>' + escapeHTML(JSON.stringify(cfRes.details)) + '<br/>请检查 API 令牌是否拥有 Zone:Read 权限，以及是否授权了 All Zones。</div>';
                }
                const dbR = await fetch(basePath+'/domains');
                const dbD = (await dbR.json()).data||[];
                cfZones = cfRes.data||[];
                if(!cfZones.length) return document.getElementById('domain-list').innerHTML='<span class="text-gray-400">拉取成功，但您的账号下未找到任何可用域名。</span>';
                document.getElementById('sub-zone').innerHTML = cfZones.map(function(z, idx){ return '<option value="' + idx + '">' + escapeHTML(z.name) + '</option>'; }).join('');
                document.getElementById('domain-list').innerHTML = cfZones.map(function(z, idx){
                    const on = dbD.find(function(d){ return d.zone_id===z.id && d.domain===z.name; });
                    return on ? '<div class="flex justify-between items-center p-3 bg-emerald-900/30 border border-emerald-800 rounded-lg mb-2"><span class="text-emerald-200">' + escapeHTML(z.name) + '</span><button onclick="tDom(\\'del\\',' + on.id + ')" class="text-xs bg-rose-900/50 hover:bg-rose-900/80 text-rose-300 px-3 py-1.5 rounded transition-colors">取消授权并清空路由</button></div>'
                              : '<div class="flex justify-between items-center p-3 bg-gray-800 border border-gray-700 rounded-lg mb-2"><span class="text-gray-400">' + escapeHTML(z.name) + '</span><button onclick="tDom(\\'add\\',' + idx + ')" class="text-xs bg-gray-700 hover:bg-emerald-600 px-3 py-1.5 rounded transition-colors">授权开放</button></div>';
                }).join('');
                renderAuthorizedDomains(dbD);
            } catch (err) { document.getElementById('domain-list').innerHTML='<span class="text-rose-400">网络请求异常，请检查控制台。</span>'; }
        }
        function renderAuthorizedDomains(items){
            document.getElementById('authorized-domain-list').innerHTML = items.length ? items.map(function(d){
                const zone = cfZones.find(function(z){ return z.id === d.zone_id; });
                const isSub = zone && d.domain !== zone.name;
                return '<div class="flex justify-between items-center p-3 bg-gray-800 border border-gray-700 rounded-lg"><div><span class="text-emerald-200">' + escapeHTML(d.domain) + '</span><span class="ml-2 text-xs text-gray-500">' + (isSub ? '子域名' : '根域名') + '</span></div><button onclick="tDom(\\'del\\',' + d.id + ')" class="text-xs bg-rose-900/50 hover:bg-rose-900/80 text-rose-300 px-3 py-1.5 rounded transition-colors">删除</button></div>';
            }).join('') : '<div class="text-gray-500">当前还没有开放邮箱域名</div>';
        }
        async function tDom(act, ref){
            if(act==='del' && !confirm('高危操作：此操作将强行删除 Cloudflare 上该域名所属的所有用户路由！确定吗？')) return;
            if (act === 'del') await fetch(basePath+'/domains/'+ref,{method:'DELETE'});
            else {
                const z = cfZones[ref];
                const r = await fetch(basePath+'/domains',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain:z.name,zone_id:z.id,zone_name:z.name})});
                const d = await r.json().catch(function(){ return {}; });
                if(!r.ok) showT(d.error || '域名开放失败', true);
            }
            syncDomains();
        }
        async function addSubdomain(e){
            e.preventDefault();
            const z = cfZones[document.getElementById('sub-zone').value];
            if(!z) return showT('请先选择根域名', true);
            let sub = document.getElementById('sub-name').value.trim().toLowerCase();
            if(!sub) return showT('请输入子域名前缀', true);
            sub = sub.replace(/^@\\./,'').replace(/\\.$/,'');
            if(sub === z.name) return showT('根域名请使用上方授权开放，不要作为子域名添加', true);
            if(sub.indexOf('.') >= 0 && !sub.endsWith('.' + z.name)) return showT('完整子域名必须属于所选根域名', true);
            const full = sub.endsWith('.' + z.name) ? sub : sub + '.' + z.name;
            const r = await fetch(basePath+'/domains',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain:full,zone_id:z.id,zone_name:z.name})});
            const d = await r.json().catch(function(){ return {}; });
            showT(r.ok?'子域名已开放，Cloudflare Email Routing DNS 已配置':(d.error || '子域名开放失败'),!r.ok);
            if(r.ok){ document.getElementById('sub-name').value=''; syncDomains(); }
        }
        async function runCleanup(){
            const r = await fetch(basePath + '/cleanup', {method:'POST'});
            const d = await r.json().catch(function(){ return {}; });
            showT(r.ok?(d.message || '清理完成'):(d.error || '清理失败'), !r.ok);
        }
        function randomInvite(){
            const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            const bytes = new Uint8Array(12);
            if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
            else for (let i=0;i<bytes.length;i++) bytes[i] = Math.floor(Math.random() * 256);
            let code = '';
            for (let i=0;i<bytes.length;i++) code += alphabet[bytes[i] % alphabet.length];
            document.getElementById('new-invite-code').value = code.slice(0,4) + '-' + code.slice(4,8) + '-' + code.slice(8,12);
            if(!document.getElementById('new-invite-max').value) document.getElementById('new-invite-max').value = '1';
        }
        async function loadInvites(){
            const res = await fetch(basePath + '/invitations');
            if(!res.ok) return;
            const d = await res.json();
            document.getElementById('invite-table-body').innerHTML = (d.data || []).map(function(i){
                var code = escapeHTML(i.code), left = Math.max(0, Number(i.max_uses) - Number(i.used_count || 0));
                return '<tr class="hover:bg-gray-800 transition-colors"><td class="p-3 font-mono text-emerald-300">' + code + '</td><td class="p-3"><input id="inv-max-' + code + '" type="number" min="1" value="' + i.max_uses + '" class="w-24 px-2 py-1 bg-gray-900 border border-gray-700 rounded text-white"></td><td class="p-3"><input id="inv-used-' + code + '" type="number" min="0" value="' + (i.used_count || 0) + '" class="w-24 px-2 py-1 bg-gray-900 border border-gray-700 rounded text-white"></td><td class="p-3 text-gray-400">' + left + '</td><td class="p-3 text-xs text-gray-500">' + escapeHTML(new Date(i.created_at).toLocaleString()) + '</td><td class="p-3 whitespace-nowrap"><button onclick="saveInvite(\\'' + code + '\\')" class="text-xs bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 px-3 py-1.5 rounded mr-2">保存</button><button onclick="deleteInvite(\\'' + code + '\\')" class="text-xs bg-rose-900/50 text-rose-300 px-3 py-1.5 rounded">删除</button></td></tr>';
            }).join('') || '<tr><td colspan="6" class="text-center p-8 text-gray-500">还没有配置邀请码</td></tr>';
        }
        async function createInvite(e){
            e.preventDefault();
            const code = document.getElementById('new-invite-code').value.trim();
            const max = document.getElementById('new-invite-max').value;
            const r = await fetch(basePath + '/invitations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code,max_uses:max})});
            const d = await r.json();
            showT(r.ok?'邀请码已新增':(d.error || '新增失败'),!r.ok);
            if(r.ok){ document.getElementById('new-invite-code').value=''; document.getElementById('new-invite-max').value=''; loadInvites(); }
        }
        async function saveInvite(code){
            const max = document.getElementById('inv-max-'+code).value;
            const used = document.getElementById('inv-used-'+code).value;
            const r = await fetch(basePath + '/invitations/' + encodeURIComponent(code),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({max_uses:max,used_count:used})});
            const d = await r.json();
            showT(r.ok?'邀请码已保存':(d.error || '保存失败'),!r.ok);
            if(r.ok) loadInvites();
        }
        async function deleteInvite(code){
            if(!confirm('确定删除这个邀请码吗？')) return;
            const r = await fetch(basePath + '/invitations/' + encodeURIComponent(code),{method:'DELETE'});
            showT(r.ok?'邀请码已删除':'删除失败',!r.ok);
            if(r.ok) loadInvites();
        }
        async function loadUsers(page){
            currPage = page; const s = document.getElementById('search-user').value;
            const res = await fetch(basePath+'/users?page='+page+'&search='+encodeURIComponent(s));
            const d = await res.json();
            document.getElementById('user-table-body').innerHTML = (d.data || []).map(function(u){
                return '<tr class="hover:bg-gray-800 transition-colors"><td class="p-3 text-gray-400">' + u.id + '</td><td class="p-3 font-bold text-emerald-400">' + escapeHTML(u.username) + '</td><td class="p-3 text-xs font-mono text-gray-500">' + escapeHTML(u.reg_ip) + '</td><td class="p-3">' + (u.dest_email ? escapeHTML(u.dest_email) : '<span class="text-gray-600 italic">未验证</span>') + '</td><td class="p-3"><span class="bg-gray-700 px-2 py-1 rounded text-xs">' + u.route_count + ' 条</span></td><td class="p-3 text-xs text-gray-500">' + new Date(u.created_at).toLocaleString() + '</td><td class="p-3"><button onclick="deleteUser(' + u.id + ')" class="text-xs bg-rose-900/50 hover:bg-rose-900/80 text-rose-300 px-3 py-1.5 rounded transition-colors">清除</button></td></tr>';
            }).join('') || '<tr><td colspan="7" class="text-center p-8 text-gray-500">此页暂无数据记录</td></tr>';
            document.getElementById('page-info').innerText = '第 ' + page + ' 页';
        }
        async function deleteUser(id){
            if(!confirm('确定清除这个用户吗？该用户的底层收件箱、专属域名邮箱和会话都会被删除。')) return;
            const r = await fetch(basePath + '/users/' + id, {method:'DELETE'});
            const d = await r.json().catch(function(){ return {}; });
            showT(r.ok?(d.message || '用户已清除'):(d.error || '清除失败'), !r.ok);
            if(r.ok) loadUsers(currPage);
        }
        function changePage(d){ if(currPage+d>0) loadUsers(currPage+d); }
        function mailTypeLabel(t){
            const m = {temporary:'临时邮箱', user:'用户邮箱', wildcard:'泛匹配', rejected:'拒收'};
            return m[t] || t || '-';
        }
        function mailStatusLabel(s){
            const m = {stored:'已保存', forwarded:'已转发', rejected:'已拒收', forward_failed:'转发失败'};
            return m[s] || s || '-';
        }
        function mailBadgeClass(t){
            if(t === 'temporary') return 'bg-blue-900/50 text-blue-300 border-blue-700';
            if(t === 'user') return 'bg-emerald-900/50 text-emerald-300 border-emerald-700';
            if(t === 'wildcard') return 'bg-amber-900/50 text-amber-300 border-amber-700';
            return 'bg-rose-900/50 text-rose-300 border-rose-700';
        }
        async function loadMailLogs(page){
            mailPage = page;
            const type = document.getElementById('mail-type-filter').value;
            const search = document.getElementById('mail-search').value.trim();
            const res = await fetch(basePath + '/mail-logs?page=' + page + '&type=' + encodeURIComponent(type) + '&search=' + encodeURIComponent(search));
            const d = await res.json().catch(function(){ return {}; });
            if(!res.ok) return showT(d.error || '邮件记录加载失败', true);
            document.getElementById('mail-table-body').innerHTML = (d.data || []).map(function(m){
                return '<tr class="hover:bg-gray-800 transition-colors"><td class="p-3 text-gray-500">' + m.id + '</td><td class="p-3"><span class="border px-2 py-1 rounded text-xs ' + mailBadgeClass(m.mail_type) + '">' + escapeHTML(mailTypeLabel(m.mail_type)) + '</span></td><td class="p-3 text-xs text-gray-400">' + escapeHTML(mailStatusLabel(m.status)) + '</td><td class="p-3 max-w-[180px] truncate" title="' + escapeHTML(m.from_email || '') + '">' + escapeHTML(m.from_email || '-') + '</td><td class="p-3 max-w-[180px] truncate" title="' + escapeHTML(m.to_email || '') + '">' + escapeHTML(m.to_email || '-') + '</td><td class="p-3 max-w-[180px] truncate" title="' + escapeHTML(m.destination_email || '') + '">' + escapeHTML(m.destination_email || '-') + '</td><td class="p-3 max-w-[220px] truncate" title="' + escapeHTML(m.subject || '') + '">' + escapeHTML(m.subject || '(无主题)') + '</td><td class="p-3 text-xs text-gray-500 whitespace-nowrap">' + escapeHTML(new Date(m.created_at).toLocaleString()) + '</td><td class="p-3"><button onclick="openMailLog(' + m.id + ')" class="text-xs bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 px-3 py-1.5 rounded">查看</button></td></tr>';
            }).join('') || '<tr><td colspan="9" class="text-center p-8 text-gray-500">暂无邮件记录</td></tr>';
            document.getElementById('mail-page-info').innerText = '第 ' + page + ' 页';
        }
        function changeMailPage(d){ if(mailPage+d>0) loadMailLogs(mailPage+d); }
        async function openMailLog(id){
            const res = await fetch(basePath + '/mail-logs/' + id);
            const d = await res.json().catch(function(){ return {}; });
            if(!res.ok) return showT(d.error || '邮件详情加载失败', true);
            const m = d.data || {};
            const body = m.html
                ? '<iframe sandbox="" class="w-full min-h-[360px] bg-white rounded-lg border border-gray-700" srcdoc="' + escapeHTML(m.html) + '"></iframe>'
                : '<pre class="text-sm text-gray-300 bg-gray-900/70 border border-gray-700 rounded-lg p-4 max-h-[420px] overflow-auto">' + escapeHTML(m.text || '(暂无正文)') + '</pre>';
            document.getElementById('mail-detail-body').innerHTML =
                '<div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">' +
                '<div class="bg-gray-900/60 rounded-lg p-3"><span class="text-gray-500">类型</span><div class="text-white">' + escapeHTML(mailTypeLabel(m.mail_type)) + '</div></div>' +
                '<div class="bg-gray-900/60 rounded-lg p-3"><span class="text-gray-500">状态</span><div class="text-white">' + escapeHTML(mailStatusLabel(m.status)) + '</div></div>' +
                '<div class="bg-gray-900/60 rounded-lg p-3"><span class="text-gray-500">发件人</span><div class="text-white break-all">' + escapeHTML(m.from_email || '-') + '</div></div>' +
                '<div class="bg-gray-900/60 rounded-lg p-3"><span class="text-gray-500">收件人</span><div class="text-white break-all">' + escapeHTML(m.to_email || '-') + '</div></div>' +
                '<div class="bg-gray-900/60 rounded-lg p-3"><span class="text-gray-500">转发到</span><div class="text-white break-all">' + escapeHTML(m.destination_email || '-') + '</div></div>' +
                '<div class="bg-gray-900/60 rounded-lg p-3"><span class="text-gray-500">时间</span><div class="text-white">' + escapeHTML(new Date(m.created_at).toLocaleString()) + '</div></div>' +
                '<div class="md:col-span-2 bg-gray-900/60 rounded-lg p-3"><span class="text-gray-500">主题</span><div class="text-white break-all">' + escapeHTML(m.subject || '(无主题)') + '</div></div>' +
                (m.error ? '<div class="md:col-span-2 bg-rose-900/30 border border-rose-800 rounded-lg p-3 text-rose-200">错误：' + escapeHTML(m.error) + '</div>' : '') +
                '</div><div><h4 class="font-bold text-white mb-2">正文</h4>' + body + '</div>' +
                '<details class="bg-gray-900/60 rounded-lg border border-gray-700"><summary class="cursor-pointer px-4 py-3 text-sm text-gray-300">原始邮件 Raw</summary><pre class="text-xs text-gray-400 p-4 max-h-[420px] overflow-auto border-t border-gray-700">' + escapeHTML(m.raw || '') + '</pre></details>';
            document.getElementById('mail-detail-modal').classList.remove('hidden');
        }
        function closeMailLog(){ document.getElementById('mail-detail-modal').classList.add('hidden'); }
        async function logout(){ await fetch(basePath+'/logout',{method:'POST'}); location.reload(); }
    </script>
</body>
</html>`;

// ==========================================
// 3. 后端 API 逻辑
// ==========================================
export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname, method = req.method;
    const jsonRes = (d, s=200, h={}) => new Response(JSON.stringify(d), {status:s, headers:{'Content-Type':'application/json',...h}});

    if (!env.DB) return jsonRes({error:"请在Settings->Bindings里绑定大写 DB 数据库"}, 500);
    const db = env.DB, adminPath = env.ADMIN_PATH || '/admin';
    const genT = () => crypto.randomUUID(), getC = (n) => req.headers.get('Cookie')?.match(new RegExp('(^| )'+n+'=([^;]+)'))?.[2];

    try {
      await ensureSystem(db);
      const cfg = await getConfigMap(db);

      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      if (path === '/') return new Response(renderUserHTML(env.TURNSTILE_SITEKEY), {headers:{'Content-Type':'text/html;charset=utf-8'}});
      if (path === '/random-mail') return new Response(renderRandomInboxHTML(), {headers:{'Content-Type':'text/html;charset=utf-8'}});
      if (path === adminPath) return new Response(renderAdminHTML(adminPath), {headers:{'Content-Type':'text/html;charset=utf-8'}});
      if (path === '/api/public-config' && method === 'GET') return jsonRes(await getPublicConfig(db, cfg));

      if (path === '/api/random-inbox' && method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const inbox = await createRandomInbox(db, cfg, body.token || '');
        if (inbox.error) return jsonRes({error: inbox.error}, 403);
        return jsonRes({
          token: inbox.token,
          prefix: inbox.prefix,
          email: inbox.email,
          domain: inbox.domain,
          created_at: inbox.created_at
        });
      }

      if (path === '/api/random-inbox/messages' && method === 'GET') {
        const inbox = await getRandomInboxByToken(db, cfg, url.searchParams.get('token') || '');
        if (inbox.error) return jsonRes({error: inbox.error}, 403);
        const rows = (await db.prepare(`
          SELECT id,from_email,to_email,subject,created_at,
                 CASE WHEN html LIKE '%<img%' OR raw LIKE '%Content-Type: image/%' THEN 1 ELSE 0 END AS has_attachment
          FROM random_inbox_messages
          WHERE inbox_email=?
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT 50
        `).bind(inbox.email).all()).results || [];
        return jsonRes({email: inbox.email, messages: rows});
      }

      if (path.startsWith('/api/random-inbox/messages/') && method === 'GET') {
        const inbox = await getRandomInboxByToken(db, cfg, url.searchParams.get('token') || '');
        if (inbox.error) return jsonRes({error: inbox.error}, 403);
        const messageId = parseInt(path.split('/')[4], 10);
        if(!Number.isFinite(messageId)) return jsonRes({error:"邮件 ID 不正确"}, 400);
        const row = await db.prepare(`
          SELECT id,from_email,to_email,subject,text,html,raw,created_at
          FROM random_inbox_messages
          WHERE id=? AND inbox_email=?
        `).bind(messageId, inbox.email).first();
        if(!row) return jsonRes({error:"邮件不存在"}, 404);
        if (row.raw && ((!row.text && !row.html) || looksLikeRawMimeText(row.text) || hasMalformedInlineImage(row.html))) {
          const bodies = extractEmailBodies(row.raw);
          row.text = bodies.text;
          row.html = bodies.html;
          await db.prepare("UPDATE random_inbox_messages SET text=?, html=? WHERE id=?").bind(row.text, row.html, row.id).run();
        }
        const {raw, ...message} = row;
        return jsonRes({email: inbox.email, message});
      }

      // --- Admin Auth ---
      if (path.startsWith(adminPath)) {
        const act = path.replace(adminPath, '');
        if (act === '/login' && method === 'POST') {
          const {username, password} = await req.json();
          if (username===env.ADMIN_USERNAME && password===env.ADMIN_PASSWORD) {
            const t = genT(); await db.prepare("INSERT INTO sessions(token,role,expires_at) VALUES(?,'admin',datetime('now','+1 day'))").bind(t).run();
            return jsonRes({success:true}, 200, {'Set-Cookie':`admin_token=${t};HttpOnly;Path=${adminPath};Max-Age=86400;SameSite=Lax`});
          }
          return jsonRes({error:"密码错误"}, 401);
        }
        if (act === '/logout' && method === 'POST') return jsonRes({success:true}, 200, {'Set-Cookie':`admin_token=;HttpOnly;Path=${adminPath};Max-Age=0;SameSite=Lax`});

        const aT = getC('admin_token'); if(!aT) return jsonRes({error:"无权访问"}, 403);
        if(!(await db.prepare("SELECT 1 FROM sessions WHERE token=? AND role='admin' AND expires_at>datetime('now')").bind(aT).first())) return jsonRes({error:"登录状态失效"}, 403);

        if (act === '/mail-logs' && method === 'GET') {
          const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
          const type = String(url.searchParams.get('type') || 'all');
          const search = String(url.searchParams.get('search') || '').trim();
          const where = [];
          const binds = [];
          if (['temporary','user','wildcard','rejected'].includes(type)) {
            where.push('mail_type=?');
            binds.push(type);
          }
          if (search) {
            where.push('(from_email LIKE ? OR to_email LIKE ? OR destination_email LIKE ? OR subject LIKE ?)');
            const like = '%' + search + '%';
            binds.push(like, like, like, like);
          }
          const sql = `
            SELECT id,mail_type,status,message_id,from_email,to_email,destination_email,subject,route_id,user_id,error,created_at
            FROM mail_logs
            ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY datetime(created_at) DESC, id DESC
            LIMIT 30 OFFSET ?
          `;
          const rows = (await db.prepare(sql).bind(...binds, (page - 1) * 30).all()).results || [];
          return jsonRes({data: rows});
        }

        if (act.startsWith('/mail-logs/') && method === 'GET') {
          const id = parseInt(act.split('/')[2], 10);
          if(!Number.isFinite(id)) return jsonRes({error:"邮件记录 ID 不正确"}, 400);
          const row = await db.prepare("SELECT * FROM mail_logs WHERE id=?").bind(id).first();
          if(!row) return jsonRes({error:"邮件记录不存在"}, 404);
          if (row.raw && ((!row.text && !row.html) || looksLikeRawMimeText(row.text) || hasMalformedInlineImage(row.html))) {
            const bodies = extractEmailBodies(row.raw);
            row.text = bodies.text;
            row.html = bodies.html;
            await db.prepare("UPDATE mail_logs SET text=?, html=? WHERE id=?").bind(row.text, row.html, row.id).run();
          }
          return jsonRes({data: row});
        }

        if (act === '/config' && method === 'GET') return jsonRes({data:(await db.prepare("SELECT key, value FROM sys_config").all()).results});
        if (act === '/config' && method === 'POST') {
          const {key, value} = await req.json();
          if (!DEFAULT_CONFIGS.some(([k]) => k === key)) return jsonRes({error:"未知配置项"}, 400);
          if (BOOLEAN_CONFIG_KEYS.has(key) && !['true','false'].includes(String(value))) return jsonRes({error:"该配置只能选择 true 或 false"}, 400);
          if (DURATION_CONFIG_KEYS.has(key) && !isValidDuration(value)) return jsonRes({error:"有效期只能从预设选项中选择"}, 400);

          const nextCfg = {...cfg, [key]: String(value)};
          if (key === 'random_inbox_domain' && String(value).trim() && !isValidDomainName(normalizeDomain(value))) {
            return jsonRes({error:"随机邮箱后缀域名格式不正确"}, 400);
          }
          if (nextCfg.enable_random_inbox === 'true' && !isValidDomainName(normalizeDomain(nextCfg.random_inbox_domain))) {
            return jsonRes({error:"启用随机邮箱前，请先配置正确的随机邮箱后缀域名"}, 400);
          }
          if (durationRank(nextCfg.max_route_duration_hours) > durationRank(nextCfg.max_destination_duration_hours)) {
            return jsonRes({error:"专属域名邮箱最大有效期不能超过绑定验证邮箱最大有效期"}, 400);
          }

          const savedValue = key === 'random_inbox_domain' ? normalizeDomain(value) : String(value);
          const savedCfg = {...nextCfg, [key]: savedValue};
          if (savedCfg.enable_random_inbox === 'true' && ['enable_random_inbox','random_inbox_domain'].includes(key)) {
            const routed = await ensureRandomInboxCfRouting(db, env, savedCfg, req.url);
            if (!routed.ok) return jsonRes({error:routed.error, details:routed.details}, 500);
          }
          await db.prepare("INSERT INTO sys_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, savedValue).run();
          return jsonRes({success:true});
        }

        if (act === '/cleanup' && method === 'POST') {
          await runTimedCleanup(db, env, cfg);
          return jsonRes({success:true, message:"过期数据已清理"});
        }

        // --- 拉取所有域名 ---
        if (act === '/cf-zones' && method === 'GET') {
          const zR = await fetch('https://api.cloudflare.com/client/v4/zones', {headers:{'Authorization':`Bearer ${env.CF_API_TOKEN}`}});
          const zData = await zR.json();
          if(!zData.success) return jsonRes({error:true, details: zData.errors}, 400);
          return jsonRes({data: zData.result || []});
        }

        if (act === '/domains' && method === 'GET') return jsonRes({data:(await db.prepare("SELECT * FROM domains ORDER BY domain ASC").all()).results});
        if (act === '/domains' && method === 'POST') {
          const {domain, zone_id, zone_name} = await req.json();
          const cleanDomain = normalizeDomain(domain);
          const cleanZoneName = normalizeDomain(zone_name || domain);
          if(!zone_id) return jsonRes({error:"缺少 Zone ID"},400);
          if(!isValidDomainName(cleanDomain)) return jsonRes({error:"域名格式不正确"},400);
          if(!isValidDomainName(cleanZoneName) || !domainBelongsToZone(cleanDomain, cleanZoneName)) return jsonRes({error:"子域名必须属于所选根域名"},400);
          if(await db.prepare("SELECT id FROM domains WHERE domain=?").bind(cleanDomain).first()) return jsonRes({error:"这个邮箱域名已经开放"},400);

          if(cleanDomain !== cleanZoneName) {
            const cf = await cfEnableEmailRoutingDomain(zone_id, cleanDomain, env);
            const details = JSON.stringify(cf.data?.errors || cf.data?.messages || cf.data || {});
            if(!cf.ok && !/already|exist|enabled|configured/i.test(details)) {
              return jsonRes({error:"Cloudflare 未能启用该子域名的 Email Routing DNS，请确认 API Token 有 Zone Settings Write 权限", details: cf.data?.errors || cf.data},500);
            }
          }

          await db.prepare("INSERT INTO domains(domain,zone_id) VALUES(?,?)").bind(cleanDomain, zone_id).run();
          return jsonRes({success:true});
        }
        if (act.startsWith('/domains/') && method === 'DELETE') {
          const id = act.split('/')[2], dData = await db.prepare("SELECT zone_id FROM domains WHERE id=?").bind(id).first();
          if (dData) {
            const rts = await db.prepare("SELECT cf_rule_id,tag FROM email_routes WHERE domain_id=?").bind(id).all();
            for(let r of rts.results) await cfRemoveEmailRoute({...r, zone_id: dData.zone_id}, env);
            await db.prepare("DELETE FROM email_routes WHERE domain_id=?").bind(id).run();
            await db.prepare("DELETE FROM domains WHERE id=?").bind(id).run();
          }
          return jsonRes({success:true});
        }

        if (act === '/invitations' && method === 'GET') {
          return jsonRes({data:(await db.prepare("SELECT code,max_uses,used_count,created_at FROM invitation_codes ORDER BY created_at DESC").all()).results});
        }
        if (act === '/invitations' && method === 'POST') {
          const {code, max_uses} = await req.json();
          const cleanCode = String(code || '').trim();
          const maxUses = parseInt(max_uses, 10);
          if(!/^[A-Za-z0-9_-]{3,64}$/.test(cleanCode)) return jsonRes({error:"邀请码只能使用 3-64 位字母、数字、下划线或短横线"}, 400);
          if(!Number.isFinite(maxUses) || maxUses < 1) return jsonRes({error:"最大使用次数必须大于 0"}, 400);
          try {
            await db.prepare("INSERT INTO invitation_codes(code,max_uses,used_count) VALUES(?,?,0)").bind(cleanCode, maxUses).run();
            return jsonRes({success:true});
          } catch (_) {
            return jsonRes({error:"这个邀请码已经存在"}, 400);
          }
        }
        if (act.startsWith('/invitations/') && method === 'PUT') {
          const code = decodeURIComponent(act.split('/')[2] || '');
          const {max_uses, used_count} = await req.json();
          const maxUses = parseInt(max_uses, 10);
          const usedCount = parseInt(used_count, 10);
          if(!Number.isFinite(maxUses) || maxUses < 1) return jsonRes({error:"最大使用次数必须大于 0"}, 400);
          if(!Number.isFinite(usedCount) || usedCount < 0 || usedCount > maxUses) return jsonRes({error:"已使用次数必须在 0 到最大次数之间"}, 400);
          await db.prepare("UPDATE invitation_codes SET max_uses=?, used_count=? WHERE code=?").bind(maxUses, usedCount, code).run();
          return jsonRes({success:true});
        }
        if (act.startsWith('/invitations/') && method === 'DELETE') {
          const code = decodeURIComponent(act.split('/')[2] || '');
          await db.prepare("DELETE FROM invitation_codes WHERE code=?").bind(code).run();
          return jsonRes({success:true});
        }

        if (act.startsWith('/users/') && method === 'DELETE') {
          const userId = parseInt(act.split('/')[2], 10);
          if(!Number.isFinite(userId)) return jsonRes({error:"用户 ID 不正确"},400);
          const user = await db.prepare("SELECT id FROM users WHERE id=?").bind(userId).first();
          if(!user) return jsonRes({error:"用户不存在"},404);
          await deleteUserAccount(db, env, userId);
          return jsonRes({success:true, message:"用户已清除"});
        }

        if (act.startsWith('/users') && method === 'GET') {
          const page = parseInt(url.searchParams.get('page') || '1'), search = url.searchParams.get('search') || '';
          const offset = (page - 1) * 20;
          const q = `SELECT u.id, u.username, u.reg_ip, u.created_at, d.email as dest_email, (SELECT COUNT(*) FROM email_routes r WHERE r.user_id=u.id AND r.status='active' AND (r.expires_at IS NULL OR datetime(r.expires_at)>datetime('now'))) as route_count FROM users u LEFT JOIN user_destinations d ON u.id = d.user_id AND d.status!='expired' WHERE u.username LIKE ? ORDER BY u.id DESC LIMIT 20 OFFSET ?`;
          const users = await db.prepare(q).bind('%'+search+'%', offset).all();
          return jsonRes({data: users.results});
        }
        return jsonRes({error:"请求不存在"}, 404);
      }

      // --- 用户公共 API ---
      const verifyT = async(t,ip) => {
        if(!env.TURNSTILE_SECRET) return {ok:false, error:"Turnstile Secret 未配置"};
        if(!t) return {ok:false, error:"请完成人机验证"};
        const body = new URLSearchParams();
        body.set('secret', env.TURNSTILE_SECRET);
        body.set('response', t);
        if(ip && ip !== '0' && ip !== '0.0.0.0') body.set('remoteip', ip);
        try {
          const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {method:'POST', body});
          const data = await res.json();
          if(data.success) return {ok:true};
          const codes = data['error-codes'] || [];
          if(codes.includes('timeout-or-duplicate')) return {ok:false, error:"人机验证已过期或已被使用，请重新勾选验证"};
          if(codes.includes('invalid-input-secret')) return {ok:false, error:"Turnstile Secret 配置错误"};
          if(codes.includes('invalid-input-response') || codes.includes('missing-input-response')) return {ok:false, error:"人机验证无效，请刷新页面后重试"};
          return {ok:false, error:"人机验证失败，请重试"};
        } catch (_) {
          return {ok:false, error:"人机验证服务暂时不可用，请稍后重试"};
        }
      };

      if (path === '/api/register' && method === 'POST') {
        const {username, password, turnstileToken, invitationCode} = await req.json(), ip = req.headers.get('CF-Connecting-IP')||'0.0.0.0';
        const turnstile = await verifyT(turnstileToken, ip);
        if (!turnstile.ok) return jsonRes({error:turnstile.error},400);

        if (cfg.allow_registration !== 'true') return jsonRes({error:"抱歉，系统当前已关闭新用户注册"},403);
        if (cfg.allowed_countries!=='ALL' && !cfg.allowed_countries.split(',').includes(req.cf?.country||'XX')) return jsonRes({error:"地区拦截：您所在的地区暂时不允许注册"},403);
        let maxUsers = parseInt(cfg.max_users || '1000', 10);
        if(!Number.isFinite(maxUsers) || maxUsers < 0) maxUsers = 1000;
        if ((await db.prepare("SELECT COUNT(*) as c FROM users").first()).c >= maxUsers) return jsonRes({error:"系统名额已被注册完毕"},403);

        const inviteCount = (await db.prepare("SELECT COUNT(*) AS c FROM invitation_codes").first())?.c || 0;
        const inviteRequired = cfg.enable_invitation_code === 'true' && inviteCount > 0;
        let invite = null;
        if (inviteRequired) {
          const code = String(invitationCode || '').trim();
          if (!code) return jsonRes({error:"请输入邀请码"}, 400);
          invite = await db.prepare("SELECT code,max_uses,used_count FROM invitation_codes WHERE code=?").bind(code).first();
          if (!invite || invite.used_count >= invite.max_uses) return jsonRes({error:"邀请码不存在或已被用完"}, 400);
        }

        let ipLim = parseInt(cfg.max_regs_per_ip_24h || '1', 10);
        if(!Number.isFinite(ipLim) || ipLim < 1) ipLim = 1;
        if ((await db.prepare("SELECT COUNT(*) as c FROM users WHERE reg_ip=? AND created_at>datetime('now','-1 day')").bind(ip).first()).c >= ipLim) {
          return jsonRes({error:`风控拦截：每个 IP 每 24 小时仅允许注册 ${ipLim} 个账号`},429);
        }

        try {
          await db.prepare("INSERT INTO users(username,password,reg_ip) VALUES(?,?,?)").bind(username,password,ip).run();
          if (invite) await db.prepare("UPDATE invitation_codes SET used_count=used_count+1 WHERE code=?").bind(invite.code).run();
          return jsonRes({success:true});
        } catch (_) {
          return jsonRes({error:"用户名已被占用，换一个吧"},400);
        }
      }

      if (path === '/api/login' && method === 'POST') {
        const {username, password, turnstileToken} = await req.json();
        const turnstile = await verifyT(turnstileToken,req.headers.get('CF-Connecting-IP')||'');
        if (!turnstile.ok) return jsonRes({error:turnstile.error},400);
        const u = await db.prepare("SELECT id FROM users WHERE username=? AND password=?").bind(username,password).first();
        if(!u) return jsonRes({error:"账号或密码输入不正确"},401);
        const t = genT(); await db.prepare("INSERT INTO sessions(token,user_id,role,expires_at) VALUES(?,?,'user',datetime('now','+7 days'))").bind(t,u.id).run();
        return jsonRes({success:true},200,{'Set-Cookie':`session_token=${t};HttpOnly;Path=/;Max-Age=604800;SameSite=Lax`});
      }

      if (path === '/api/logout' && method === 'POST') return jsonRes({success:true},200,{'Set-Cookie':'session_token=;HttpOnly;Path=/;Max-Age=0;SameSite=Lax'});

      const uT = getC('session_token'); if(!uT) return jsonRes({error:"请先登录"},401);
      const uS = await db.prepare("SELECT user_id FROM sessions WHERE token=? AND role='user' AND expires_at>datetime('now')").bind(uT).first(); if(!uS) return jsonRes({error:"会话已过期，请重新登录"},401);

      if (path === '/api/check-session') return jsonRes({success:true});
      if (path === '/api/me') return jsonRes(await getUserState(db, env, uS.user_id, cfg));
      if (path === '/api/domains') return jsonRes((await db.prepare("SELECT id,domain FROM domains ORDER BY domain ASC").all()).results);

      if (path === '/api/password' && method === 'POST') {
        const {oldPassword, newPassword} = await req.json();
        if (String(newPassword || '').length < 6) return jsonRes({error:"新密码至少 6 位"},400);
        const user = await db.prepare("SELECT password FROM users WHERE id=?").bind(uS.user_id).first();
        if(!user || user.password !== oldPassword) return jsonRes({error:"当前密码不正确"},403);
        await db.prepare("UPDATE users SET password=? WHERE id=?").bind(newPassword, uS.user_id).run();
        await db.prepare("DELETE FROM sessions WHERE user_id=? AND token!=?").bind(uS.user_id, uT).run();
        return jsonRes({message:"密码已修改"});
      }

      if (path === '/api/account' && method === 'DELETE') {
        const {password} = await req.json();
        const user = await db.prepare("SELECT password FROM users WHERE id=?").bind(uS.user_id).first();
        if(!user || user.password !== password) return jsonRes({error:"当前密码不正确"},403);
        await deleteUserAccount(db, env, uS.user_id);
        return jsonRes({message:"账号已注销"},200,{'Set-Cookie':'session_token=;HttpOnly;Path=/;Max-Age=0;SameSite=Lax'});
      }

      if (path === '/api/destination' && method === 'DELETE') {
        const removed = await deleteUserDestination(db, env, uS.user_id);
        if(!removed) return jsonRes({error:"当前没有可删除的底层收件箱"},400);
        return jsonRes({message:"底层收件箱已删除，相关专属域名邮箱也已移除"});
      }

      if (path === '/api/destination' && method === 'POST') {
        await expireLocalForUser(db, env, uS.user_id, cfg);
        const {email, durationHours} = await req.json();
        const chosenDuration = String(durationHours || '');
        if(!isValidDuration(chosenDuration)) return jsonRes({error:"请选择有效的邮箱有效期"},400);
        if(!isWithinMaxDuration(chosenDuration, cfg.max_destination_duration_hours || '168')) return jsonRes({error:"超过管理员允许的绑定邮箱最大有效期"},403);
        if(await db.prepare("SELECT id FROM user_destinations WHERE user_id=? AND status!='expired'").bind(uS.user_id).first()) return jsonRes({error:"您已经绑定了一个未过期的邮箱"},400);

        let cfgMaxD = parseInt(cfg.max_total_destinations || '180', 10);
        if(!Number.isFinite(cfgMaxD) || cfgMaxD < 0) cfgMaxD = 180;
        if((await db.prepare("SELECT COUNT(*) as c FROM user_destinations WHERE status!='expired'").first()).c >= cfgMaxD) return jsonRes({error:"系统全局目标邮箱配额已满"},403);

        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses`, {method:'POST',headers:{'Authorization':`Bearer ${env.CF_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({email})});
        const d = await r.json(); if(!d.success) return jsonRes({error:"Cloudflare 限制或邮箱格式有误", details:d.errors},500);

        await db.prepare(`
          INSERT INTO user_destinations(user_id,cf_address_id,email,status,expires_at,duration_hours,created_at)
          VALUES(?,?,?,'pending',NULL,?,datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET cf_address_id=excluded.cf_address_id,email=excluded.email,status='pending',expires_at=NULL,duration_hours=excluded.duration_hours,created_at=datetime('now')
        `).bind(uS.user_id,d.result.id,email,chosenDuration).run();
        return jsonRes({message:"验证邮件已发送，请前往底层收件箱确认。"});
      }

      if (path === '/api/destination/refresh' && method === 'POST') {
        await expireLocalForUser(db, env, uS.user_id, cfg);
        const dest = await db.prepare("SELECT * FROM user_destinations WHERE user_id=? AND status!='expired'").bind(uS.user_id).first();
        if(!dest) return jsonRes({error:"当前没有等待验证的邮箱，请重新发送验证邮件"},400);
        if(dest.status === 'verified') return jsonRes({message:"邮箱已经完成验证"});
        if(dest.status !== 'pending') return jsonRes({error:"当前邮箱状态无法刷新验证"},400);

        const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses/${dest.cf_address_id}`,{headers:{'Authorization':`Bearer ${env.CF_API_TOKEN}`}});
        const cfAddress = await r.json();
        if(!cfAddress.result?.verified) return jsonRes({error:"还没有检测到验证完成，请确认邮箱里的验证链接已经点击"},400);

        const chosenDuration = isValidDuration(dest.duration_hours) ? dest.duration_hours : (cfg.max_destination_duration_hours || '168');
        const expiresAt = expiryFromDuration(chosenDuration);
        await db.prepare("UPDATE user_destinations SET status='verified', expires_at=? WHERE id=?").bind(expiresAt, dest.id).run();
        return jsonRes({message:"邮箱验证已刷新成功，现在可以创建专属域名邮箱。"});
      }

      if (path.startsWith('/api/routes/') && method === 'DELETE') {
        const routeId = parseInt(path.split('/')[3], 10);
        if(!Number.isFinite(routeId)) return jsonRes({error:"路由 ID 不正确"},400);
        const removed = await deleteRouteById(db, env, routeId, uS.user_id);
        if(!removed) return jsonRes({error:"这个专属域名邮箱不存在或不属于您"},404);
        return jsonRes({message:"专属域名邮箱已删除"});
      }

      if (path === '/api/routes' && method === 'POST') {
        await expireLocalForUser(db, env, uS.user_id, cfg);
        const {prefix, domainId, durationHours} = await req.json();
        const cleanPrefix = String(prefix || '').trim().toLowerCase();
        const chosenDuration = String(durationHours || '');
        const isWildcardRoute = cleanPrefix === WILDCARD_PREFIX;
        if(cleanPrefix.includes(WILDCARD_PREFIX) && !isWildcardRoute) return jsonRes({error:"泛匹配前缀仅支持单独输入 *"},400);
        if(!isWildcardRoute && !ROUTE_PREFIX_RE.test(cleanPrefix)) return jsonRes({error:"邮箱前缀只能使用字母、数字、点、下划线、加号、短横线，或单独输入 * 泛匹配"},400);
        if(!isValidDuration(chosenDuration)) return jsonRes({error:"请选择专属域名邮箱有效期"},400);
        if(!isWithinMaxDuration(chosenDuration, cfg.max_route_duration_hours || '72')) return jsonRes({error:"超过管理员允许的专属域名邮箱最大有效期"},403);

        const d = await db.prepare("SELECT * FROM user_destinations WHERE user_id=? AND status!='expired'").bind(uS.user_id).first();
        if(!d) return jsonRes({error:"请先绑定并验证您的真实收件箱"},400);
        if(d.status === 'pending') return jsonRes({error:"请先点击“刷新验证”，确认底层收件箱已经完成验证"},400);
        if(d.status !== 'verified') return jsonRes({error:"真实收件箱状态不可用，请重新绑定"},400);
        if(d.duration_hours && durationRank(chosenDuration) > durationRank(d.duration_hours)) return jsonRes({error:"专属域名邮箱有效期不能超过绑定邮箱有效期"},400);

        const routeRawExpiry = expiryFromDuration(chosenDuration);
        const routeExpiry = minExpiry(routeRawExpiry, d.expires_at);
        if(chosenDuration === 'permanent' && d.expires_at) return jsonRes({error:"绑定邮箱不是永久有效，专属域名邮箱不能选择永久"},400);

        let cfgMaxR = parseInt(cfg.max_routes_per_user || '10', 10);
        if(!Number.isFinite(cfgMaxR) || cfgMaxR < 0) cfgMaxR = 10;
        if((await db.prepare("SELECT COUNT(*) as c FROM email_routes WHERE user_id=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))").bind(uS.user_id).first()).c >= cfgMaxR) return jsonRes({error:"您的专属域名邮箱配额已耗尽"},403);

        const dom = await db.prepare("SELECT * FROM domains WHERE id=?").bind(domainId).first(); if(!dom) return jsonRes({error:"您选择的域名不存在或已被下架"},400);
        const activeDomainRoutes = (await db.prepare("SELECT id,tag FROM email_routes WHERE domain_id=? AND status='active' AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))").bind(dom.id).all()).results || [];
        const wildcardOwner = activeDomainRoutes.find((route) => route.tag === WILDCARD_PREFIX);
        if(activeDomainRoutes.some((route) => route.tag === cleanPrefix)) return jsonRes({error:"该前缀已被占用，请换一个重试"},400);
        if(isWildcardRoute && activeDomainRoutes.length) return jsonRes({error:"该域名已有专属邮箱，暂不能创建泛匹配前缀"},400);
        if(!isWildcardRoute && wildcardOwner) return jsonRes({error:"该域名已被泛匹配前缀占用，请换一个域名"},400);

        let cfD;
        if (isWildcardRoute) {
          const workerName = getWorkerNameFromRequest(env, req.url);
          if(!workerName) return jsonRes({error:"无法识别 Worker 名称。使用自定义域名访问时，请配置环境变量 CF_WORKER_NAME 为当前 Worker 名称"},500);
          const catchAll = await cfGetCatchAll(dom.zone_id, env);
          if(!catchAll.ok) return jsonRes({error:"无法读取 Cloudflare 泛匹配路由状态，请检查 API Token 权限", details:catchAll.data?.errors || catchAll.data},500);
          const currentActions = catchAll.data?.result?.actions || [];
          const alreadyTargetWorker = currentActions.some((action) => action.type === 'worker' && (action.value || []).includes(workerName));
          if(catchAll.data?.result?.enabled && !alreadyTargetWorker) return jsonRes({error:"该域名已存在启用中的泛匹配路由。为避免覆盖现有规则，请先在 Cloudflare Email Routing 中移除，或改用独立子域名"},400);
          const cfCatchAll = await cfEnableCatchAllWorker(dom.zone_id, env, workerName);
          cfD = cfCatchAll.data;
          if(!cfCatchAll.ok) return jsonRes({error:"泛匹配路由创建失败，请确认 Cloudflare Email Routing 已启用", details:cfD.errors},500);
        } else {
          const cfR = await fetch(`https://api.cloudflare.com/client/v4/zones/${dom.zone_id}/email/routing/rules`,{method:'POST',headers:{'Authorization':`Bearer ${env.CF_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({actions:[{type:"forward",value:[d.email]}],matchers:[{type:"literal",field:"to",value:`${cleanPrefix}@${dom.domain}`}],enabled:true,name:`U-${uS.user_id}-${cleanPrefix}`})});
          cfD = await cfR.json(); if(!cfD.success) return jsonRes({error:"该前缀已被别人占用啦，请换一个重试", details:cfD.errors},500);
        }

        const cfRuleId = cfD.result?.id || (isWildcardRoute ? 'catch_all_worker' : null);
        if(!cfRuleId) return jsonRes({error:"Cloudflare 未返回路由 ID，请稍后重试", details:cfD},500);
        await db.prepare("INSERT INTO email_routes(user_id,cf_rule_id,tag,domain_id,expires_at,duration_hours,status) VALUES(?,?,?,?,?,?,'active')").bind(uS.user_id,cfRuleId,cleanPrefix,domainId,routeExpiry,chosenDuration).run();
        return jsonRes({success:true});
      }
      return jsonRes({error:"404 Not Found"},404);
    } catch (e) { return jsonRes({error:"Server Error",m:e.message},500); }
  },

  async scheduled(evt, env) {
    if(!env.DB) return; const db = env.DB;
    await ensureSystem(db);
    const cfg = await getConfigMap(db);
    await runTimedCleanup(db, env, cfg);
  },

  async email(message, env, ctx) {
    if(!env.DB) return message.setReject("DB not configured");
    const db = env.DB;
    await ensureSystem(db);
    const cfg = await getConfigMap(db);
    const raw = await readEmailRaw(message);
    const snapshot = buildMailSnapshot(message, raw);

    const stored = await storeRandomInboxMessage(db, cfg, message, snapshot);
    if (stored) {
      await writeMailLog(db, {...snapshot, mailType:'temporary', status:'stored'});
      return;
    }

    if (isRandomInboxRecipient(cfg, message.to)) {
      await writeMailLog(db, {...snapshot, mailType:'temporary', status:'rejected', error:'Random mailbox not found'});
      return message.setReject("Random mailbox not found");
    }

    const route = await findUserRouteForMessage(db, message);
    if (route?.destination_email) {
      const mailType = route.tag === WILDCARD_PREFIX ? 'wildcard' : 'user';
      try {
        await message.forward(route.destination_email);
        await writeMailLog(db, {
          ...snapshot,
          mailType,
          status:'forwarded',
          destinationEmail: route.destination_email,
          routeId: route.route_id,
          userId: route.user_id
        });
        return;
      } catch (err) {
        await writeMailLog(db, {
          ...snapshot,
          mailType,
          status:'forward_failed',
          destinationEmail: route.destination_email,
          routeId: route.route_id,
          userId: route.user_id,
          error: err?.message || String(err)
        });
        return message.setReject("Forward failed");
      }
    }

    await writeMailLog(db, {...snapshot, mailType:'rejected', status:'rejected', error:'Mailbox not found'});
    return message.setReject("Mailbox not found");
  }
};
