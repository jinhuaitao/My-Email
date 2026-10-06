/**
 * Cloudflare Workers 邮箱客户端 - v12.0 (终极重构解析内核版)
 * 更新内容：
 * 1. 彻底攻克 Header Folding (头部折叠) Bug：精准重组跨行 Boundary 和解码声明。
 * 2. 引入智能 \uFFFD (菱形乱码) 嗅探器：自动捕获未声明 charset 的哑巴 GBK 邮件并强制回退解码。
 * 3. 使用双换行 (\r\n\r\n) 的绝对标准定位 Body，免疫魔方等系统的畸形空行。
 * 4. 彻底修复手机端过长邮件无法向下滚动的 UI 布局问题 (min-h-0 + inset-0)。
 */

const CONFIG_FILE = 'sys_config.json';
const SESSION_NAME = 'auth_session';
const TRASH_PREFIX = 'trash/';

// 内部系统键前缀。登录限流计数等放在这里，永远不会出现在邮件列表里。
const SYS_PREFIX = '_sys/';

// 应用内设置（转发邮箱、Turnstile 密钥）。放在 _sys/ 前缀下，天然不会出现在邮件列表里。
const SETTINGS_FILE = SYS_PREFIX + 'settings.json';

// 会话有效期（服务端校验，Cookie 的 Max-Age 只是客户端约束）
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// 登录限流：同一 IP 在窗口期内失败达到阈值即锁定一段时间
const MAX_LOGIN_FAILS = 8;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

// 统一安全响应头。注意：邮件正文 iframe 走单独的响应头，不带 X-Frame-Options。
const BASE_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cache-Control': 'no-store'
};

// ---------- 正文翻译（Workers AI） ----------
// 模型：@cf/meta/m2m100-1.2b —— 多对多翻译模型，不产生幻觉内容，只做翻译。
// 输入 { text, source_lang, target_lang }，输出 { translated_text }。
// 注意 source_lang 默认是 english，所以非英文邮件必须显式给出源语言（见 detectSourceLang）。
const TRANSLATE_MODEL = '@cf/meta/m2m100-1.2b';
const TRANSLATE_TARGET = 'chinese';
// 该模型只支持这 10 种语言（取自模型元数据），不在列表里的语种只能明确报错，不能硬翻。
const TRANSLATE_LANGS = ['english', 'chinese', 'french', 'spanish', 'arabic', 'russian', 'german', 'japanese', 'portuguese', 'hindi'];
// 分段翻译：单次请求塞太长会被模型截断，按段落切开分别翻再拼回去。
const TRANSLATE_CHUNK_SIZE = 2500;
const TRANSLATE_MAX_CHUNKS = 6;

// ==========================================
// 1. PWA & UI 资源
// ==========================================

const renderAppIcon = () => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="128" fill="#4f46e5"/>
  <path d="M112 160h288c17.6 0 32 14.4 32 32v192c0 17.6-14.4 32-32 32H112c-17.6 0-32-14.4-32-32V192c0-17.6 14.4-32 32-32zm20.8 32l106.6 86.6c9.6 7.8 23.6 7.8 33.2 0L379.2 192H132.8z" fill="white"/>
</svg>`;

const renderManifest = () => JSON.stringify({
    name: "Cloudflare Mail",
    short_name: "CF Mail",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#4f46e5",
    orientation: "portrait-primary",
    icons: [
        { src: "/logo.svg", sizes: "any", type: "image/svg+xml" },
        { src: "/logo.svg", sizes: "192x192", type: "image/svg+xml" },
        { src: "/logo.svg", sizes: "512x512", type: "image/svg+xml" }
    ]
});

const renderServiceWorker = () => `
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });
`;

// ==========================================
// 2. 核心底层解析引擎
// ==========================================

// ---------- 通用工具：HTML 转义 / 随机数 / 常量时间比较 ----------

// 所有来自邮件（发件人、主题、附件名）或用户输入的字符串，拼进 HTML 前必须转义。
// 邮件主题和发件人显示名完全由攻击者控制，不转义就是一个 XSS。
function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/[&<>"']/g, function (c) {
            if (c === '&') return '&amp;';
            if (c === '<') return '&lt;';
            if (c === '>') return '&gt;';
            if (c === '"') return '&quot;';
            return '&#39;';
        });
}

// 属性值场景与文本场景用同一套转义即可（已覆盖引号）
function escapeAttr(value) {
    return escapeHtml(value);
}

function randomHex(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
}

// 口令比对不能用 ===（会因提前返回而泄漏前缀信息），逐字符异或累加。
function safeEqual(a, b) {
    const x = String(a === null || a === undefined ? '' : a);
    const y = String(b === null || b === undefined ? '' : b);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
}

async function sha256Hex(text) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 加盐哈希：salt 为空时退化为 sha256(password)，用于兼容早期无盐版本的数据。
async function hashPassword(password, salt) {
    return sha256Hex(salt ? salt + ':' + password : String(password));
}

async function verifyPassword(config, password) {
    if (config.salt) return safeEqual(await hashPassword(password, config.salt), config.password);
    return safeEqual(await hashPassword(password), config.password);
}

// ---------- 统一响应构造 ----------

function htmlResponse(body, status = 200, extra = {}) {
    return new Response(body, {
        status,
        headers: Object.assign({}, BASE_HEADERS, {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Frame-Options': 'DENY'
        }, extra)
    });
}

function jsonResponse(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': 'application/json; charset=utf-8' }, extra)
    });
}

function textResponse(body, status = 200, contentType = 'text/plain; charset=utf-8') {
    return new Response(body, {
        status,
        headers: Object.assign({}, BASE_HEADERS, { 'Content-Type': contentType })
    });
}

function assetResponse(body, contentType) {
    return new Response(body, {
        headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
            'X-Content-Type-Options': 'nosniff'
        }
    });
}

function parseCookies(request) {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) return {};
    const cookies = {};
    cookieHeader.split(';').forEach(cookie => {
        const [name, value] = cookie.split('=').map(c => c.trim());
        if (name && value) cookies[name] = value;
    });
    return cookies;
}

async function verifyTurnstile(token, secret, ip) {
    if (!token || !secret) return false;
    const formData = new FormData();
    formData.append('secret', secret);
    formData.append('response', token);
    formData.append('remoteip', ip);
    try {
        const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { body: formData, method: 'POST' });
        const outcome = await result.json();
        return outcome.success;
    } catch (e) { return false; }
}

function bufferToBinaryString(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return binary;
}

// 把「二进制字符串 / base64 / quoted-printable」统一还原成字节数组。
// 拆出来是为了让附件下载能直接拿到原始字节，而不必先解成字符串再编码回去。
function decodeToBytes(str, encoding) {
    if (!str) return new Uint8Array(0);
    const enc = String(encoding || '').toLowerCase();

    if (enc === 'base64') {
        const cleanStr = String(str).replace(/[\r\n\s]/g, '');
        try {
            const binaryString = atob(cleanStr);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
            return bytes;
        } catch (e) {
            return new Uint8Array(0);
        }
    }

    if (enc === 'quoted-printable' || enc === 'quoted') {
        const cleanStr = String(str).replace(/=\r?\n/g, '');
        const buffer = [];
        for (let i = 0; i < cleanStr.length; i++) {
            const c = cleanStr[i];
            if (c === '=') {
                const hex = cleanStr.substr(i + 1, 2);
                if (/^[\da-fA-F]{2}$/.test(hex)) {
                    buffer.push(parseInt(hex, 16));
                    i += 2;
                } else {
                    buffer.push(61);
                }
            } else {
                buffer.push(c.charCodeAt(0) & 0xff);
            }
        }
        return new Uint8Array(buffer);
    }

    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return bytes;
}

function decodeContent(str, encoding, charset = 'utf-8') {
    if (!str) return '';
    let label = (charset || 'utf-8').toLowerCase().trim();
    if (label === 'gb2312' || label === 'gb_2312-80') label = 'gbk';

    let decoder;
    try { decoder = new TextDecoder(label); }
    catch (e) { decoder = new TextDecoder('utf-8'); }

    try {
        const bytes = decodeToBytes(str, encoding);
        let decoded = decoder.decode(bytes);

        // 【核心修复】智能编码嗅探：如果 UTF-8 解出了菱形乱码(FFFD)，强行用 GBK 重新解一遍
        if (label === 'utf-8' && decoded.includes('\uFFFD')) {
            try {
                const gbkDecoder = new TextDecoder('gbk');
                const gbkDecoded = gbkDecoder.decode(bytes);
                // 对比错误率，选错误少的
                const utf8Errors = (decoded.match(/\uFFFD/g) || []).length;
                const gbkErrors = (gbkDecoded.match(/\uFFFD/g) || []).length;
                if (gbkErrors < utf8Errors) {
                    decoded = gbkDecoded;
                }
            } catch (e) {}
        }
        return decoded;
    } catch (e) {
        return str;
    }
}

// 抢救「被文件名清洗毁掉的 RFC2047 编码词」。
//
// 老版本在把主题 / 发件人写进 R2 键名之前，先做了一遍「文件名安全清洗」，
// 而清洗会把 "?" 换成 "_" —— 于是标准编码词
//     =?UTF-8?Q?=F0=9F=90=9D?=
// 被毁成
//     =_UTF-8_Q_=F0=9F=90=9D_=
// 编码标记（=? ? ?=）丢失，列表页再也解不回来，只能原样显示成
//     "= UTF-8 Q =F0=9F=90=9D"
// 这就是「有些邮件主题乱码」在历史数据里的表现。
//
// 好消息是这个破坏是「可逆的结构性替换」：字符集、编码类型、编码内容三段都还在，
// 只是分隔符从 "?" 变成了 "_"。这里按已知结构还原回标准形式，
// 再交给 decodeHeaderValue 解码，让修复前入库的老邮件也能正常显示，不必等重新投递。
//
// 结构：=_<charset>_<B|Q>_<content>_=?
//   charset 不含 "_"（UTF-8 / ISO-8859-1 / GB2312 / windows-1252 …）
//   content 不含 "_"（base64 字母表是 A-Za-z0-9+/=，quoted-printable 是 =XX）
// 这两点保证了 "_" 可以安全地当作分隔符来切分。
function salvageBrokenRfc2047(text) {
    if (!text || text.indexOf('=_') === -1) return text;
    return text.replace(
        /=_([A-Za-z0-9][A-Za-z0-9.*-]*)_([BbQq])_([A-Za-z0-9+/=]+)_=?/g,
        (_, charset, type, content) => '=?' + charset + '?' + type.toUpperCase() + '?' + content + '?='
    );
}

function decodeHeaderValue(text) {
    if (!text) return '';
    if (text.includes("''")) {
        const parts = text.split("''");
        if (parts.length === 2) { try { return decodeURIComponent(parts[1]); } catch (e) {} }
    }
    const rfc2047Regex = /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g;
    if (text.includes('=?')) {
        const cleanText = text.replace(/\?=\s+=\?/g, '?==?');
        text = cleanText.replace(rfc2047Regex, (_, charset, type, content) => {
            const encoding = type.toUpperCase() === 'B' ? 'base64' : 'quoted-printable';
            return decodeContent(content, encoding, charset);
        });
        return text;
    }
    if (text.includes('%')) { try { return decodeURIComponent(text); } catch (e) {} }
    return text.replace(/^["']|["']$/g, '');
}

// 【核心修复】缝合算法：完美识别邮件头部折叠 (Header Folding)
function parseHeaders(rawHeaderBlock) {
    const headers = {};
    let currentKey = null;
    const lines = rawHeaderBlock.split(/\r?\n/);
    
    for (let line of lines) {
        // 如果行首是空格或 Tab，说明它是上一行的延续 (折叠)
        if (/^[ \t]+/.test(line)) {
            if (currentKey) headers[currentKey] += ' ' + line.trim();
        } else {
            const match = line.match(/^([^:]+):\s*(.*)$/);
            if (match) {
                currentKey = match[1].toLowerCase();
                headers[currentKey] = match[2].trim();
            }
        }
    }
    return headers;
}

// 【核心修复】标准的双换行切割，免疫任何虚假空行
function splitHeaderBody(text) {
    // 清除由于 Mbox 协议强加的 From 行
    if (text.startsWith('From ')) {
        text = text.replace(/^From [^\r\n]+\r?\n/, '');
    }
    // 安全清除多余的开头换行，防止第一行就被误判为空行
    let cleanText = text.replace(/^[\r\n]+/, '');
    
    // 严格定位第一个双换行
    const match = cleanText.match(/\r?\n\r?\n/);
    if (match) {
        return {
            headerPart: cleanText.substring(0, match.index),
            bodyPart: cleanText.substring(match.index + match[0].length)
        };
    }
    
    // 如果极端情况下没找到双换行
    if (cleanText.includes(':')) {
        return { headerPart: cleanText, bodyPart: '' };
    }
    return { headerPart: '', bodyPart: cleanText };
}

function parseMimeParts(rawText, boundary) {
    const parts = [];
    if (!boundary) return [{ headers: {}, body: rawText }];
    
    const safeBoundary = boundary.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const rawParts = rawText.split(new RegExp(`--${safeBoundary}`, 'i'));
    
    for (const chunk of rawParts) {
        const trimmed = chunk.trim();
        if (trimmed === '' || trimmed === '--') continue;
        
        const { headerPart, bodyPart } = splitHeaderBody(chunk);
        const headers = parseHeaders(headerPart);
        
        const contentType = headers['content-type'] || '';
        const subBoundaryMatch = contentType.match(/boundary\s*=\s*["']?([^"';\s\r\n]+)/i);
        
        if (subBoundaryMatch) {
            // 递归解析多重嵌套附件
            parts.push(...parseMimeParts(bodyPart, subBoundaryMatch[1]));
        } else {
            parts.push({ headers, body: bodyPart });
        }
    }
    return parts;
}

function processEmail(rawText) {
    const { headerPart: topHeaderRaw, bodyPart: topBodyRaw } = splitHeaderBody(rawText);
    const headers = parseHeaders(topHeaderRaw);
    
    if (headers['subject']) headers['subject'] = decodeHeaderValue(headers['subject']);
    if (headers['from']) headers['from'] = decodeHeaderValue(headers['from']);

    const boundaryMatch = (headers['content-type'] || '').match(/boundary\s*=\s*["']?([^"';\s\r\n]+)/i);
    const boundary = boundaryMatch ? boundaryMatch[1] : null;
    const allParts = boundary ? parseMimeParts(topBodyRaw, boundary) : [{ headers: headers, body: topBodyRaw }];

    let htmlBody = '';
    let textBody = '';
    const attachments = [];

    for (const part of allParts) {
        const rawType = part.headers['content-type'] || 'text/plain';
        const type = rawType.toLowerCase();
        const disposition = (part.headers['content-disposition'] || '').toLowerCase();
        const encoding = (part.headers['content-transfer-encoding'] || '').toLowerCase().trim();
        const charsetMatch = rawType.match(/charset\s*=\s*["']?([\w-]+)/i);
        const charset = charsetMatch ? charsetMatch[1] : 'utf-8';

        const filenameMatch = disposition.match(/filename\*?=(?:utf-8'')?(?:"([^"]+)"|'([^']+)'|([^"';\r\n]+))/i) || rawType.match(/name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^"';\r\n]+))/i);
        const isAttachment = disposition.includes('attachment') || (!!filenameMatch && !disposition.includes('inline'));

        if (isAttachment || filenameMatch) {
            let filename = 'unknown_file';
            if (filenameMatch) { filename = filenameMatch[1] || filenameMatch[2] || filenameMatch[3] || 'unknown_file'; }
            filename = decodeHeaderValue(filename).trim() || 'unknown_file';

            const mime = type.split(';')[0].trim() || 'application/octet-stream';
            const sizeInBytes = encoding === 'base64'
                ? Math.round(part.body.replace(/\s/g, '').length * 0.75)
                : part.body.length;
            let sizeStr = sizeInBytes + ' B';
            if (sizeInBytes >= 1024) sizeStr = Math.round(sizeInBytes / 1024) + ' KB';
            if (sizeInBytes >= 1024 * 1024) sizeStr = (sizeInBytes / (1024 * 1024)).toFixed(1) + ' MB';

            // 附件不再内联成 data: URI —— 一个 10MB 的附件会让页面膨胀到 13MB 并卡死浏览器。
            // 这里只记录原始分片，由 /attachment/ 路由按需解码后流式返回。
            attachments.push({
                filename: filename,
                sizeStr: sizeStr,
                sizeBytes: sizeInBytes,
                mime: mime,
                encoding: encoding,
                body: part.body,
                type: rawType
            });

            // 绝望模式容错：即使标记为附件，如果没有找到正文且内容像网页或文本，强行显示
            if (!htmlBody && !textBody && part.body.length < 500000) {
                const probe = decodeContent(part.body, encoding, charset);
                if (probe.trim().length > 0 && !/\x00/.test(probe)) {
                    if (/(<\s*html|<\s*body|<\s*div|<\s*p\s*>)/i.test(probe)) { htmlBody = probe; }
                    else { textBody = probe; }
                }
            }
        } else {
            const decodedText = decodeContent(part.body, encoding, charset);
            if (type.includes('text/html')) {
                if (!htmlBody) htmlBody = decodedText;
            } else if (type.includes('text/plain')) {
                if (!textBody) textBody = decodedText;
            } else if (!htmlBody && !textBody) {
                if (/(<\s*html|<\s*body|<\s*div|<\s*p\s*>)/i.test(decodedText)) { htmlBody = decodedText; }
                else { textBody = decodedText; }
            }
        }
    }

    // 如果系统崩溃未找到任何正文，强行猜测解码
    if (!htmlBody && !textBody && topBodyRaw.trim().length > 0) {
        const guessEncoding = /^[A-Za-z0-9+/=\s]{50,}$/.test(topBodyRaw.trim()) ? 'base64' : '';
        const rawDecoded = decodeContent(topBodyRaw, guessEncoding, 'utf-8');
        if (/(<\s*html|<\s*body|<\s*div|<\s*p\s*>)/i.test(rawDecoded)) { htmlBody = rawDecoded; }
        else { textBody = rawDecoded; }
    }

    return { headers: headers, html: htmlBody, text: textBody, attachments: attachments, date: headers['date'] };
}

// 从 R2 键名里取出时间戳。键名格式异常时返回 0，避免 NaN 污染排序与「最新邮件」判断。
function keyTimestamp(key) {
    const parts = String(key).replace(TRASH_PREFIX, '').split('_');
    const ts = parseInt(parts[0], 10);
    return Number.isFinite(ts) ? ts : 0;
}

// 收件箱里「是邮件」的键：排除配置文件、内部系统键、回收站键
function isMailKey(key) {
    return key !== CONFIG_FILE && !key.startsWith(SYS_PREFIX) && !key.startsWith(TRASH_PREFIX);
}

// 按字符数截断，且不把代理对（emoji 等）从中间切开 —— 切开会变成孤立代理，
// 落盘后就成了 U+FFFD，反而制造乱码。
function clampText(value, max) {
    const s = String(value === null || value === undefined ? '' : value);
    if (s.length <= max) return s;
    let cut = max;
    const code = s.charCodeAt(cut - 1);
    if (code >= 0xD800 && code <= 0xDBFF) cut -= 1;
    return s.slice(0, cut);
}

// 从 R2 键名还原发件人与主题。
//
// v2（当前）：<时间戳>_<发件人长度>_<发件人><主题>.eml
//   用「长度前缀」而不是分隔符定位，所以发件人 / 主题里出现 "_" 也不会解析错位。
//   发件人与主题在入库时就已经解码成明文，这里直接用，不再二次解码。
//
// v1（历史数据）：<时间戳>_<发件人>_<主题>.eml
//   老版本在写键名前做了一遍文件名清洗，把 "?" 换成了 "_"，
//   所以这里要先 salvageBrokenRfc2047() 把被毁的编码词拼回去，再按 "_" 切分。
//   顺序不能反：一旦先把 "_" 当空格替换掉，编码标记就永远回不来了。
//   抢救过后仍有歧义的地方（主题本身含 "_"、被清洗掉的问号等）只能尽力而为，
//   但都只影响列表页的文字，正文与附件不受影响。
function parseKeyMeta(displayKey) {
    const m = /^(\d+)_(\d+)_/.exec(displayKey);
    if (m) {
        const fromLen = parseInt(m[2], 10);
        const body = displayKey.slice(m[0].length);
        if (fromLen >= 0 && fromLen <= body.length) {
            return {
                from: body.slice(0, fromLen),
                subject: body.slice(fromLen).replace(/\.eml$/i, '')
            };
        }
    }

    let rest = displayKey.replace(/^\d+_/, '').replace(/\.eml$/i, '');
    rest = salvageBrokenRfc2047(rest);
    const split = splitV1Key(rest);
    let subjectRaw = split.subject;
    try { subjectRaw = decodeURIComponent(subjectRaw).replace(/_/g, ' '); } catch (e) {}
    return { from: decodeHeaderValue(split.from), subject: decodeHeaderValue(subjectRaw) };
}

// 在 v1 键名里切出「发件人 / 主题」。
//
// 不能简单按第一个 "_" 切：老清洗把 "<" ">" 也换成了 "_"，
// 带显示名的发件人 `张三 <a@b.com>` 会变成 `=_…?= _a@b.com_`，
// 按第一个 "_" 切就会把地址错当成主题开头。
//
// 这里以第一个 "@" 为锚点定位地址边界，地址之后的第一个 "_" 才是真正的分界；
// 显示名部分按 `Name <addr>` 重建，好让列表页能正常取出显示名。
function splitV1Key(rest) {
    const at = rest.indexOf('@');
    if (at !== -1) {
        let s = at;
        while (s > 0 && /[A-Za-z0-9._%+-]/.test(rest[s - 1])) s--;
        let e = at + 1;
        while (e < rest.length && /[A-Za-z0-9.-]/.test(rest[e])) e++;
        const addr = rest.slice(s, e);
        const name = rest.slice(0, s).replace(/_+$/, '').trim();
        let j = e;
        while (j < rest.length && rest[j] === '_') j++;
        return {
            from: name ? name + ' <' + addr + '>' : addr,
            subject: rest.slice(j)
        };
    }
    const sep = rest.indexOf('_');
    if (sep === -1) return { from: '', subject: rest };
    return { from: rest.slice(0, sep), subject: rest.slice(sep + 1) };
}

// ==========================================
// 正文翻译辅助
// ==========================================

// 把邮件 HTML 正文压成纯文本供翻译用。
// 只做「够用」的清理：去掉 script/style/注释、块级标签转换行、解码常见实体、压缩空白。
// 不追求完美还原排版 —— 翻译只需要可读的句子。
function htmlToText(html) {
    if (!html) return '';
    let s = String(html);
    s = s.replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<li[^>]*>/gi, '\n· ');
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|table)>/gi, '\n');
    s = s.replace(/<[^>]*>/g, '');
    s = s.replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/gi, '&');
    s = s.replace(/&#(\d{1,7});/g, (m, d) => {
        try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; }
    });
    s = s.replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => {
        try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; }
    });
    s = s.replace(/[ \t\u00a0]+/g, ' ');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
}

// 判断正文是什么语言。
//
// m2m100 的 source_lang 默认是 english，不显式给源语言的话，非英文邮件会被当成英文硬翻，
// 结果就是胡言乱语。所以这里做一次轻量识别：
//   - 先按字符集判断（汉字/假名/谚文/西里尔/阿拉伯/天城文）
//   - 拉丁字母再用少量高频虚词区分法/西/德/葡，判不出就当英文（也是模型默认值）
// 判错的代价只是译文质量下降，不会报错；识别不出来时也退化成 english。
function detectSourceLang(text) {
    const sample = String(text || '').slice(0, 4000);
    const count = re => (sample.match(re) || []).length;

    const han = count(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
    const kana = count(/[\u3040-\u30ff]/g);
    const hangul = count(/[\uac00-\ud7af\u1100-\u11ff]/g);
    const cyrillic = count(/[\u0400-\u04ff]/g);
    const arabic = count(/[\u0600-\u06ff]/g);
    const devanagari = count(/[\u0900-\u097f]/g);
    const latin = count(/[A-Za-z]/g);

    const total = han + kana + hangul + cyrillic + arabic + devanagari + latin;
    if (total === 0) return 'english';

    // 谚文：m2m100 不支持韩文，直接报出来，免得硬翻成乱码
    if (hangul > total * 0.3) return 'korean';
    // 日文里也有大量汉字，所以先看假名占比再判中文
    if (kana > 0 && kana * 4 >= han) return 'japanese';
    if (han > total * 0.3) return 'chinese';
    if (cyrillic > total * 0.3) return 'russian';
    if (arabic > total * 0.3) return 'arabic';
    if (devanagari > total * 0.3) return 'hindi';

    const lower = ' ' + sample.toLowerCase().replace(/[^a-z\s]/g, ' ') + ' ';
    const has = w => lower.indexOf(' ' + w + ' ') !== -1;
    const scores = {
        french: ['le', 'la', 'les', 'des', 'une', 'est', 'pour', 'vous', 'que'].filter(has).length,
        spanish: ['el', 'los', 'las', 'una', 'para', 'con', 'que', 'por', 'esta'].filter(has).length,
        german: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'sich', 'auch'].filter(has).length,
        portuguese: ['uma', 'para', 'com', 'que', 'nao', 'por', 'mais', 'voce'].filter(has).length
    };
    // 阈值设为 2：只命中 1 个虚词太容易误判，不如老实用英文
    let best = 'english', bestScore = 1;
    for (const lang of Object.keys(scores)) {
        if (scores[lang] > bestScore) { best = lang; bestScore = scores[lang]; }
    }
    return best;
}

// 按段落 / 句子边界把长正文切成若干段，避免把词从中间切断。
// 超出 maxChunks 的部分会被丢弃，并通过 truncated 告诉前端。
function splitForTranslation(text, size, maxChunks) {
    const s = String(text || '');
    if (s.length <= size) return { chunks: s ? [s] : [], truncated: false };

    const chunks = [];
    let rest = s;
    while (rest.length > 0 && chunks.length < maxChunks) {
        if (rest.length <= size) { chunks.push(rest); rest = ''; break; }
        let cut = rest.lastIndexOf('\n\n', size);
        if (cut < size * 0.5) cut = rest.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = rest.lastIndexOf('. ', size);
        if (cut < size * 0.5) cut = size - 1;
        chunks.push(rest.slice(0, cut + 1));
        rest = rest.slice(cut + 1);
    }
    return { chunks, truncated: rest.trim().length > 0 };
}

// 模型输出结构可能随版本调整，这里做一次宽松提取，
// 免得某天字段改名整个功能直接失效（找不到就返回空串，由上层报错）。
function pickTranslatedText(result) {
    if (result === null || result === undefined) return '';
    if (typeof result === 'string') return result;
    if (typeof result !== 'object') return '';
    const keys = ['translated_text', 'translation', 'text', 'output', 'response', 'result'];
    for (const k of keys) {
        if (typeof result[k] === 'string' && result[k].trim()) return result[k];
    }
    return '';
}

// 把值安全地内联进 <script>：转义 "<" 等字符，
// 防止邮件主题/发件人里出现 </script> 提前闭合脚本块造成 XSS。
function jsonForScript(value) {
    return JSON.stringify(value === undefined ? null : value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

// decodeURIComponent 遇到畸形百分号编码会抛 URIError，包一层避免整个请求 500。
function safeDecode(value) {
    try { return decodeURIComponent(String(value || '')); } catch (e) { return ''; }
}

// 把路径里的键解析成真实的 R2 对象，自动区分收件箱 / 回收站。
async function resolveEmailKey(env, rawKey) {
    if (!rawKey || rawKey === CONFIG_FILE || rawKey.startsWith(SYS_PREFIX)) return null;
    const obj = await env.MAIL_BUCKET.get(rawKey);
    if (obj) return { key: rawKey, obj: obj, isTrash: rawKey.startsWith(TRASH_PREFIX) };
    if (rawKey.startsWith(TRASH_PREFIX)) return null;
    const trashedKey = TRASH_PREFIX + rawKey;
    const trashed = await env.MAIL_BUCKET.get(trashedKey);
    if (trashed) return { key: trashedKey, obj: trashed, isTrash: true };
    return null;
}

function getAvatarColor(name) {
    const colors = ['bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-green-500', 'bg-emerald-500', 'bg-teal-500', 'bg-cyan-500', 'bg-blue-500', 'bg-indigo-500', 'bg-violet-500', 'bg-purple-500', 'bg-fuchsia-500', 'bg-pink-500', 'bg-rose-500'];
    let hash = 0;
    const cleanName = name || '?';
    for (let i = 0; i < cleanName.length; i++) hash = cleanName.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
}

// ==========================================
// 3. UI 渲染与滚动修复
// ==========================================

const Icons = {
    inbox: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>`,
    trash: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`,
    refresh: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>`,
    logout: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>`,
    back: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>`,
    attach: `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>`,
    file: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>`,
    download: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>`,
    menu: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" /></svg>`,
    user: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>`,
    lock: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>`,
    spinner: `<svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`,
    alert: `<svg class="w-10 h-10 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>`,
    read: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 19v-8.93a2 2 0 01.89-1.664l7-4.666a2 2 0 012.22 0l7 4.666A2 2 0 0121 10.07V19M3 19a2 2 0 002 2h14a2 2 0 002-2M3 19l6.75-4.5M21 19l-6.75-4.5M3 10l6.75 4.5M21 10l-6.75 4.5m0 0l-1.14.76a2 2 0 01-2.22 0l-1.14-.76" /></svg>`,
    unread: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>`,
    gear: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>`,
    translate: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" /></svg>`
};

const renderLayout = (content, activePage = 'inbox', latestTimestamp = 0) => `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Cloudflare Mail</title>
    <link rel="manifest" href="/manifest.json">
    <meta name="theme-color" content="#4f46e5">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="apple-touch-icon" href="/logo.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        body { font-family: 'Inter', system-ui, sans-serif; -webkit-tap-highlight-color: transparent; }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .email-body img { max-width: 100%; height: auto; }
        .email-body blockquote { border-left: 3px solid #e5e7eb; padding-left: 0.8rem; color: #6b7280; }
        .custom-checkbox input:checked + div { background-color: #4f46e5; border-color: #4f46e5; }
        .custom-checkbox input:checked + div svg { display: block; }
        .safe-bottom { padding-bottom: env(safe-area-inset-bottom); }
        .mobile-sidebar-backdrop { background-color: rgba(0,0,0,0.5); }
        .modal-enter { opacity: 0; transform: scale(0.95); }
        .modal-enter-active { opacity: 1; transform: scale(1); transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
        .modal-leave { opacity: 1; transform: scale(1); }
        .modal-leave-active { opacity: 0; transform: scale(0.95); transition: all 0.15s ease-in; }
        .unread-dot { width: 8px; height: 8px; background-color: #4f46e5; border-radius: 50%; display: inline-block; margin-right: 6px; flex-shrink: 0; }
        .sidebar-link { transition: all 0.15s ease-in-out; }
        .sidebar-link.active { background-color: #eef2ff; color: #4f46e5; font-weight: 600; }
        .sidebar-link:hover:not(.active) { background-color: #f8f9fa; }
    </style>
    <script>
        if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => {}); }

        const CURRENT_PAGE_LATEST_TS = ${latestTimestamp};
        if (window.location.pathname === '/' && CURRENT_PAGE_LATEST_TS > 0) {
            setInterval(async () => {
                try {
                    const res = await fetch('/api/check');
                    if (res.ok) {
                        const data = await res.json();
                        if (data.latest > CURRENT_PAGE_LATEST_TS) {
                            const toast = document.createElement('div');
                            toast.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 p-3 bg-indigo-600 text-white rounded-xl shadow-lg shadow-indigo-600/50 z-[70] transition-opacity duration-300';
                            toast.textContent = '检测到新邮件，正在刷新...';
                            document.body.appendChild(toast);
                            setTimeout(() => { window.location.reload(); }, 1500);
                        }
                    }
                } catch(e) {}
            }, 15000); 
        }

        window._confirmCallback = null;
        function showModal(title, msg, callback, isDestructive = false) {
            document.getElementById('modal-title').textContent = title;
            document.getElementById('modal-msg').textContent = msg;
            const btn = document.getElementById('modal-confirm-btn');
            if (isDestructive) {
                btn.classList.remove('bg-indigo-600', 'hover:bg-indigo-700', 'shadow-indigo-600/30');
                btn.classList.add('bg-red-600', 'hover:bg-red-700', 'shadow-red-600/30');
            } else {
                btn.classList.remove('bg-red-600', 'hover:bg-red-700', 'shadow-red-600/30');
                btn.classList.add('bg-indigo-600', 'hover:bg-indigo-700', 'shadow-indigo-600/30');
            }
            const backdrop = document.getElementById('modal-backdrop');
            const panel = document.getElementById('modal-panel');
            backdrop.classList.remove('hidden');
            void backdrop.offsetWidth;
            backdrop.classList.remove('opacity-0');
            panel.classList.remove('opacity-0', 'scale-95');
            window._confirmCallback = callback;
        }
        function hideModal() {
            const backdrop = document.getElementById('modal-backdrop');
            const panel = document.getElementById('modal-panel');
            backdrop.classList.add('opacity-0');
            panel.classList.add('opacity-0', 'scale-95');
            setTimeout(() => { backdrop.classList.add('hidden'); }, 200);
            window._confirmCallback = null;
        }
        function onModalConfirm() { if (window._confirmCallback) window._confirmCallback(); hideModal(); }
        function confirmBatch(action) {
            const map = { 'delete': '移入回收站', 'purge': '彻底删除', 'restore': '恢复', 'mark_read': '标记为已读', 'mark_unread': '标记为未读' };
            const isDestructive = action === 'delete' || action === 'purge';
            if (action === 'mark_read' || action === 'mark_unread') { submitBatchForm(action); return; }
            const msg = \`确定要将选中的邮件\${map[action]}吗？此操作\${action === 'purge' ? '不可恢复' : '可撤销'}。\`;
            showModal(map[action], msg, () => { submitBatchForm(action); }, isDestructive);
        }
        function submitBatchForm(action) {
            const form = document.getElementById('batch-form');
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'action';
            input.value = action;
            form.appendChild(input);
            form.submit();
        }
        function confirmSingle(event, msg, isDestructive) {
            event.preventDefault();
            const form = event.target;
            showModal('确认操作', msg, () => { form.submit(); }, isDestructive);
            return false;
        }
        function toggleAll(source) {
            const checkboxes = document.querySelectorAll('input[name="keys"]');
            checkboxes.forEach(cb => { cb.checked = source.checked; updateRowStyle(cb); });
            updateToolbar();
        }
        function updateRowStyle(checkbox) {
            const row = checkbox.closest('.email-row');
            checkbox.checked ? row.classList.add('bg-indigo-50') : row.classList.remove('bg-indigo-50');
            updateToolbar();
        }
        function updateToolbar() {
            const count = document.querySelectorAll('input[name="keys"]:checked').length;
            const actionHeader = document.getElementById('action-header');
            const defaultHeader = document.getElementById('default-header');
            if (actionHeader && defaultHeader) {
                actionHeader.classList.toggle('hidden', count === 0);
                defaultHeader.classList.toggle('hidden', count > 0);
                document.getElementById('selected-count').textContent = count;
            }
        }
        function toggleMenu() {
            const sidebar = document.getElementById('mobile-sidebar');
            const backdrop = document.getElementById('mobile-backdrop');
            const isClosed = sidebar.classList.contains('-translate-x-full');
            if (isClosed) {
                sidebar.classList.remove('-translate-x-full');
                backdrop.classList.remove('hidden');
                document.body.style.overflow = 'hidden';
            } else {
                sidebar.classList.add('-translate-x-full');
                backdrop.classList.add('hidden');
                document.body.style.overflow = '';
            }
        }

        // 邮件正文渲染在沙箱 iframe 里，由它 postMessage 回报正文容器高度，父页面据此调整高度。
        // 校验 e.source === frame.contentWindow，避免页面内其它来源伪造高度。
        //
        // ⚠️ 高度必须「原样采用」，绝不能加固定增量。iframe 高度会决定它内部视口的高度，
        //    而 documentElement.scrollHeight 被视口高度托底 —— 一旦在这里加常数，
        //    就会形成「视口变高 → 测得更高 → iframe 再变高」的正反馈，
        //    表现为打开邮件后正文下方无限空白（实测 4 秒能涨 1700px 以上）。
        //    dataset.frameHeight 做去重，避免同样的高度反复写 style。
        //
        // ⚠️ 还有一类内容用上面的办法治不好：正文里带 vh 单位（例如 <div style="min-height:100vh">）。
        //    vh 天然绑定视口高度，而视口高度正是我们在设的值 —— 这类内容不存在不动点，
        //    高度会以固定步长匀速爬升。真实内容不会「等幅」增长（图片陆续加载的步长是参差的），
        //    所以连续 3 次等幅递增就判定为反馈环并停止跟随。窗口尺寸变化时重置判定。
        let appliedHeight = -1;
        let lastStep = 0;
        let sameStep = 0;
        window.addEventListener('resize', function () { lastStep = 0; sameStep = 0; });
        window.addEventListener('message', function (e) {
            const d = e.data;
            if (!d || typeof d.__cfmailHeight !== 'number') return;
            const frame = document.getElementById('mail-frame');
            if (!frame || e.source !== frame.contentWindow) return;
            const h = Math.min(Math.max(Math.ceil(d.__cfmailHeight), 120), 20000);
            if (h === appliedHeight) return;
            const step = appliedHeight > 0 ? h - appliedHeight : 0;
            if (step > 0 && step <= 64 && step === lastStep) {
                if (++sameStep >= 3) return;
            } else {
                sameStep = 0;
            }
            lastStep = step;
            appliedHeight = h;
            frame.style.height = h + 'px';
        });

        // 邮件行点击改用事件委托：原来把键名拼进 onclick 的单引号字符串里，
        // 而 encodeURIComponent 并不转义单引号，主题里带单引号就能闭合字符串注入脚本。
        //
        // ⚠️ 这里绝不能用「祖先里有 form 就跳过」来判断交互控件：
        //    邮件行本身就位于 <form id="batch-form"> 内部，closest('form') 永远命中，
        //    结果就是整行点击被吞掉、邮件永远打不开。
        //    必须先把 target 归到行上，再判断它是不是行内真正的控件。
        document.addEventListener('click', function (e) {
            const t = e.target;
            if (!t || typeof t.closest !== 'function') return;
            const row = t.closest('.email-row');
            if (!row || !row.dataset.key) return;
            if (t.closest('a, button, input, label, select, textarea, iframe')) return;
            window.location.href = '/email/' + row.dataset.key;
        });

        // 危险操作二次确认：第一次点击只「上膛」，4 秒内再点一次才真正提交。
        // 比原生 confirm() 更贴合页面风格，也不会被浏览器拦截。
        function askClear(btn) {
            if (btn.dataset.armed === '1') return true;
            btn.dataset.armed = '1';
            const original = btn.textContent;
            btn.textContent = '再点一次确认清空';
            btn.classList.add('bg-red-600', 'text-white');
            setTimeout(function () {
                btn.dataset.armed = '';
                btn.textContent = original;
                btn.classList.remove('bg-red-600', 'text-white');
            }, 4000);
            return false;
        }
    </script>
</head>
<body class="bg-gray-50 fixed inset-0 flex overflow-hidden text-gray-800 w-full">
    <div id="modal-backdrop" class="fixed inset-0 z-[60] hidden transition-opacity duration-200 opacity-0">
        <div class="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onclick="hideModal()"></div>
        <div class="flex items-center justify-center min-h-screen p-4">
            <div id="modal-panel" class="relative bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 transition-all duration-200 transform scale-95 opacity-0">
                <div class="flex flex-col items-center text-center">
                    <div class="mb-4 bg-red-50 p-3 rounded-full">${Icons.alert}</div>
                    <h3 id="modal-title" class="text-lg font-bold text-gray-900 mb-2"></h3>
                    <p id="modal-msg" class="text-sm text-gray-500 mb-6 leading-relaxed"></p>
                    <div class="flex space-x-3 w-full">
                        <button onclick="hideModal()" class="flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 font-medium rounded-xl hover:bg-gray-200 transition-colors">取消</button>
                        <button id="modal-confirm-btn" onclick="onModalConfirm()" class="flex-1 px-4 py-2.5 bg-indigo-600 text-white font-medium rounded-xl shadow-lg shadow-indigo-600/30 hover:bg-indigo-700 transition-all active:scale-95">确定</button>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <div id="mobile-backdrop" onclick="toggleMenu()" class="fixed inset-0 mobile-sidebar-backdrop z-40 hidden md:hidden transition-opacity"></div>
    <aside id="mobile-sidebar" class="fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200 transform transition-transform duration-300 ease-in-out -translate-x-full md:relative md:translate-x-0 md:flex flex-col h-full shadow-xl md:shadow-none">
        <div class="p-5 flex items-center justify-between border-b border-gray-100 h-16">
            <div class="flex items-center space-x-3"><div class="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold text-lg">M</div><span class="font-semibold text-xl tracking-tight text-gray-900">CF Mail</span></div>
            <button onclick="toggleMenu()" class="md:hidden text-gray-500"><svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg></button>
        </div>
        <nav class="flex-1 p-4 space-y-1 overflow-y-auto">
            <a href="/" class="sidebar-link ${activePage === 'inbox' ? 'active' : 'text-gray-600'} flex items-center px-3 py-3 text-base font-medium rounded-xl group transition-colors"><span class="mr-3 ${activePage === 'inbox' ? 'text-indigo-600' : 'text-gray-400 group-hover:text-gray-500'}">${Icons.inbox}</span>收件箱</a>
            <a href="/trash" class="sidebar-link ${activePage === 'trash' ? 'active bg-red-50 text-red-700' : 'text-gray-600'} flex items-center px-3 py-3 text-base font-medium rounded-xl group transition-colors"><span class="mr-3 ${activePage === 'trash' ? 'text-red-600' : 'text-gray-400 group-hover:text-red-500'}">${Icons.trash}</span>已删除</a>
            <a href="/settings" class="sidebar-link ${activePage === 'settings' ? 'active' : 'text-gray-600'} flex items-center px-3 py-3 text-base font-medium rounded-xl group transition-colors"><span class="mr-3 ${activePage === 'settings' ? 'text-indigo-600' : 'text-gray-400 group-hover:text-gray-500'}">${Icons.gear}</span>设置</a>
        </nav>
        <div class="p-4 border-t border-gray-100 safe-bottom"><a href="/logout" class="flex items-center px-3 py-3 text-base font-medium text-red-600 rounded-xl hover:bg-red-50 transition-colors"><span class="mr-3">${Icons.logout}</span>退出登录</a></div>
    </aside>
    <main class="flex-1 flex flex-col min-w-0 min-h-0 bg-white md:bg-gray-50 w-full relative z-0">${content}</main>
</body></html>`;

const renderLogin = (error = "", siteKey = "") => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>登录</title><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#ffffff"><link rel="icon" type="image/svg+xml" href="/logo.svg"><script src="https://cdn.tailwindcss.com"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');body{font-family:'Inter',system-ui,sans-serif}</style><script>function handleLogin(btn){btn.disabled=true;btn.innerHTML='${Icons.spinner} 登录中...';btn.classList.add('opacity-75','cursor-not-allowed');setTimeout(()=>{if(btn.disabled){btn.disabled=false;btn.innerHTML='登录';btn.classList.remove('opacity-75','cursor-not-allowed')}},5000);return true}</script></head><body class="h-screen w-full flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 via-white to-blue-50"><div class="w-full max-w-sm bg-white/80 backdrop-blur-xl rounded-2xl shadow-[0_12px_40px_rgb(0,0,0,0.1)] border border-gray-100/70 overflow-hidden"><div class="p-8"><div class="text-center mb-10"><div class="inline-flex items-center justify-center w-14 h-14 bg-indigo-600 rounded-2xl text-white font-bold text-2xl mb-4 shadow-lg shadow-indigo-600/30 transition-all hover:scale-[1.02]">M</div><h1 class="text-2xl font-bold text-gray-900 tracking-tight">欢迎回来</h1><p class="text-sm text-gray-500 mt-2">请登录您的 Cloudflare 邮箱</p></div>${error ? `<div class="mb-6 p-4 bg-red-50/80 border border-red-100 text-red-600 text-sm rounded-xl flex items-center shadow-sm animate-pulse"><span class="mr-2">⚠️</span>${escapeHtml(error)}</div>` : ''}<form method="POST" class="space-y-5" onsubmit="return handleLogin(document.getElementById('loginBtn'))"><div class="space-y-1.5"><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider ml-1">用户名</label><div class="relative group"><div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400 group-focus-within:text-indigo-500 transition-colors">${Icons.user}</div><input type="text" name="username" autocomplete="username" class="block w-full pl-10 pr-4 py-3 bg-gray-50/50 border border-gray-200 text-gray-900 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all duration-200" placeholder="请输入用户名" required></div></div><div class="space-y-1.5"><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider ml-1">密码</label><div class="relative group"><div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400 group-focus-within:text-indigo-500 transition-colors">${Icons.lock}</div><input type="password" name="password" autocomplete="current-password" class="block w-full pl-10 pr-4 py-3 bg-gray-50/50 border border-gray-200 text-gray-900 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all duration-200" placeholder="••••••••" required></div></div>${siteKey ? `<div class="flex justify-center pt-2"><div class="cf-turnstile" data-sitekey="${escapeAttr(siteKey)}" data-theme="light"></div></div>` : ''}<button type="submit" id="loginBtn" class="w-full py-3.5 bg-indigo-600 text-white rounded-xl font-semibold shadow-lg shadow-indigo-600/40 hover:bg-indigo-700 hover:shadow-indigo-600/50 active:scale-[0.98] transition-all duration-200 flex items-center justify-center">登录</button></form></div><div class="bg-gray-50/50 p-4 text-center border-t border-gray-100"><p class="text-xs text-gray-400">Powered by Cloudflare Workers</p></div></div></body></html>`;

const renderSetup = (error = "") => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>系统初始化</title><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#ffffff"><link rel="icon" type="image/svg+xml" href="/logo.svg"><script src="https://cdn.tailwindcss.com"></script><style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');body{font-family:'Inter',system-ui,sans-serif}</style><script>function handleSetup(btn){btn.disabled=true;btn.innerHTML='${Icons.spinner} 创建中...';btn.classList.add('opacity-75','cursor-not-allowed');setTimeout(()=>{if(btn.disabled){btn.disabled=false;btn.innerHTML='完成设置并登录';btn.classList.remove('opacity-75','cursor-not-allowed')}},5000);return true}</script></head><body class="h-screen w-full flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 via-white to-blue-50"><div class="w-full max-w-sm bg-white/80 backdrop-blur-xl rounded-2xl shadow-[0_12px_40px_rgb(0,0,0,0.1)] border border-gray-100/70 overflow-hidden"><div class="p-8"><div class="text-center mb-10"><div class="inline-flex items-center justify-center w-14 h-14 bg-indigo-600 rounded-2xl text-white font-bold text-2xl mb-4 shadow-lg shadow-indigo-600/30 transition-all hover:scale-[1.02]">M</div><h1 class="text-2xl font-bold text-gray-900 tracking-tight">欢迎使用</h1><p class="text-sm text-gray-500 mt-2">首次部署，请设置管理员账号</p></div>${error ? `<div class="mb-6 p-4 bg-red-50/80 border border-red-100 text-red-600 text-sm rounded-xl flex items-center shadow-sm animate-pulse"><span class="mr-2">⚠️</span>${escapeHtml(error)}</div>` : ''}<form method="POST" action="/setup" class="space-y-5" onsubmit="return handleSetup(document.getElementById('setupBtn'))"><div class="space-y-1.5"><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider ml-1">管理员用户名</label><div class="relative group"><div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400 group-focus-within:text-indigo-500 transition-colors">${Icons.user}</div><input type="text" name="username" autocomplete="username" class="block w-full pl-10 pr-4 py-3 bg-gray-50/50 border border-gray-200 text-gray-900 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all duration-200" placeholder="请输入用户名" required></div></div><div class="space-y-1.5"><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider ml-1">管理员密码</label><div class="relative group"><div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400 group-focus-within:text-indigo-500 transition-colors">${Icons.lock}</div><input type="password" name="password" autocomplete="new-password" minlength="8" class="block w-full pl-10 pr-4 py-3 bg-gray-50/50 border border-gray-200 text-gray-900 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all duration-200" placeholder="至少 8 位" required></div><p class="text-xs text-gray-400 ml-1">密码至少 8 位，创建后即可登录</p></div><button type="submit" id="setupBtn" class="w-full py-3.5 bg-indigo-600 text-white rounded-xl font-semibold shadow-lg shadow-indigo-600/40 hover:bg-indigo-700 hover:shadow-indigo-600/50 active:scale-[0.98] transition-all duration-200 flex items-center justify-center">完成设置并登录</button></form></div><div class="bg-gray-50/50 p-4 text-center border-t border-gray-100"><p class="text-xs text-gray-400">Powered by Cloudflare Workers</p></div></div></body></html>`;

// ==========================================
// 4. 业务逻辑与路由
// ==========================================

// ---------- 登录限流（计数存在 _sys/ 前缀下，永远不会出现在邮件列表里） ----------

function clientIp(request) {
    return request.headers.get('CF-Connecting-IP')
        || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
        || 'unknown';
}

function loginFailKey(ip) {
    return SYS_PREFIX + 'login_fail_' + String(ip).replace(/[^a-zA-Z0-9.:_-]/g, '_');
}

async function getLoginLock(env, ip) {
    try {
        const obj = await env.MAIL_BUCKET.get(loginFailKey(ip));
        if (!obj) return null;
        const rec = await obj.json();
        if (rec && rec.until && Date.now() < rec.until) return rec;
        return null;
    } catch (e) {
        return null;
    }
}

async function noteLoginFailure(env, ip) {
    try {
        const key = loginFailKey(ip);
        const now = Date.now();
        let rec = { count: 0, first: now, until: 0 };
        const obj = await env.MAIL_BUCKET.get(key);
        if (obj) { try { rec = await obj.json(); } catch (e) {} }
        if (!rec.first || now - rec.first > LOGIN_FAIL_WINDOW_MS) rec = { count: 0, first: now, until: 0 };
        rec.count = (rec.count || 0) + 1;
        if (rec.count >= MAX_LOGIN_FAILS) {
            rec.until = now + LOGIN_LOCK_MS;
            rec.count = 0;
            rec.first = now;
        }
        await env.MAIL_BUCKET.put(key, JSON.stringify(rec));
    } catch (e) {}
}

async function clearLoginFailures(env, ip) {
    try { await env.MAIL_BUCKET.delete(loginFailKey(ip)); } catch (e) {}
}

// ---------- 应用内设置 ----------
// 目的：部署后完全不用再打开 Cloudflare 控制台配变量。
// 取值优先级是「应用内设置 → 环境变量 → 关闭」，三段式回退保证已经配过环境变量的
// 老部署不会因为这次改动而突然失效。

async function getSettings(env) {
    try {
        const obj = await env.MAIL_BUCKET.get(SETTINGS_FILE);
        if (obj) {
            const data = await obj.json();
            if (data && typeof data === 'object') return data;
        }
    } catch (e) {}
    return {};
}

async function putSettings(env, next) {
    await env.MAIL_BUCKET.put(SETTINGS_FILE, JSON.stringify(next), {
        httpMetadata: { contentType: 'application/json' }
    });
}

function cleanStr(value) {
    return String(value === null || value === undefined ? '' : value).trim();
}

// Turnstile：必须来自同一来源的成对 Key 才启用，半配置一律视为关闭。
// 这样「只填了 Site Key」不会把管理员锁在登录页外。
function resolveTurnstile(settings, env) {
    const site = cleanStr(settings.turnstileSiteKey);
    const secret = cleanStr(settings.turnstileSecretKey);
    if (site && secret) return { enabled: true, siteKey: site, secretKey: secret, source: 'settings' };

    const envSite = cleanStr(env.TURNSTILE_SITE_KEY);
    const envSecret = cleanStr(env.TURNSTILE_SECRET_KEY);
    if (envSite && envSecret) return { enabled: true, siteKey: envSite, secretKey: envSecret, source: 'env' };

    return { enabled: false, siteKey: '', secretKey: '', source: 'none' };
}

function resolveForwardEmail(settings, env) {
    const fromSettings = cleanStr(settings.forwardEmail);
    if (fromSettings) return { value: fromSettings, source: 'settings' };
    const fromEnv = cleanStr(env.FORWARD_EMAIL);
    if (fromEnv) return { value: fromEnv, source: 'env' };
    return { value: '', source: 'none' };
}

// 密钥永不回显：只返回掩码和「是否已配置」。
function maskSecret(value) {
    const v = cleanStr(value);
    if (!v) return '';
    if (v.length <= 12) return '••••••••';
    return v.slice(0, 6) + '••••••••' + v.slice(-4);
}

const SOURCE_TEXT = { settings: '应用内已配置', env: '来自环境变量', none: '未配置' };

function sourceBadge(source) {
    const styles = {
        settings: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        env: 'bg-blue-50 text-blue-700 border-blue-200',
        none: 'bg-gray-100 text-gray-500 border-gray-200'
    };
    const cls = styles[source] || styles.none;
    const text = SOURCE_TEXT[source] || SOURCE_TEXT.none;
    return '<span class="inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium ' + cls + '">' + text + '</span>';
}

function renderSettings(settings, turnstile, forward, opts) {
    const o = opts || {};
    const secretMask = maskSecret(settings.turnstileSecretKey);
    const secretPlaceholder = secretMask
        ? '已配置：' + secretMask + '（留空则保持不变）'
        : '0x4AAAAAAAxxxxxxxxxxxxxxxx';

    let alertHtml = '';
    if (o.error) {
        alertHtml = '<div class="mb-6 p-4 bg-red-50 border border-red-100 text-red-600 text-sm rounded-xl">' + escapeHtml(o.error) + '</div>';
    } else if (o.notice) {
        alertHtml = '<div class="mb-6 p-4 bg-emerald-50 border border-emerald-100 text-emerald-700 text-sm rounded-xl">' + escapeHtml(o.notice) + '</div>';
    }

    const turnstileState = turnstile.enabled
        ? '<span class="text-emerald-700 font-medium">已启用</span>，登录页会显示人机验证'
        : '<span class="text-gray-500 font-medium">未启用</span>，登录页会跳过人机验证';

    return `
    <div class="flex flex-col h-full bg-white md:rounded-xl md:shadow-lg overflow-hidden">
        <div class="flex items-center px-3 py-3 sm:px-4 border-b border-gray-100 bg-white z-10 sticky top-0 shadow-sm">
            <a href="/" class="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-full transition-colors mr-1 active:scale-95">${Icons.back}</a>
            <h1 class="text-lg sm:text-xl font-bold text-gray-800 ml-1">设置</h1>
        </div>
        <div class="flex-1 overflow-y-auto min-h-0 overscroll-y-contain custom-scrollbar">
            <div class="p-4 sm:p-8 max-w-3xl mx-auto safe-bottom space-y-6">
                ${alertHtml}
                <p class="text-sm text-gray-500 leading-relaxed">
                    配置保存在你的 R2 存储桶中，部署后无需再打开 Cloudflare 控制台。
                    这里的配置<b class="text-gray-700">优先于</b> Dashboard 上配置的同名环境变量。
                </p>

                <form method="POST" action="/settings" class="space-y-6">
                    <section class="border border-gray-200 rounded-xl p-5">
                        <div class="flex items-center justify-between mb-1">
                            <h2 class="font-semibold text-gray-900">邮件转发</h2>
                            ${sourceBadge(forward.source)}
                        </div>
                        <p class="text-xs text-gray-500 mb-3">邮件存入 R2 成功后，自动转发一份到这个邮箱。留空表示不转发。</p>
                        <input type="email" name="forward_email" autocomplete="off" value="${escapeAttr(settings.forwardEmail || '')}" placeholder="you@example.com"
                            class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all">
                    </section>

                    <section class="border border-gray-200 rounded-xl p-5">
                        <div class="flex items-center justify-between mb-1">
                            <h2 class="font-semibold text-gray-900">人机验证 · Cloudflare Turnstile</h2>
                            ${sourceBadge(turnstile.source)}
                        </div>
                        <p class="text-xs text-gray-500 mb-4">当前状态：${turnstileState}。<br>两个 Key 必须<b>成对填写</b>；只填一个不会生效，也不会把你自己锁在门外。</p>
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Site Key</label>
                        <input type="text" name="turnstile_site_key" autocomplete="off" value="${escapeAttr(settings.turnstileSiteKey || '')}" placeholder="0x4AAAAAAAxxxxxxxxxxxxxxxx"
                            class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all mb-4">
                        <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Secret Key</label>
                        <input type="password" name="turnstile_secret_key" autocomplete="new-password" value="" placeholder="${escapeAttr(secretPlaceholder)}"
                            class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all">
                        <p class="text-xs text-gray-400 mt-2">Secret Key 只保存在 R2，不会回显。留空表示保持原值不变。</p>
                    </section>

                    <div class="flex items-center gap-3">
                        <button type="submit" class="px-5 py-3 bg-indigo-600 text-white rounded-xl font-semibold shadow-lg shadow-indigo-600/30 hover:bg-indigo-700 active:scale-[0.98] transition-all">保存设置</button>
                        <a href="/settings" class="px-5 py-3 text-gray-600 font-medium rounded-xl hover:bg-gray-100 transition-colors">放弃修改</a>
                    </div>
                </form>

                <section class="border border-red-100 bg-red-50/40 rounded-xl p-5">
                    <h2 class="font-semibold text-gray-900 mb-1">危险操作</h2>
                    <p class="text-xs text-gray-500 mb-3">清空应用内保存的 Turnstile 密钥。若 Dashboard 上配置了同名环境变量，清空后会自动回退到环境变量。</p>
                    <form method="POST" action="/settings/clear-turnstile">
                        <button type="submit" onclick="return askClear(this)" class="px-4 py-2.5 bg-white border border-red-200 text-red-600 rounded-xl text-sm font-medium hover:bg-red-50 transition-colors active:scale-[0.98]">清空 Turnstile 密钥</button>
                    </form>
                </section>

                <p class="text-xs text-gray-400 leading-relaxed">
                    提示：Turnstile 的 Site Key 是服务端渲染进登录页的，保存后<b>下次打开登录页</b>生效。
                </p>
            </div>
        </div>
    </div>`;
}

// ---------- 邮件正文沙箱文档 ----------

// 危险类型一律降级为 octet-stream：否则 text/html、image/svg+xml 之类的附件
// 会被浏览器当作页面渲染（存储型 XSS）。
const INLINE_UNSAFE_MIME = ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml', 'text/xml', 'application/javascript', 'text/javascript', 'application/ecmascript'];

function safeDownloadMime(mime) {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (!m || INLINE_UNSAFE_MIME.indexOf(m) !== -1) return 'application/octet-stream';
    return m;
}

// 纵深防御：正文已在不透明源 iframe 里，这里再剥掉脚本与内联事件处理器。
function stripActiveContent(html) {
    return String(html || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<script\b[^>]*\/?>/gi, '')
        .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
        .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
        .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
        .replace(/(href|src)\s*=\s*(["'])\s*javascript:/gi, '$1=$2blocked:');
}

// ⚠️ 高度上报的取值对象必须是「内容容器」而不是 documentElement，理由见 FRAME_HEIGHT_SCRIPT。
//    配套约束：html / body 必须保持 height:auto，否则内容容器会被视口高度拉伸。
const FRAME_CSS = 'html,body{height:auto !important;min-height:0 !important;max-height:none !important;margin:0 !important;padding:0 !important}'
    + 'html{color-scheme:light}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.7;color:#1f2937;word-break:break-word;overflow-wrap:anywhere}'
    + '#mail-root{padding:0 2px 20px}'
    + 'img{max-width:100%;height:auto}table{max-width:100%}'
    + 'blockquote{margin:0;padding-left:.8rem;border-left:3px solid #e5e7eb;color:#6b7280}'
    + 'a{color:#4f46e5}'
    + 'pre.plain{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit}';

// 唯一的内联脚本：向父页面回报正文容器的真实高度，父页面据此调整 iframe 高度。
//
// ⚠️ 这里踩过一个很隐蔽的坑：原来测的是 document.documentElement.scrollHeight。
//    而 documentElement 的 scrollHeight 会被视口高度「托底」—— 内容再短也返回不小于
//    iframe 视口的高度。父页面当时又给测得值加了固定增量（+8px）再设为 iframe 高度，
//    于是形成正反馈：视口变高 → scrollHeight 跟着变高 → iframe 更高 → …… 一路顶到上限。
//    用户看到的就是「打开邮件后下方无限空白」。
//    两道保险：① 只测 #mail-root（内容驱动，与视口无关）；② 父页面原样采用、不加常数。
//    另外用 last 去重，避免同一高度反复 postMessage。
const FRAME_HEIGHT_SCRIPT = '(function(){'
    + 'var root=document.getElementById("mail-root")||document.body,last=-1;'
    + 'function s(){var r=root.getBoundingClientRect?root.getBoundingClientRect().height:0;'
    + 'var h=Math.ceil(Math.max(root.scrollHeight||0,r));'
    + 'if(h===last)return;last=h;'
    + 'try{parent.postMessage({__cfmailHeight:h},"*")}catch(e){}}'
    + 'window.addEventListener("load",s);window.addEventListener("resize",s);'
    + 'document.addEventListener("DOMContentLoaded",s);'
    + 'if(window.ResizeObserver){try{new ResizeObserver(s).observe(root)}catch(e){}}'
    + 'setTimeout(s,300);setTimeout(s,1500)})();';

function buildFrameDocument(email) {
    let inner;
    if (email.html) {
        inner = stripActiveContent(email.html);
    } else if (email.text && email.text.trim()) {
        inner = '<pre class="plain">' + escapeHtml(email.text) + '</pre>';
    } else {
        inner = '<p style="color:#6b7280">（无正文内容，请查看附件）</p>';
    }
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<meta name="referrer" content="no-referrer">'
        + '<style>' + FRAME_CSS + '</style></head><body>'
        + '<div id="mail-root">' + inner + '</div>'
        + '<script>' + FRAME_HEIGHT_SCRIPT + '<\/script>'
        + '</body></html>';
}

// ---------- 邮件详情渲染 ----------
// 收件箱与回收站两条分支共用这一份，避免改一处漏一处。

function renderEmailDetail(email, key, isTrash, uploaded) {
    const fromRaw = String(email.headers['from'] || '');
    const senderName = (fromRaw.split('<')[0] || '').trim().replace(/"/g, '') || '未知发件人';
    const senderEmail = (fromRaw.match(/<([^>]+)>/) || [])[1] || fromRaw.replace(/[<>]/g, '').trim();
    const initial = escapeHtml((senderName[0] || '?').toUpperCase());
    const avatarColor = getAvatarColor(senderName);
    const subject = email.headers['subject'] || '(无主题)';
    const uploadedAt = new Date(uploaded);
    const dateStr = Number.isNaN(uploadedAt.getTime())
        ? ''
        : uploadedAt.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const encodedKey = encodeURIComponent(key);

    let attachmentsHtml = '';
    if (email.attachments.length > 0) {
        attachmentsHtml = `
        <div class="mb-6 bg-gray-50 border border-gray-200 rounded-xl p-4">
            <div class="flex items-center text-sm font-semibold text-gray-700 mb-3">${Icons.attach}<span class="ml-2">附件 (${email.attachments.length})</span></div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                ${email.attachments.map((att, index) => `
                <div class="flex items-center justify-between bg-white p-3 rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
                    <div class="flex items-center min-w-0 flex-1 mr-2">
                        <div class="bg-indigo-100 text-indigo-600 rounded-md p-1.5 mr-3 flex-shrink-0">${Icons.file}</div>
                        <div class="min-w-0">
                            <p class="text-sm font-medium text-gray-900 truncate" title="${escapeAttr(att.filename)}">${escapeHtml(att.filename)}</p>
                            <p class="text-xs text-gray-500">${escapeHtml(att.sizeStr)}</p>
                        </div>
                    </div>
                    <a href="/attachment/${encodedKey}/${index}" download="${escapeAttr(att.filename)}" class="text-indigo-600 hover:text-indigo-800 p-2 hover:bg-indigo-50 rounded-full transition active:scale-95" title="下载附件">${Icons.download}</a>
                </div>`).join('')}
            </div>
        </div>`;
    }

    // 翻译按钮。译文由服务端调 Workers AI 生成，原文已是中文 / 语种不受支持时会在状态条上明确说明。
    const translateBtn = `
            <button id="translate-btn" onclick="translateMail()" class="flex items-center px-3 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg text-sm font-medium transition whitespace-nowrap active:scale-[0.98]" title="把正文翻译成中文">${Icons.translate} <span class="ml-1">翻译</span></button>`;

    const toolbar = isTrash ? `
        <div class="flex items-center space-x-1 sm:space-x-2">
            ${translateBtn}
            <form method="POST" action="/restore" onsubmit="return confirmSingle(event, '确定要恢复这封邮件吗？')">
                <input type="hidden" name="key" value="${escapeAttr(key)}"><button class="flex items-center px-3 py-2 bg-green-50 text-green-700 hover:bg-green-100 rounded-lg text-sm font-medium transition whitespace-nowrap active:scale-[0.98]">${Icons.refresh} <span class="ml-1">恢复</span></button>
            </form>
            <form method="POST" action="/purge" onsubmit="return confirmSingle(event, '彻底删除后将无法恢复，确定吗？', true)">
                <input type="hidden" name="key" value="${escapeAttr(key)}"><button class="flex items-center px-3 py-2 bg-red-50 text-red-700 hover:bg-red-100 rounded-lg text-sm font-medium transition whitespace-nowrap active:scale-[0.98]">${Icons.trash} <span class="ml-1">删除</span></button>
            </form>
        </div>` : `
        <div class="flex items-center space-x-1 sm:space-x-2">
            ${translateBtn}
            <form method="POST" action="/delete" onsubmit="return confirmSingle(event, '确定要将这封邮件移入回收站吗？')"><input type="hidden" name="key" value="${escapeAttr(key)}"><button class="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors active:scale-95" title="移入回收站">${Icons.trash}</button></form>
        </div>`;

    return `
    <div class="flex flex-col h-full bg-white md:rounded-xl md:shadow-lg overflow-hidden">
        <div class="flex items-center justify-between px-3 py-3 sm:px-4 border-b border-gray-100 bg-white z-10 sticky top-0 shadow-sm">
            <div class="flex items-center"><a href="${isTrash ? '/trash' : '/'}" class="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-full transition-colors mr-1 active:scale-95">${Icons.back}</a></div>
            ${toolbar}
        </div>
        <div class="flex-1 overflow-y-auto min-h-0 overscroll-y-contain custom-scrollbar">
            <div class="p-4 sm:p-8 max-w-4xl mx-auto safe-bottom">
                <h1 class="text-xl sm:text-3xl font-bold text-gray-900 mb-5 leading-snug select-text break-words">${escapeHtml(subject)}</h1>
                <div class="flex items-start justify-between pb-6 border-b border-gray-100 mb-6">
                    <div class="flex items-center overflow-hidden">
                        <div class="w-10 h-10 sm:w-12 sm:h-12 ${avatarColor} rounded-full flex items-center justify-center text-white font-bold text-lg shadow-md flex-shrink-0">${initial}</div>
                        <div class="ml-3 sm:ml-4 min-w-0">
                            <div class="font-semibold text-gray-900 text-sm sm:text-base select-text truncate">${escapeHtml(senderName)}</div>
                            <div class="text-xs sm:text-sm text-gray-500 select-text truncate">&lt;${escapeHtml(senderEmail)}&gt;</div>
                        </div>
                    </div>
                    <div class="text-xs sm:text-sm text-gray-400 whitespace-nowrap ml-2 mt-1">${escapeHtml(dateStr)}</div>
                </div>
                ${attachmentsHtml}
                <div id="translate-status" class="hidden"></div>
                <div id="mail-original">
                    <iframe id="mail-frame" src="/frame/${encodedKey}" title="邮件正文" class="w-full border-0 bg-white block rounded-lg" style="height:320px" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" loading="lazy"></iframe>
                    <p class="mt-3 text-xs text-gray-400">正文在沙箱中隔离渲染，邮件自带脚本与内联事件已被剥离。</p>
                </div>
                <div id="mail-translated" class="hidden">
                    <div id="translate-body" class="text-[15px] leading-relaxed text-gray-800 whitespace-pre-wrap break-words select-text bg-indigo-50/40 border border-indigo-100 rounded-xl p-4 sm:p-5"></div>
                    <p class="mt-3 text-xs text-gray-400">译文由 Workers AI 生成，仅供快速浏览；排版、链接与图片请以原文为准。</p>
                </div>
            </div>
        </div>
    </div>
    <script>
    (function () {
        var KEY = ${jsonForScript(key)};
        var translated = null;
        var view = 'original';
        function el(id) { return document.getElementById(id); }

        function setStatus(text, kind) {
            var box = el('translate-status');
            if (!box) return;
            if (!text) { box.className = 'hidden'; box.textContent = ''; return; }
            box.className = 'mb-4 px-4 py-3 rounded-xl text-sm border ' + (kind === 'error'
                ? 'bg-red-50 border-red-100 text-red-600'
                : 'bg-indigo-50 border-indigo-100 text-indigo-700');
            box.textContent = text;
        }

        function setView(next) {
            var original = el('mail-original');
            var panel = el('mail-translated');
            var btn = el('translate-btn');
            if (!original || !panel) return;
            view = next;
            var label = btn ? btn.querySelector('span') : null;
            if (next === 'translated' && translated) {
                original.classList.add('hidden');
                panel.classList.remove('hidden');
                if (label) label.textContent = '显示原文';
            } else {
                panel.classList.add('hidden');
                original.classList.remove('hidden');
                if (label) label.textContent = translated ? '显示译文' : '翻译';
            }
        }

        window.translateMail = function () {
            var btn = el('translate-btn');
            if (translated) { setView(view === 'translated' ? 'original' : 'translated'); return; }
            if (!btn || btn.disabled) return;

            var label = btn.querySelector('span');
            btn.disabled = true;
            btn.classList.add('opacity-60', 'cursor-not-allowed');
            if (label) label.textContent = '翻译中…';
            setStatus('正在翻译，长邮件可能需要十几秒…', 'info');

            fetch('/api/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: KEY })
            }).then(function (res) {
                return res.json().catch(function () { return null; }).then(function (data) {
                    return { status: res.status, data: data };
                });
            }).then(function (r) {
                var data = r.data || {};
                if (!data.ok) {
                    setStatus(data.error || ('翻译失败（HTTP ' + r.status + '），请稍后重试'), 'error');
                    if (label) label.textContent = '翻译';
                    return;
                }
                translated = data.translated;
                var body = el('translate-body');
                if (body) body.textContent = translated;
                var note = '源语言：' + data.sourceLang;
                if (data.truncated) note += '　·　邮件较长，仅翻译了前 ' + data.chunks + ' 段';
                setStatus(note, 'info');
                setView('translated');
            }).catch(function () {
                setStatus('网络错误，请稍后重试', 'error');
                if (label) label.textContent = '翻译';
            }).then(function () {
                btn.disabled = false;
                btn.classList.remove('opacity-60', 'cursor-not-allowed');
            });
        };
    })();
    </script>`;
}

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const cookies = parseCookies(request);

    if (url.pathname === '/manifest.json') return assetResponse(renderManifest(), 'application/json; charset=utf-8');
    if (url.pathname === '/logo.svg') return assetResponse(renderAppIcon(), 'image/svg+xml; charset=utf-8');
    if (url.pathname === '/sw.js') return assetResponse(renderServiceWorker(), 'application/javascript; charset=utf-8');
    if (url.pathname === '/robots.txt') return textResponse('User-agent: *\nDisallow: /\n');

    let config = null;
    try {
        const configObj = await env.MAIL_BUCKET.get(CONFIG_FILE);
        if (configObj) config = await configObj.json();
    } catch (e) {}

    if (!config) {
        if (url.pathname === '/setup' && method === 'POST') {
            const fd = await request.formData();
            const username = String(fd.get('username') || '').trim();
            const password = String(fd.get('password') || '');
            if (!username) return htmlResponse(renderSetup('用户名不能为空'), 400);
            if (password.length < 8) return htmlResponse(renderSetup('密码至少需要 8 位'), 400);

            const salt = randomHex(16);
            await env.MAIL_BUCKET.put(CONFIG_FILE, JSON.stringify({
                username: username,
                salt: salt,
                password: await hashPassword(password, salt),
                sessionToken: randomHex(32),
                sessionExpires: Date.now() + SESSION_TTL_MS,
                createdAt: Date.now()
            }), { httpMetadata: { contentType: 'application/json' } });
            return Response.redirect(url.origin + '/login', 302);
        }
        return htmlResponse(renderSetup(''));
    }

    if (url.pathname === '/login') {
        // 三段式回退：应用内设置 → 环境变量 → 关闭
        const settings = await getSettings(env);
        const turnstile = resolveTurnstile(settings, env);
        const siteKey = turnstile.enabled ? turnstile.siteKey : '';
        const ip = clientIp(request);

        if (method === 'POST') {
            // 限流优先于一切校验：锁定期间即使口令正确也拒绝，否则限流形同虚设。
            const lock = await getLoginLock(env, ip);
            if (lock) {
                const minutes = Math.max(1, Math.ceil((lock.until - Date.now()) / 60000));
                return htmlResponse(renderLogin('尝试次数过多，请在 ' + minutes + ' 分钟后重试', siteKey), 429);
            }

            const fd = await request.formData();
            if (turnstile.enabled) {
                const token = fd.get('cf-turnstile-response');
                const passed = await verifyTurnstile(token, turnstile.secretKey, ip);
                if (!passed) return htmlResponse(renderLogin('验证码校验失败，请重试', siteKey));
            }

            const usernameOk = safeEqual(String(fd.get('username') || ''), String(config.username || ''));
            const passwordOk = await verifyPassword(config, String(fd.get('password') || ''));

            if (usernameOk && passwordOk) {
                await clearLoginFailures(env, ip);
                config.sessionExpires = Date.now() + SESSION_TTL_MS;
                await env.MAIL_BUCKET.put(CONFIG_FILE, JSON.stringify(config), { httpMetadata: { contentType: 'application/json' } });
                return new Response(null, {
                    status: 302,
                    headers: Object.assign({}, BASE_HEADERS, {
                        'Set-Cookie': SESSION_NAME + '=' + config.sessionToken + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
                        'Location': '/'
                    })
                });
            }

            await noteLoginFailure(env, ip);
            return htmlResponse(renderLogin('用户名或密码错误', siteKey));
        }

        return htmlResponse(renderLogin('', siteKey));
    }

    // 会话校验：token 必须匹配，且（如果配置了）未过期
    const sessionToken = String(cookies[SESSION_NAME] || '');
    const sessionValid = !!config.sessionToken
        && safeEqual(sessionToken, String(config.sessionToken))
        && (!config.sessionExpires || Date.now() < config.sessionExpires);
    if (!sessionValid) return Response.redirect(url.origin + '/login', 302);

    if (url.pathname === '/logout') {
        return new Response(null, {
            status: 302,
            headers: Object.assign({}, BASE_HEADERS, {
                'Set-Cookie': SESSION_NAME + '=; Path=/; Max-Age=0',
                'Location': '/login'
            })
        });
    }

    if (url.pathname === '/api/check') {
        const list = await env.MAIL_BUCKET.list({ limit: 10000 });
        let latest = 0;
        for (const item of list.objects) {
            if (!isMailKey(item.key)) continue;
            const ts = keyTimestamp(item.key);
            if (ts > latest) latest = ts;
        }
        return jsonResponse({ latest: latest });
    }

    // ---------- 正文翻译 ----------
    // 走 Workers AI（m2m100）。注意：邮件正文会被送进模型推理，
    // 但对个人自建的邮箱来说，推理跑在同一个 Cloudflare 账号的基础设施内。
    if (url.pathname === '/api/translate' && method === 'POST') {
        if (!env.AI) {
            return jsonResponse({
                ok: false,
                error: '未绑定 Workers AI。请确认 wrangler.jsonc 里有 "ai": { "binding": "AI" } 并重新部署。'
            }, 503);
        }

        let reqKey = '';
        try {
            const payload = await request.json();
            reqKey = String((payload && payload.key) || '');
        } catch (e) {
            return jsonResponse({ ok: false, error: '请求格式不正确' }, 400);
        }
        if (!reqKey) return jsonResponse({ ok: false, error: '缺少邮件标识' }, 400);

        const target = await resolveEmailKey(env, reqKey);
        if (!target) return jsonResponse({ ok: false, error: '邮件不存在或已被删除' }, 404);

        const email = processEmail(bufferToBinaryString(await target.obj.arrayBuffer()));

        // 优先用 text/plain 部分；只有 HTML 的邮件再退回「HTML 转纯文本」
        let text = String(email.text || '').trim();
        if (!text && email.html) text = htmlToText(email.html);
        if (!text) return jsonResponse({ ok: false, error: '这封邮件没有可翻译的正文' }, 422);

        const source = detectSourceLang(text);
        if (TRANSLATE_LANGS.indexOf(source) === -1) {
            return jsonResponse({ ok: false, error: '翻译模型暂不支持该语言，仅支持英/中/法/西/阿拉伯/俄/德/日/葡/印地语' }, 422);
        }
        if (source === TRANSLATE_TARGET) {
            return jsonResponse({ ok: false, error: '这封邮件本来就是中文，无需翻译' }, 422);
        }

        const split = splitForTranslation(text, TRANSLATE_CHUNK_SIZE, TRANSLATE_MAX_CHUNKS);
        if (split.chunks.length === 0) {
            return jsonResponse({ ok: false, error: '这封邮件没有可翻译的正文' }, 422);
        }

        try {
            // 分段并行翻译：串行翻长邮件会让浏览器等到超时
            const parts = await Promise.all(split.chunks.map(chunk =>
                env.AI.run(TRANSLATE_MODEL, { text: chunk, source_lang: source, target_lang: TRANSLATE_TARGET })
            ));
            const translated = parts.map(pickTranslatedText).join('\n\n').trim();
            if (!translated) {
                return jsonResponse({ ok: false, error: '翻译服务没有返回内容，请稍后重试' }, 502);
            }
            return jsonResponse({
                ok: true,
                translated: translated,
                sourceLang: source,
                chunks: split.chunks.length,
                truncated: split.truncated
            });
        } catch (e) {
            console.error('Translate failed:', e && e.stack ? e.stack : e);
            return jsonResponse({ ok: false, error: '翻译失败，请稍后重试' }, 502);
        }
    }

    // ---------- 应用内设置页 ----------
    if (url.pathname === '/settings') {
        const settings = await getSettings(env);

        if (method === 'POST') {
            const fd = await request.formData();
            const next = Object.assign({}, settings);

            // 非密钥字段：页面会回显当前值，所以「空串」就是「清空」
            next.forwardEmail = cleanStr(fd.get('forward_email'));
            next.turnstileSiteKey = cleanStr(fd.get('turnstile_site_key'));

            // Secret Key：页面永远不回显明文，所以「空串」只能理解为「不修改」。
            // 想清空请走下方的「危险操作」按钮。
            const submittedSecret = cleanStr(fd.get('turnstile_secret_key'));
            if (submittedSecret) next.turnstileSecretKey = submittedSecret;

            // 成对校验：只填一个 Key 属于半配置，会让用户以为配好了、实际验证永远过不去
            const hasSite = !!cleanStr(next.turnstileSiteKey);
            const hasSecret = !!cleanStr(next.turnstileSecretKey);
            if (hasSite !== hasSecret) {
                return htmlResponse(renderLayout(
                    renderSettings(
                        { forwardEmail: next.forwardEmail, turnstileSiteKey: next.turnstileSiteKey, turnstileSecretKey: settings.turnstileSecretKey },
                        resolveTurnstile(settings, env),
                        resolveForwardEmail(settings, env),
                        { error: 'Turnstile 的 Site Key 与 Secret Key 必须成对填写：要么都填，要么都不填。' }
                    ),
                    'settings'
                ), 400);
            }

            await putSettings(env, next);
            return Response.redirect(url.origin + '/settings?saved=1', 302);
        }

        const notice = url.searchParams.get('saved')
            ? '设置已保存。'
            : (url.searchParams.get('cleared') ? 'Turnstile 密钥已清空。' : '');

        return htmlResponse(renderLayout(
            renderSettings(settings, resolveTurnstile(settings, env), resolveForwardEmail(settings, env), { notice: notice }),
            'settings'
        ));
    }

    if (url.pathname === '/settings/clear-turnstile' && method === 'POST') {
        const settings = await getSettings(env);
        const next = Object.assign({}, settings);
        delete next.turnstileSiteKey;
        delete next.turnstileSecretKey;
        await putSettings(env, next);
        return Response.redirect(url.origin + '/settings?cleared=1', 302);
    }

    if (url.pathname === '/delete' && method === 'POST') {
        const fd = await request.formData();
        const key = fd.get('key');
        if (key && !key.startsWith(TRASH_PREFIX) && key !== CONFIG_FILE) {
            const obj = await env.MAIL_BUCKET.get(key);
            if (obj) { await env.MAIL_BUCKET.put(TRASH_PREFIX + key, obj.body); await env.MAIL_BUCKET.delete(key); }
        }
        return Response.redirect(url.origin + '/', 302);
    }
    if (url.pathname === '/purge' && method === 'POST') {
        const fd = await request.formData();
        const key = fd.get('key');
        if (key && key.startsWith(TRASH_PREFIX)) await env.MAIL_BUCKET.delete(key);
        return Response.redirect(url.origin + '/trash', 302);
    }
    if (url.pathname === '/restore' && method === 'POST') {
        const fd = await request.formData();
        const key = fd.get('key');
        if (key && key.startsWith(TRASH_PREFIX)) {
            const obj = await env.MAIL_BUCKET.get(key);
            if (obj) { await env.MAIL_BUCKET.put(key.replace(TRASH_PREFIX, ''), obj.body); await env.MAIL_BUCKET.delete(key); }
        }
        return Response.redirect(url.origin + '/trash', 302);
    }

    if (url.pathname === '/batch-action' && method === 'POST') {
        const fd = await request.formData();
        const keys = fd.getAll('keys');
        const action = fd.get('action');
        for (const key of keys) {
            if (key === CONFIG_FILE) continue;
            if (action === 'delete') {
                if (!key.startsWith(TRASH_PREFIX)) {
                    const obj = await env.MAIL_BUCKET.get(key);
                    if (obj) { await env.MAIL_BUCKET.put(TRASH_PREFIX + key, obj.body); await env.MAIL_BUCKET.delete(key); }
                }
            } else if (action === 'purge') {
                if (key.startsWith(TRASH_PREFIX)) await env.MAIL_BUCKET.delete(key);
            } else if (action === 'restore') {
                if (key.startsWith(TRASH_PREFIX)) {
                    const obj = await env.MAIL_BUCKET.get(key);
                    if (obj) { await env.MAIL_BUCKET.put(key.replace(TRASH_PREFIX, ''), obj.body); await env.MAIL_BUCKET.delete(key); }
                }
            } else if (action === 'mark_read' || action === 'mark_unread') {
                if (!key.startsWith(TRASH_PREFIX)) {
                    const obj = await env.MAIL_BUCKET.get(key);
                    if (obj) {
                        await env.MAIL_BUCKET.put(key, obj.body, {
                            customMetadata: Object.assign({}, obj.customMetadata, {
                                isRead: action === 'mark_read' ? 'true' : 'false'
                            })
                        });
                    }
                }
            }
        }

        // 批量操作完成后回到用户刚才所在的页面（收件箱 / 回收站）。
        //
        // 这里不能用 Referer：
        //   1) 本站所有响应都带 Referrer-Policy: no-referrer，浏览器压根不会发 Referer；
        //   2) Response.redirect() 只接受**绝对 URL**，传相对路径会直接抛
        //      TypeError: Failed to parse URL from / —— 那就是「服务暂时不可用」的根因。
        // 改为由表单自带 next 字段，并做白名单校验，顺带杜绝开放重定向。
        const next = String(fd.get('next') || '').indexOf('/trash') === 0 ? '/trash' : '/';
        return Response.redirect(url.origin + next, 302);
    }

    if (url.pathname.startsWith('/frame/')) {
        const resolved = await resolveEmailKey(env, safeDecode(url.pathname.slice('/frame/'.length)));
        if (!resolved) return textResponse('Not Found', 404);
        const email = processEmail(bufferToBinaryString(await resolved.obj.arrayBuffer()));
        return new Response(buildFrameDocument(email), {
            headers: Object.assign({}, BASE_HEADERS, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'private, max-age=300',
                'X-Frame-Options': 'SAMEORIGIN',
                // 把正文强制关进不透明源沙箱：拿不到本站 Cookie / DOM / localStorage。
                // img-src 放开是为了让邮件里的外链图片能显示；script-src 只放行我们注入的高度回报脚本。
                'Content-Security-Policy': "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; img-src * data: cid:; style-src 'unsafe-inline' *; font-src * data:; script-src 'unsafe-inline'"
            })
        });
    }

    if (url.pathname.startsWith('/attachment/')) {
        const rest = url.pathname.slice('/attachment/'.length);
        const slash = rest.lastIndexOf('/');
        if (slash < 0) return textResponse('Not Found', 404);

        const resolved = await resolveEmailKey(env, safeDecode(rest.slice(0, slash)));
        const index = parseInt(rest.slice(slash + 1), 10);
        if (!resolved || !Number.isInteger(index) || index < 0) return textResponse('Not Found', 404);

        const email = processEmail(bufferToBinaryString(await resolved.obj.arrayBuffer()));
        const att = email.attachments[index];
        if (!att) return textResponse('Not Found', 404);

        const safeName = String(att.filename || 'download').replace(/[\r\n"]/g, '_');
        const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_');
        const encodedName = encodeURIComponent(safeName).replace(/'/g, '%27');
        return new Response(decodeToBytes(att.body, att.encoding), {
            headers: Object.assign({}, BASE_HEADERS, {
                // 危险 MIME 会被降级为 octet-stream，避免附件被当成页面渲染
                'Content-Type': safeDownloadMime(att.mime),
                'Content-Disposition': 'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodedName,
                'Cache-Control': 'private, max-age=300'
            })
        });
    }

    if (url.pathname.startsWith('/email/')) {
        const resolved = await resolveEmailKey(env, safeDecode(url.pathname.slice('/email/'.length)));
        if (!resolved) return Response.redirect(url.origin + '/', 302);

        // 只读一次 body：R2ObjectBody 的流被消费后不能重复读取
        const buffer = await resolved.obj.arrayBuffer();
        if (!resolved.isTrash && resolved.obj.customMetadata?.isRead !== 'true') {
            ctx.waitUntil(env.MAIL_BUCKET.put(resolved.key, buffer, { customMetadata: { isRead: 'true' } }));
        }

        const email = processEmail(bufferToBinaryString(buffer));
        return htmlResponse(renderLayout(
            renderEmailDetail(email, resolved.key, resolved.isTrash, resolved.obj.uploaded),
            resolved.isTrash ? 'trash' : 'inbox'
        ));
    }

    const isTrashPage = url.pathname === '/trash';
    if (url.pathname === '/' || isTrashPage) {
        const options = isTrashPage ? { prefix: TRASH_PREFIX, limit: 50, include: ['customMetadata'] } : { limit: 100, include: ['customMetadata'] };
        const list = await env.MAIL_BUCKET.list(options);
        // 排除配置文件与内部系统键（登录限流计数等），回收站页用 prefix 天然隔离
        const emails = list.objects.filter(o => isTrashPage ? true : isMailKey(o.key));

        emails.sort((a, b) => keyTimestamp(b.key) - keyTimestamp(a.key));

        const listHtml = emails.map(e => {
            const fullKey = e.key;
            const displayKey = isTrashPage ? e.key.replace(TRASH_PREFIX, '') : e.key;

            const meta = parseKeyMeta(displayKey);
            const senderName = (meta.from.includes('<')
                ? meta.from.split('<')[0].replace(/"/g, '').trim()
                : meta.from.trim()) || '未知发件人';
            const subject = meta.subject.trim() || '(无主题)';

            const color = getAvatarColor(senderName);
            const ts = keyTimestamp(displayKey);
            const timeStr = ts > 0 ? new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';

            const isRead = e.customMetadata?.isRead === 'true';
            const fontWeight = isRead ? 'font-normal' : 'font-semibold';
            const textColor = isRead ? 'text-gray-600' : 'text-gray-900';
            const dotHtml = !isRead && !isTrashPage ? '<span class="unread-dot"></span>' : '';

            // 主题与发件人完全由发件人控制，必须转义后才能拼进 HTML。
            // 行点击改成 data-key + 事件委托：原来拼进 onclick 单引号字符串里，
            // 而 encodeURIComponent 不转义单引号，主题带一个单引号就能注入脚本。
            return `
            <div class="group email-row block bg-white hover:bg-gray-50 border-b border-gray-100 transition-all cursor-pointer relative select-none" data-key="${escapeAttr(encodeURIComponent(displayKey))}">
                <div class="px-3 sm:px-6 py-3 sm:py-4 flex items-center">
                    <div class="flex-shrink-0 mr-3 sm:mr-4 z-20 h-full flex items-center"><label class="custom-checkbox cursor-pointer flex items-center justify-center w-6 h-6 sm:w-5 sm:h-5"><input type="checkbox" name="keys" value="${escapeAttr(fullKey)}" class="hidden" onchange="updateRowStyle(this)"><div class="w-5 h-5 border-2 border-gray-300 rounded-md bg-white flex items-center justify-center transition-colors hover:border-indigo-400"><svg class="w-3 h-3 text-white hidden pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg></div></label></div>
                    <div class="flex-shrink-0 mr-3 sm:mr-5"><div class="w-10 h-10 ${color} rounded-full flex items-center justify-center text-white font-semibold text-sm shadow-sm">${escapeHtml((senderName[0] || '?').toUpperCase())}</div></div>
                    <div class="min-w-0 flex-1 flex flex-col justify-center">
                        <div class="flex justify-between items-baseline mb-1">
                            <p class="text-sm sm:text-base ${fontWeight} text-gray-900 truncate mr-2">${dotHtml}${escapeHtml(senderName)}</p>
                            <p class="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">${escapeHtml(timeStr)}</p>
                        </div>
                        <p class="text-sm ${textColor} truncate leading-snug"><span class="${fontWeight}">${escapeHtml(subject)}</span></p>
                    </div>
                </div></div>`;
        }).join('');
        const emptyState = `<div class="flex flex-col items-center justify-center h-full text-center p-8 mt-20"><div class="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center text-gray-400 mb-4">${isTrashPage ? Icons.trash : Icons.inbox}</div><h3 class="text-gray-900 font-medium text-lg">${isTrashPage ? '回收站是空的' : '暂无邮件'}</h3><p class="text-sm text-gray-500">${isTrashPage ? '被删除的邮件将在此处保留' : '您的收件箱空空如也'}</p></div>`;
        
        const batchButtons = isTrashPage ? `
            <button onclick="confirmBatch('restore')" class="flex items-center px-3 py-2 bg-green-50 text-green-700 hover:bg-green-100 rounded-lg text-sm font-medium mr-2 whitespace-nowrap transition active:scale-[0.98]">${Icons.refresh} <span class="ml-1 hidden sm:inline">恢复</span></button>
            <button onclick="confirmBatch('purge')" class="flex items-center px-3 py-2 bg-red-50 text-red-700 hover:bg-red-100 rounded-lg text-sm font-medium whitespace-nowrap transition active:scale-[0.98]">${Icons.trash} <span class="ml-1 hidden sm:inline">删除</span></button>` : `
            <button onclick="confirmBatch('mark_read')" class="flex items-center px-3 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg text-sm font-medium mr-1 whitespace-nowrap transition active:scale-[0.98]" title="标记为已读">${Icons.read}</button>
            <button onclick="confirmBatch('mark_unread')" class="flex items-center px-3 py-2 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-lg text-sm font-medium mr-2 whitespace-nowrap transition active:scale-[0.98]" title="标记为未读">${Icons.unread}</button>
            <button onclick="confirmBatch('delete')" class="flex items-center px-3 py-2 bg-red-50 text-red-700 hover:bg-red-100 rounded-lg text-sm font-medium whitespace-nowrap transition active:scale-[0.98]">${Icons.trash}</button>`;
            
        const latestTimestamp = emails.length > 0 ? keyTimestamp(emails[0].key) : 0;

        const html = `
        <div class="flex flex-col h-full bg-white md:rounded-xl md:shadow-lg overflow-hidden">
            <div class="h-14 sm:h-16 px-3 sm:px-6 border-b border-gray-100 flex items-center justify-between bg-white shrink-0 z-20 sticky top-0 shadow-sm">
                <div class="flex items-center w-full">
                     <div class="mr-3 sm:mr-4 flex items-center"><button onclick="toggleMenu()" class="md:hidden mr-3 text-gray-500 p-1 -ml-2 rounded-full hover:bg-gray-100 active:scale-95">${Icons.menu}</button><label class="custom-checkbox cursor-pointer flex items-center justify-center w-6 h-6 sm:w-5 sm:h-5"><input type="checkbox" onclick="toggleAll(this)" class="hidden"><div class="w-5 h-5 border-2 border-gray-300 rounded-md bg-white flex items-center justify-center transition-colors hover:border-indigo-400"><svg class="w-3 h-3 text-white hidden pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg></div></label></div>
                    <div id="default-header" class="flex items-center justify-between w-full"><h1 class="text-lg sm:text-xl font-bold text-gray-800">${isTrashPage ? '回收站' : '收件箱'}</h1><div class="flex items-center gap-1"><a href="/settings" class="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-colors active:scale-95" title="设置">${Icons.gear}</a><button onclick="window.location.reload()" class="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-colors active:scale-95" title="刷新">${Icons.refresh}</button></div></div>
                    <div id="action-header" class="hidden flex items-center justify-between w-full"><span class="text-sm text-gray-600 font-medium whitespace-nowrap mr-2">已选 <span id="selected-count" class="text-indigo-600 font-bold">0</span></span><div class="flex items-center">${batchButtons}</div></div>
                </div>
            </div>
            <form id="batch-form" method="POST" action="/batch-action" class="flex-1 overflow-y-auto min-h-0 overscroll-y-contain custom-scrollbar bg-white safe-bottom"><input type="hidden" name="next" value="${isTrashPage ? '/trash' : '/'}">${emails.length > 0 ? listHtml : emptyState}</form>
        </div>`;
        return htmlResponse(renderLayout(html, isTrashPage ? 'trash' : 'inbox', latestTimestamp));
    }
    return textResponse('Not Found', 404);
}

// ==========================================
// 5. Cloudflare Workers 入口 (带邮件处理)
// ==========================================
export default {
    async fetch(request, env, ctx) {
        if (!env.MAIL_BUCKET) {
            return textResponse('服务未正确配置：缺少 MAIL_BUCKET 绑定（R2）。请确认 wrangler.jsonc 中的 r2_buckets 配置存在后重新部署。', 500);
        }
        try {
            return await handleRequest(request, env, ctx);
        } catch (e) {
            // 不把异常细节回显给客户端（会泄漏内部结构），完整堆栈只进日志
            console.error('Request failed:', e && e.stack ? e.stack : e);
            return htmlResponse('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>服务异常</title><script src="https://cdn.tailwindcss.com"></script></head><body class="h-screen flex items-center justify-center bg-gray-50"><div class="text-center p-8"><h1 class="text-2xl font-bold text-gray-900 mb-2">服务暂时不可用</h1><p class="text-gray-500 text-sm">请稍后重试。若持续出现，请查看 Worker 日志（Dashboard 的 Logs 页或 wrangler tail）。</p></div></body></html>', 500);
        }
    },

    async email(message, env, ctx) {
        if (!env.MAIL_BUCKET) {
            console.error('MAIL_BUCKET 绑定缺失，邮件未存储');
            return;
        }

        // 【关键修复】在「入库时」就把 RFC2047 编码的主题/发件人解码成明文。
        //
        // 旧版本是把原始头部直接写进键名、再由列表页解码。但键名会被 sanitize 掉 "?"，
        // 于是 =?UTF-8?B?xxxx?= 被破坏成 =_UTF-8_B_xxxx_=，编码标记没了、永远解不回来
        // —— 这就是「有些邮件主题乱码」的根因（只有非 ASCII 主题会中招）。
        const subject = clampText(
            decodeHeaderValue(message.headers.get('subject') || 'No_Subject').replace(/[\r\n]+/g, ' ').trim(),
            120
        ) || 'No_Subject';
        const from = clampText(
            decodeHeaderValue(message.from || 'Unknown').replace(/[\r\n]+/g, ' ').trim(),
            120
        ) || 'Unknown';

        // 键名格式 v2：<时间戳>_<发件人长度>_<发件人><主题>.eml
        // "/" 仍然要换成 "-"：它会被 encodeURIComponent 转成 %2F 放进 URL 路径，
        // 万一被中间层还原就会把 /email/<key> 的路径切坏。
        const keyFrom = from.replace(/[\/\\]/g, '-');
        const keySubject = subject.replace(/[\/\\]/g, '-');
        const key = Date.now() + '_' + keyFrom.length + '_' + keyFrom + keySubject + '.eml';

        try {
            const rawData = await new Response(message.raw).arrayBuffer();
            await env.MAIL_BUCKET.put(key, rawData, { customMetadata: { isRead: 'false' } });
        } catch (e) {
            // 入库失败必须留下日志，否则邮件会静默丢失
            console.error('Failed to store email:', e && e.stack ? e.stack : e);
            return;
        }

        // 邮件已入库，转发失败不应影响主流程。
        // 转发地址同样走「应用内设置 → 环境变量」回退，所以设置页改完即刻生效。
        try {
            const forward = resolveForwardEmail(await getSettings(env), env);
            if (forward.value) await message.forward(forward.value);
        } catch (e) {
            console.error('Forward failed:', e && e.stack ? e.stack : e);
        }
    }
};
