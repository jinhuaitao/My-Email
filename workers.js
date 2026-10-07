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

// 「最新邮件时间戳」标记。收信入库时顺手写一份，供前端每 15 秒的 /api/check 轮询读取。
// 不这样做的话，轮询就得每次全量列举 R2 才能算出最新时间 —— 既慢又费操作数。
const LATEST_FILE = SYS_PREFIX + 'latest.json';

// 列表页一次翻多少页。R2 单次 list() 最多返回 1000 个键，必须靠 cursor 翻页；
// 单页上限按 1000 算，20 页 = 最多 20000 封，足够个人邮箱，也避免异常情况下无限翻。
const LIST_PAGE_SIZE = 1000;
const LIST_MAX_PAGES = 20;

// 列表页分页。默认 50 封，URL 上的 ?limit= 会被夹到 [50, 2000]，
// 避免被放大成任意大的值把 Worker 拖垮。
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 2000;

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
// 分段翻译：单个片段太长会被模型截断，按段落切开分别翻再按顺序拼回去。
const TRANSLATE_CHUNK_SIZE = 2500;
const TRANSLATE_MAX_CHUNKS = 6;

// 「就地翻译」的并发与预算参数。
//
// ⚠️ 这里**刻意不做「多片段拼成一批、一次翻完」**的优化，原因见 translateHtmlPreservingLayout 的注释：
//    那套做法依赖 m2m100 按行返回，而它是句级 seq2seq 模型，对多行输入经常改变行数，
//    一旦对不上就整批作废 —— 普通邮件的片段往往正好全在一批里，于是整篇都翻不出来。
// 现在逐片段翻译，用这两个参数控制开销：
//   TRANSLATE_CONCURRENCY  并行度。Workers 单次调用最多 6 条并发出站连接（R2 也要占），所以留余量。
//   TRANSLATE_MAX_CALLS    单次请求的 AI 调用总预算。免费版子请求额度是 50，这里留足余量。
//                          超出预算的片段保持原文，并在状态条上如实告知，而不是让整个请求超时。
const TRANSLATE_CONCURRENCY = 4;
const TRANSLATE_MAX_CALLS = 48;

// 译文缓存前缀。译文按「原文的 HTML」整篇缓存，再次切换原文/译文时直接命中，不重复计费。
// 放在 _sys/ 下，天然不会出现在邮件列表里。
const TRANSLATION_CACHE_PREFIX = SYS_PREFIX + 'trans/';

// ==========================================
// 1. PWA & UI 资源
// ==========================================

const renderAppIcon = () => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#818cf8"/><stop offset=".55" stop-color="#4f46e5"/><stop offset="1" stop-color="#3730a3"/>
  </linearGradient></defs>
  <rect width="512" height="512" rx="128" fill="url(#g)"/>
  <path d="M112 160h288c17.6 0 32 14.4 32 32v192c0 17.6-14.4 32-32 32H112c-17.6 0-32-14.4-32-32V192c0-17.6 14.4-32 32-32zm20.8 32l106.6 86.6c9.6 7.8 23.6 7.8 33.2 0L379.2 192H132.8z" fill="white" opacity=".96"/>
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
// 【核心修复 · 主题乱编 3/4】编码内容的字符集里必须允许 "_"，而且结尾要靠结构扫描来定位。
//
// Q 编码用 "_" 表示空格（见 decodeEncodedWord），而老版本把 "?" 也清洗成了 "_"，
// 于是含空格的中文主题在旧键名里长这样：
//     =_GB2312_Q_=D6=D0_=CE=C4_=
// 这里有两个坑，只靠一条正则都躲不过：
//   ① 内容字符集若不含 "_"，匹配到 "=D6=D0" 就被迫收尾 → 还原出半截编码词，主题显示成 "中CE=C4"；
//   ② 若简单地把 "_" 并进字符集并贪婪匹配，又会把结尾的 "_=" 里的 "=" 一起吃进内容
//      → 译文末尾凭空多出一个 "="（实测发件人变成 "中 文 = <a@b.com>"）。
// 根因是 Q 编码里 "_" 同时承担「空格」和「分隔符」两种角色，本身就有歧义。
// 可靠的判据是：内容里的 "=" 一定是 "=XX"（后跟两位十六进制字节），而结尾 "?=" 的 "=" 后面不是。
// 因此改成手工扫描：先用正则锚定 "=_charset_type_"，再往后找第一个「后面不是两位十六进制」的 "_="。
function findEncodedWordEnd(text, start, type) {
    if (type.toUpperCase() === 'B') {
        // base64 字母表不含 "_"，第一个 "_=" 就是结尾
        const at = text.indexOf('_=', start);
        return at;
    }
    for (let i = start; i < text.length - 1; i++) {
        if (text[i] !== '_' || text[i + 1] !== '=') continue;
        const a = text.charAt(i + 2), b = text.charAt(i + 3);
        if (/[0-9A-Fa-f]/.test(a) && /[0-9A-Fa-f]/.test(b)) continue; // 这是内容里的 "=XX"
        return i;
    }
    return -1;
}

function salvageBrokenRfc2047(text) {
    if (!text || text.indexOf('=_') === -1) return text;
    const headRe = /^=_([A-Za-z0-9][A-Za-z0-9.*-]*)_([BbQq])_/;
    let out = '';
    let i = 0;
    while (i < text.length) {
        if (text[i] === '=' && text[i + 1] === '_') {
            const head = headRe.exec(text.slice(i));
            if (head) {
                const contentStart = i + head[0].length;
                const end = findEncodedWordEnd(text, contentStart, head[2]);
                if (end !== -1) {
                    out += '=?' + head[1] + '?' + head[2].toUpperCase() + '?' + text.slice(contentStart, end) + '?=';
                    i = end + 2; // 跳过结尾的 "_="
                    continue;
                }
            }
        }
        out += text[i];
        i++;
    }
    return out;
}

// 【核心修复 · 主题乱编 1/4】RFC 2047 编码词里的 Q 编码有个极易被忽略的规则：
// 字面下划线 "_" 代表**空格**（RFC 2047 §4.2 明确规定）。
// 而正文的 quoted-printable 里 "_" 就是下划线本身 —— 两者不能混用。
// 旧实现把编码词直接丢给 QP 解码器，于是：
//     =?UTF-8?Q?Hello_World?=      →  "Hello_World"（下划线没还原成空格）
//     =?GB2312?Q?=D6=D0_=CE=C4?=   →  "中_文"
//     =?UTF-8?Q?=E4=BD=A0_=E5=A5=BD?=  →  "你_好"
// 这是「主题乱编」里最常见的一类（用 Q 编码 + 下划线当空格的中文邮件特别多）。
// 所以只在「编码词」这一层把字面 "_" 先换成 =20 再解码；=5F 这种转义不受影响。
function decodeEncodedWord(content, type, charset) {
    if (String(type).toUpperCase() === 'B') return decodeContent(content, 'base64', charset);
    return decodeContent(String(content).replace(/_/g, '=20'), 'quoted-printable', charset);
}

// 【核心修复 · 主题乱编 2/4】RFC 2231 / RFC 5987 参数值的形状是：
//     charset'language'percent-encoded
// 只有「合法字符集名 + 两个单引号 + 含 %XX 的载荷」这种**严格形状**才允许做 URI 解码。
// 旧实现只要字符串里出现 "''" 就 split 后 decodeURIComponent(parts[1])，后果是：
//     "Re: it''s fine"  →  "s fine"      （主题前半段被整个吃掉）
// 把「参数值规则」套到普通主题/发件人上，就是「主题乱编」的第二大类根因。
const RFC2231_CHARSET_RE = /^(utf-?8|us-?ascii|ascii|iso-?8859-?[\d-]*|windows-?\d+|cp\d+|gbk|gb2312|gb18030|big5|shift[_-]?jis|euc-?(jp|kr)|koi8-r|latin\d*|unicode)$/i;

// 整个字符串都是百分号编码：不含空白，且每个 "%" 后面都紧跟两位十六进制。
const FULLY_PERCENT_ENCODED_RE = /^(?:[^%\s]|%[0-9A-Fa-f]{2})+$/;

function decodeRfc2231Value(text) {
    const m = /^([A-Za-z0-9._-]{2,20})'([A-Za-z0-9-]{0,10})'(.*)$/.exec(text);
    if (!m || !RFC2231_CHARSET_RE.test(m[1]) || !/%[0-9A-Fa-f]{2}/.test(m[3])) return null;
    try { return decodeURIComponent(m[3]); } catch (e) { return null; }
}

function decodeHeaderValue(text) {
    if (!text) return '';
    const raw = String(text);

    // 1) RFC 2231 参数值（filename* 之类）。严格匹配形状，普通主题绝不会命中。
    const rfc2231 = decodeRfc2231Value(raw);
    if (rfc2231 !== null) return rfc2231;

    // 2) RFC 2047 编码词（可跨空白拼接成多个词）。
    if (raw.includes('=?')) {
        const rfc2047Regex = /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g;
        const cleanText = raw.replace(/\?=\s+=\?/g, '?==?');
        const decoded = cleanText.replace(rfc2047Regex, (_, charset, type, content) =>
            decodeEncodedWord(content, type, charset)
        );
        if (decoded !== cleanText) return decoded;
    }

    // 3) 整串 URL 编码。同样必须严格 —— 旧实现无条件 decodeURIComponent，
    //    于是 "50%20off today" 变成 "50 off today"、"100%25 done" 变成 "100% done"。
    //    现在要求：全串无空白、每个 % 后跟两位十六进制、且至少 2 个转义。
    if (raw.includes('%') && FULLY_PERCENT_ENCODED_RE.test(raw)) {
        const escapes = (raw.match(/%[0-9A-Fa-f]{2}/g) || []).length;
        if (escapes >= 2) { try { return decodeURIComponent(raw); } catch (e) {} }
    }

    // 4) 只剥掉**成对**的首尾引号。旧实现用 /^["']|["']$/ 单边剥离，
    //    会把 '重要通知' 的引号剥掉、也会把 `"Bob" <b@x.com>` 剥成半拉。
    const first = raw.charAt(0);
    if (raw.length >= 2 && (first === '"' || first === "'") && raw.charAt(raw.length - 1) === first) {
        return raw.slice(1, -1);
    }
    return raw;
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

// 翻页列举全部对象。
//
// ⚠️ 这里原本有一个很隐蔽、但后果严重的 bug：直接 `list({ limit: 100 })` 当列表用。
//    R2 的 list() 是按**字典序升序**返回的，而邮件键名以时间戳开头 ——
//    所以拿到的永远是**最旧的** 100 封。邮件一旦超过 100 封，新邮件就再也不会出现在列表里
//    （回收站是 limit 50，同理）。它不报错、不告警，只是静静地少显示邮件。
//    正确做法：跟着 cursor 翻到底，再自己排序截取。
async function listAllObjects(env, { prefix = '' } = {}) {
    const objects = [];
    let cursor;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const opts = { limit: LIST_PAGE_SIZE, include: ['customMetadata'] };
        if (prefix) opts.prefix = prefix;
        if (cursor) opts.cursor = cursor;
        const res = await env.MAIL_BUCKET.list(opts);
        for (const o of (res && res.objects) || []) objects.push(o);
        // 没截断、或拿不到 cursor 就收工（桩实现可能不返回 cursor）
        if (!res || !res.truncated || !res.cursor) break;
        cursor = res.cursor;
    }
    return objects;
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
        const from = body.slice(0, fromLen);
        // 【核心修复】老键名（v1）里若发件人以「数字_」开头，会被上面的正则误当成 v2 的长度前缀。
        // 例：v1 键 `1699999999_2_x@y.com_Subject.eml` 会被解成 from="x@"、subject="y.com_Subject"。
        // 长度前缀截出来的发件人不可能以 "@" 或 "." 结尾（那一定是被拦腰截断的地址），据此排除。
        if (fromLen > 0 && fromLen <= body.length && !/[@.]$/.test(from)) {
            return {
                from: from,
                subject: body.slice(fromLen).replace(/\.eml$/i, '')
            };
        }
    }

    let rest = displayKey.replace(/^\d+_/, '').replace(/\.eml$/i, '');
    rest = salvageBrokenRfc2047(rest);
    const split = splitV1Key(rest);
    let subjectRaw = split.subject;
    // 老清洗把 ? " < > 换成了 "_"，这里近似还原成空格。
    // ⚠️ 但绝不能对**编码词**做这一步：salvageBrokenRfc2047 刚把 "=_UTF-8_Q_xxx_="
    //    拼回 "=?UTF-8?Q?xxx?="，此时词内的 "_" 正是「空格」语义，交给 decodeHeaderValue
    //    才会被正确还原；若在这里先全局换成空格，编码词会被打散成 "=?UTF-8?Q?xxx ?="。
    //    （实测主题会显示成 "=E4=BD=A0 =E5=A5=BD World" 这种半截乱码。）
    if (subjectRaw.indexOf('=?') === -1) {
        try { subjectRaw = decodeURIComponent(subjectRaw).replace(/_/g, ' '); } catch (e) {}
    }
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
        // 【核心修复 · 主题乱编 4/4】老清洗把 "<" ">" 也换成了 "_"，
        // 于是 `张三 <a@b.com>` 落盘成 `张三 _a@b.com`。
        // 上面的回溯扫描允许 "_"，会把地址前那个 "_" 一起吞进地址里，
        // 得到 addr="_a@b.com"、name="" —— 列表页显示成 "<_a@b.com>"，
        // 而 `>` 残留还会跑进主题（实测主题变成 ">你好"）。
        // 这里把地址前多余的 "_" 还给显示名，地址从真正的地址字符开始。
        while (s < e && rest[s] === '_') s++;
        const addr = rest.slice(s, e);
        const name = rest.slice(0, s).replace(/[_<>]+$/, '').trim();
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

// ---------- 「就地翻译」：只换文字，不动版式 ----------
//
// 旧做法：把正文压成纯文本 → 整段翻译 → 铺进一个 <div>。
// 结果是译文和原文版式毫无关系：段落、表格、按钮、图片位置全变，用户一按「翻译」就找不到原来看的地方。
//
// 新做法（按 token 就地替换）：
//   1) 把正文切成「标签」与「文本」两类 token，标签原样保留、一个都不动；
//   2) 只把可翻译的文本节点送去翻译；
//   3) 译文按**原位置**填回对应的文本节点。
// 因为标签结构、行内样式、表格布局完全没变，译文渲染出来的版式和原文一致 ——
// 也就是「尽量不改变原始显示位置」。

// 这些标签里的内容不显示或属于代码，一律不翻译（且已在上游被剥离）。
const NON_TEXT_TAGS = { script: 1, style: 1, head: 1, title: 1, noscript: 1, textarea: 1, option: 1 };

// 把 HTML 切成 token 流。标签/注释走 raw，普通文本走 text（只有在可翻译区域里才标记 text）。
function tokenizeHtml(html) {
    const out = [];
    const re = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g;
    const open = [];
    let m;
    while ((m = re.exec(html)) !== null) {
        const tok = m[0];
        if (tok.slice(0, 4) === '<!--') { out.push({ raw: tok }); continue; }
        if (tok.charCodeAt(0) === 60) { // '<'
            const closeMatch = /^<\s*\/\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tok);
            const openMatch = /^<\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tok);
            if (closeMatch) {
                const idx = open.lastIndexOf(closeMatch[1].toLowerCase());
                if (idx !== -1) open.length = idx;
            } else if (openMatch && NON_TEXT_TAGS[openMatch[1].toLowerCase()] && !/\/\s*>$/.test(tok)) {
                open.push(openMatch[1].toLowerCase());
            }
            out.push({ raw: tok });
            continue;
        }
        // 文本 token：只有不在 script/style 等内部时才可翻译
        out.push(open.length ? { raw: tok } : { raw: tok, text: tok });
    }
    return out;
}

const NAMED_ENTITIES = {
    nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
    mdash: '\u2014', ndash: '\u2013', laquo: '\u00ab', raquo: '\u00bb',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
    times: '\u00d7', divide: '\u00f7', middot: '\u00b7', bull: '\u2022',
    deg: '\u00b0', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
    sect: '\u00a7', para: '\u00b6', prime: '\u2032', permil: '\u2030', shy: '\u00ad'
};

// 翻译前把实体还原成字符（否则模型会把 "&amp;" 当成单词翻掉），翻译后再统一转义回去。
function decodeEntities(text) {
    return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
        if (body.charAt(0) === '#') {
            const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
            const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
            try { return String.fromCodePoint(code); } catch (e) { return whole; }
        }
        const named = NAMED_ENTITIES[body.toLowerCase()];
        return named === undefined ? whole : named;
    });
}

// 是否值得翻译：至少含一个字母（含中日韩等非拉丁文字），且长度 ≥ 2。
// 纯数字、纯符号、空白片段一律跳过 —— 它们通常是 "|" "·" "1" 这类排版装饰，翻了反而添乱。
function isTranslatableText(core) {
    if (core.length < 2) return false;
    return /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(core);
}

// 翻译一个「纯文本片段」。
// 片段超过 TRANSLATE_CHUNK_SIZE 时按段落切成最多 TRANSLATE_MAX_CHUNKS 段，**顺序**翻译后拼回。
// 这里刻意串行而非 Promise.all：外层已有并发池，再叠加一层会突破
// Workers「单次调用最多 6 条并发出站连接」的限制。分段只发生在超长片段上，串行代价可接受。
async function translateCoreText(env, core, source) {
    const split = splitForTranslation(core, TRANSLATE_CHUNK_SIZE, TRANSLATE_MAX_CHUNKS);
    if (split.chunks.length === 0) return '';
    const out = [];
    for (const chunk of split.chunks) {
        const res = await env.AI.run(TRANSLATE_MODEL, {
            text: chunk, source_lang: source, target_lang: TRANSLATE_TARGET
        });
        const text = pickTranslatedText(res);
        // 任何一段没翻出来就整段放弃（返回空串），避免译文里混进半截原文。
        if (!text) return '';
        out.push(text);
    }
    return out.join('\n\n').trim();
}

// 固定并发的任务池。单项抛错只记录、不中断其它项。
async function runPool(items, lanes, worker) {
    let cursor = 0;
    const n = Math.max(1, Math.min(lanes, items.length));
    const runners = [];
    for (let i = 0; i < n; i++) {
        runners.push((async () => {
            for (;;) {
                const idx = cursor++;
                if (idx >= items.length) return;
                try { await worker(items[idx], idx); } catch (e) { /* 单项失败不影响其它 */ }
            }
        })());
    }
    await Promise.all(runners);
}

// 主流程：tokenize → 挑出可翻片段 → 去重 → 并发逐段翻译 → 按原位置拼回。
//
// ⚠️ 为什么**不**把多个片段拼成一批、一次翻完？
//    试过：用换行拼接后送进 m2m100，指望它按行返回、再按行拆回。这条路走不通 ——
//    m2m100 是句级 seq2seq 模型，对多行输入经常合并或改变行数；行数一旦对不上，
//    为了不让译文错位就只能整批作废。而普通邮件的片段往往正好全部落进同一批，
//    于是「一批作废」= 整篇一个字都没翻出来，用户看到的就是「翻译失败，请稍后重试」。
//    现在改成逐片段翻译：不依赖模型保留任何结构，稳定性高得多。
//    调用量用两个办法压住：① 相同片段去重（营销邮件里重复的按钮文字只翻一次）；
//    ② 设总调用预算，超出预算的片段保持原文并如实上报，而不是让整个请求超时。
//
// 返回 { html, segments, skipped, truncated }。
// 一个片段都没翻出来时抛错（带 reason），由上层给出可读原因。
async function translateHtmlPreservingLayout(env, html, source) {
    const tokens = tokenizeHtml(String(html || ''));

    const targets = [];
    for (const t of tokens) {
        if (!t.text) continue;
        const plain = decodeEntities(t.text);
        const core = plain.trim();
        if (!isTranslatableText(core)) continue;
        const at = plain.indexOf(core);
        t.lead = plain.slice(0, at);
        t.trail = plain.slice(at + core.length);
        t.core = core;
        targets.push(t);
    }

    if (targets.length === 0) {
        return { html: tokens.map(t => t.raw).join(''), segments: 0, skipped: 0, truncated: false };
    }

    // 去重：同文片段只翻一次，结果回填给所有副本。
    const groups = new Map();
    for (const t of targets) {
        let g = groups.get(t.core);
        if (!g) { g = { core: t.core, tokens: [] }; groups.set(t.core, g); }
        g.tokens.push(t);
    }

    // 按**文档顺序**取前 N 个不重复片段：保证从上往下优先翻译，观感最自然。
    const planned = [];
    const seen = new Set();
    for (const t of targets) {
        if (seen.has(t.core)) continue;
        seen.add(t.core);
        if (planned.length >= TRANSLATE_MAX_CALLS) break;
        planned.push(groups.get(t.core));
    }

    const failures = [];
    await runPool(planned, TRANSLATE_CONCURRENCY, async (g) => {
        try {
            const text = await translateCoreText(env, g.core, source);
            if (!text) { failures.push('empty-output'); return; }
            for (const t of g.tokens) t.translated = text;
        } catch (e) {
            failures.push(String((e && e.message) || e).slice(0, 160));
            console.error('Translate segment failed:', e && e.stack ? e.stack : e);
        }
    });

    const done = targets.filter(t => typeof t.translated === 'string').length;
    if (done === 0) {
        const err = new Error('translation produced no output');
        err.reason = failures.length ? failures[0] : 'no-output';
        err.attempted = planned.length;
        throw err;
    }

    let out = '';
    for (const t of tokens) {
        out += typeof t.translated === 'string'
            ? escapeHtml(t.lead + t.translated + t.trail)
            : t.raw;
    }
    return {
        html: out,
        segments: done,
        skipped: targets.length - done,
        truncated: targets.length - done > 0
    };
}

// 把底层错误翻成用户看得懂、能行动的一句话。
// 免费版 Workers AI 每天有 10,000 Neurons 额度，用尽后所有调用都会失败 ——
// 这正好是「昨天还能翻、今天突然不行」最常见的原因，必须点名，而不是笼统说「翻译失败」。
function describeTranslateFailure(reason) {
    const r = String(reason || '');
    if (!r || r === 'empty-output' || r === 'no-output') return '模型没有返回内容，请稍后重试';
    if (/neuron|quota|exceed|rate|limit|429|too many|capacity/i.test(r)) {
        return 'Workers AI 额度可能已用尽或触发限流，请稍后重试（免费版每天 10,000 Neurons）';
    }
    if (/not found|no such|binding|unauthor|forbidden|invalid model/i.test(r)) {
        return 'Workers AI 绑定或模型不可用，请检查 wrangler.jsonc 的 ai 绑定后重新部署';
    }
    return '模型返回错误：' + r;
}

// 译文缓存的键：对邮件键名取哈希，避免超长键名；去掉 trash/ 前缀让收件箱与回收站共用一份译文。
async function translationCacheKey(mailKey) {
    const base = String(mailKey).replace(TRASH_PREFIX, '');
    return TRANSLATION_CACHE_PREFIX + (await sha256Hex(base)).slice(0, 40) + '.html';
}

async function dropTranslationCache(env, mailKey) {
    try { await env.MAIL_BUCKET.delete(await translationCacheKey(mailKey)); } catch (e) {}
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

// ---------- 图标库（Heroicons 风格，线性 24px） ----------
// 所有图标统一 stroke="currentColor"，颜色由父级文字颜色决定，
// 尺寸由 class 控制（w-4/w-5/w-6），在不同位置复用时保持视觉一致。

const Icons = {
    inbox: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>`,
    star: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /></svg>`,
    starFill: `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.006z" clip-rule="evenodd" /></svg>`,
    trash: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`,
    refresh: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>`,
    logout: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>`,
    back: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>`,
    chevL: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" /></svg>`,
    chevR: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>`,
    attach: `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>`,
    file: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>`,
    download: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>`,
    menu: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>`,
    user: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>`,
    lock: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>`,
    spinner: `<svg class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`,
    alert: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>`,
    read: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 19v-8.93a2 2 0 01.89-1.664l7-4.666a2 2 0 012.22 0l7 4.666A2 2 0 0121 10.07V19M3 19a2 2 0 002 2h14a2 2 0 002-2M3 19l6.75-4.5M21 19l-6.75-4.5M3 10l6.75 4.5M21 10l-6.75 4.5m0 0l-1.14.76a2 2 0 01-2.22 0l-1.14-.76" /></svg>`,
    unread: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>`,
    checkAll: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`,
    gear: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>`,
    translate: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" /></svg>`,
    search: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" /></svg>`,
    key: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>`,
    sun: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" /></svg>`,
    moon: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0012 21.75a9.753 9.753 0 009.752-6.748z" /></svg>`,
    copy: `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25" /></svg>`,
    print: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0110.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0l.229 2.523a1.125 1.125 0 01-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0021 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 00-1.913-.247M6.34 18H5.25A2.25 2.25 0 013 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 011.913-.247m10.5 0a48.051 48.051 0 00-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659" /></svg>`,
    code: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" /></svg>`,
    check: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>`,
    x: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>`,
    info: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>`,
    chart: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>`,
    send: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>`,
    shield: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" /></svg>`,
    eye: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>`,
    eyeSlash: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>`
};


// ==========================================
// 3. UI 设计系统 + 全局布局
// ==========================================
//
// 设计语言 v2（"Clarity"）：
//   - 全站由 CSS 变量驱动配色，深色模式只需翻转变量，无需重写 class；
//   - 组件类（.btn/.card/.input/.nav-item/.email-row/...）保证所有页面视觉统一；
//   - Tailwind 只负责布局（flex/grid/间距），颜色语义全部走组件类，
//     避免"每个页面各自拼一套颜色"导致的不协调。

const THEME_CSS = `
:root{
  --brand:#4f46e5; --brand-600:#4338ca; --brand-700:#3730a3;
  --brand-50:#eef2ff; --brand-100:#e0e7ff;
  --bg:#f3f4fa; --surface:#ffffff; --surface-2:#f7f8fc;
  --border:#e7e9f2; --border-strong:#d8dbe8;
  --text-1:#141926; --text-2:#5b6378; --text-3:#9aa1b8;
  --danger:#dc2626; --danger-bg:#fef2f2; --danger-border:#fecaca;
  --success:#059669; --success-bg:#ecfdf5; --success-border:#a7f3d0;
  --warning:#d97706; --warning-bg:#fffbeb; --warning-border:#fde68a;
  --info-bg:#eff6ff; --info-border:#bfdbfe; --info-text:#1d4ed8;
  --star:#f59e0b;
  --radius:14px;
  --shadow:0 1px 2px rgba(18,24,48,.05),0 10px 28px -14px rgba(18,24,48,.16);
  --shadow-lg:0 18px 50px -12px rgba(18,24,48,.28);
  color-scheme:light;
}
html.dark{
  --brand:#818cf8; --brand-600:#6d7bf5; --brand-700:#a5b4fc;
  --brand-50:#1d2342; --brand-100:#283058;
  --bg:#0a0d18; --surface:#11162a; --surface-2:#0d1224;
  --border:#222948; --border-strong:#303a61;
  --text-1:#e9edf9; --text-2:#a3abd0; --text-3:#5f688c;
  --danger:#f87171; --danger-bg:rgba(220,38,38,.13); --danger-border:rgba(220,38,38,.35);
  --success:#34d399; --success-bg:rgba(5,150,105,.13); --success-border:rgba(5,150,105,.35);
  --warning:#fbbf24; --warning-bg:rgba(217,119,6,.13); --warning-border:rgba(217,119,6,.35);
  --info-bg:rgba(59,130,246,.13); --info-border:rgba(59,130,246,.35); --info-text:#93c5fd;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 28px -14px rgba(0,0,0,.55);
  --shadow-lg:0 18px 50px -12px rgba(0,0,0,.6);
  color-scheme:dark;
}
html,body{height:100%}
body{font-family:'Inter',system-ui,-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;-webkit-tap-highlight-color:transparent;background:var(--bg);color:var(--text-1)}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:8px;border:3px solid transparent;background-clip:content-box}
*::-webkit-scrollbar-thumb:hover{background:var(--text-3);border:3px solid transparent;background-clip:content-box}
*::-webkit-scrollbar-track{background:transparent}
*{scrollbar-width:thin;scrollbar-color:var(--border-strong) transparent}

/* ---------- 按钮 ---------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;font-weight:600;font-size:.875rem;line-height:1.25;padding:.65rem 1.15rem;border-radius:12px;border:1px solid transparent;cursor:pointer;transition:all .16s ease;white-space:nowrap;user-select:none}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.55;cursor:not-allowed;transform:none}
.btn-primary{background:linear-gradient(135deg,var(--brand),var(--brand-600));color:#fff;box-shadow:0 8px 18px -8px rgba(79,70,229,.55)}
.btn-primary:hover{filter:brightness(1.07)}
.btn-soft{background:var(--brand-50);color:var(--brand-700)}
.btn-soft:hover{background:var(--brand-100)}
.btn-ghost{background:transparent;color:var(--text-2)}
.btn-ghost:hover{background:var(--surface-2);color:var(--text-1)}
.btn-danger{background:var(--danger);color:#fff;box-shadow:0 8px 18px -8px rgba(220,38,38,.5)}
.btn-danger:hover{filter:brightness(1.06)}
.btn-danger-soft{background:var(--danger-bg);color:var(--danger);border:1px solid var(--danger-border)}
.btn-danger-soft:hover{filter:brightness(.98)}
.btn-success-soft{background:var(--success-bg);color:var(--success);border:1px solid var(--success-border)}
.btn-outline{background:var(--surface);border-color:var(--border-strong);color:var(--text-1)}
.btn-outline:hover{border-color:var(--brand);color:var(--brand-700)}
.btn-dark{background:#171c30;color:#fff}
.btn-dark:hover{background:#232a48}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;min-width:2.5rem;height:2.5rem;padding:0 .5rem;border-radius:12px;color:var(--text-3);cursor:pointer;transition:all .15s;border:1px solid transparent;background:transparent}
.icon-btn:hover{background:var(--surface-2);color:var(--brand-700)}
.icon-btn:active{transform:scale(.94)}
.icon-btn.danger:hover{background:var(--danger-bg);color:var(--danger)}
.icon-btn:disabled{opacity:.35;cursor:not-allowed;transform:none}
.icon-btn.on{background:var(--brand-50);color:var(--brand-700)}

/* ---------- 输入框 ---------- */
.input{width:100%;background:var(--surface-2);border:1.5px solid var(--border);color:var(--text-1);border-radius:12px;padding:.72rem 1rem;font-size:.9rem;outline:none;transition:border-color .16s,box-shadow .16s,background .16s}
.input:focus{background:var(--surface);border-color:var(--brand);box-shadow:0 0 0 4px rgba(79,70,229,.13)}
.input::placeholder{color:var(--text-3)}
select.input{appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:2.5rem;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%239aa1b8' stroke-width='2'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right .9rem center;background-size:1rem}
select.input:focus{background-color:var(--surface)}
.field-label{display:block;font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:.45rem}

/* ---------- 卡片 / 面板 ---------- */
.card{background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow)}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:1.35rem;box-shadow:var(--shadow)}
.panel-title{font-size:1rem;font-weight:700;color:var(--text-1);display:flex;align-items:center;gap:.6rem}
.panel-desc{font-size:.8rem;color:var(--text-2);margin-top:.3rem;line-height:1.6}

/* ---------- 提示条 ---------- */
.alert{display:flex;gap:.7rem;align-items:flex-start;padding:.9rem 1.1rem;border-radius:14px;font-size:.875rem;line-height:1.6;border:1px solid}
.alert-error{background:var(--danger-bg);border-color:var(--danger-border);color:var(--danger)}
.alert-ok{background:var(--success-bg);border-color:var(--success-border);color:var(--success)}
.alert-info{background:var(--info-bg);border-color:var(--info-border);color:var(--info-text)}

/* ---------- 徽标 / 标签 ---------- */
.nbadge{min-width:1.5rem;height:1.5rem;padding:0 .45rem;border-radius:999px;background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);font-size:.72rem;font-weight:700;display:inline-flex;align-items:center;justify-content:center;margin-left:auto;flex-shrink:0}
.nbadge.hot{background:var(--brand);border-color:var(--brand);color:#fff}
.chip{display:inline-flex;align-items:center;gap:.35rem;padding:.28rem .7rem;border-radius:999px;font-size:.75rem;font-weight:600;border:1px solid}
.chip-green{background:var(--success-bg);border-color:var(--success-border);color:var(--success)}
.chip-blue{background:var(--info-bg);border-color:var(--info-border);color:var(--info-text)}
.chip-gray{background:var(--surface-2);border-color:var(--border);color:var(--text-2)}
.chip-amber{background:var(--warning-bg);border-color:var(--warning-border);color:var(--warning)}

/* ---------- 应用骨架 ---------- */
.app-shell{display:flex;height:100dvh;overflow:hidden;background:var(--bg)}
.sidebar{width:250px;flex-shrink:0;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;z-index:50}
.brand{display:flex;align-items:center;gap:.75rem;padding:1.15rem 1.25rem;border-bottom:1px solid var(--border);height:4.5rem;flex-shrink:0}
.brand-logo{width:2.4rem;height:2.4rem;border-radius:.8rem;background:linear-gradient(135deg,#6366f1,#4f46e5 60%,#3730a3);display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 6px 14px -4px rgba(79,70,229,.55);flex-shrink:0}
.brand-name{font-size:1.12rem;font-weight:800;letter-spacing:-.02em;color:var(--text-1)}
.brand-name small{display:block;font-size:.62rem;font-weight:600;letter-spacing:.14em;color:var(--text-3);text-transform:uppercase}
.side-nav{flex:1;overflow-y:auto;padding:.9rem .8rem;display:flex;flex-direction:column;gap:.25rem}
.nav-item{display:flex;align-items:center;gap:.8rem;padding:.68rem .9rem;border-radius:12px;font-weight:500;font-size:.92rem;color:var(--text-2);transition:all .14s;cursor:pointer}
.nav-item:hover{background:var(--surface-2);color:var(--text-1)}
.nav-item.active{background:var(--brand-50);color:var(--brand-700);font-weight:700}
.nav-item.active.trashy{background:var(--danger-bg);color:var(--danger)}
.nav-item svg{flex-shrink:0}
.side-foot{padding:.8rem;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:.25rem}
.main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;position:relative}

/* ---------- 视图（列表/详情/设置共用） ---------- */
.view{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--surface);overflow:hidden}
@media(min-width:768px){.view{margin:.9rem;border-radius:20px;border:1px solid var(--border);box-shadow:var(--shadow)}}
.view-head{display:flex;align-items:center;gap:.4rem;padding:.65rem .9rem;border-bottom:1px solid var(--border);background:var(--surface);z-index:20;flex-shrink:0}
.view-title{font-size:1.08rem;font-weight:800;letter-spacing:-.01em;color:var(--text-1)}
.view-sub{font-size:.78rem;color:var(--text-3)}
.view-body{flex:1;overflow-y:auto;min-height:0;overscroll-behavior:contain}
.view-divider{height:1px;background:var(--border);flex-shrink:0}

/* ---------- 邮件行 ---------- */
.email-row{display:block;background:var(--surface);border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s;position:relative;user-select:none;content-visibility:auto;contain-intrinsic-size:auto 78px}
.email-row:hover{background:var(--surface-2)}
.email-row.selected{background:var(--brand-50)}
.email-row.kb-focus{box-shadow:inset 3px 0 0 var(--brand)}
.unread-dot{width:8px;height:8px;background:var(--brand);border-radius:50%;display:inline-block;margin-right:.45rem;flex-shrink:0;box-shadow:0 0 0 3px var(--brand-50)}
.star-btn{display:inline-flex;align-items:center;justify-content:center;width:2rem;height:2rem;border-radius:9px;color:var(--text-3);cursor:pointer;transition:all .14s;background:transparent;border:none;flex-shrink:0}
.star-btn:hover{background:var(--surface-2);color:var(--star);transform:scale(1.12)}
.star-btn.on{color:var(--star)}
.star-btn.on:hover{transform:scale(1.12)}
.avatar{border-radius:999px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;flex-shrink:0;letter-spacing:.02em}

/* ---------- 复选框 ---------- */
.cbx{position:relative;display:inline-flex;cursor:pointer}
.cbx input{position:absolute;opacity:0;width:0;height:0}
.cbx .box{width:1.25rem;height:1.25rem;border-radius:.45rem;border:2px solid var(--border-strong);background:var(--surface);display:flex;align-items:center;justify-content:center;transition:all .14s;color:#fff}
.cbx .box svg{width:.8rem;height:.8rem;display:none}
.cbx input:checked + .box{background:var(--brand);border-color:var(--brand)}
.cbx input:checked + .box svg{display:block}
.cbx:hover .box{border-color:var(--brand)}

/* ---------- 空状态 ---------- */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:4rem 1.5rem}
.empty-icon{width:4.2rem;height:4.2rem;border-radius:1.4rem;background:var(--surface-2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--text-3);margin-bottom:1.1rem}
.empty h3{font-size:1.05rem;font-weight:700;color:var(--text-1);margin-bottom:.35rem}
.empty p{font-size:.85rem;color:var(--text-2);max-width:22rem;line-height:1.7}

/* ---------- Toast ---------- */
#toast-wrap{position:fixed;bottom:1.4rem;left:50%;transform:translateX(-50%);z-index:200;display:flex;flex-direction:column;gap:.5rem;align-items:center;pointer-events:none;width:max-content;max-width:92vw}
.toast{display:flex;align-items:center;gap:.6rem;background:#1c2133;color:#f2f4fb;padding:.75rem 1.15rem;border-radius:14px;font-size:.87rem;font-weight:500;box-shadow:var(--shadow-lg);opacity:0;transform:translateY(12px) scale(.96);transition:all .28s cubic-bezier(.16,1,.3,1);max-width:92vw}
html.dark .toast{background:#e9edf9;color:#141926}
.toast.show{opacity:1;transform:translateY(0) scale(1)}
.toast .t-dot{width:.55rem;height:.55rem;border-radius:99px;background:var(--brand);flex-shrink:0}
.toast-success .t-dot{background:var(--success)}
.toast-error .t-dot{background:var(--danger)}

/* ---------- 弹窗 ---------- */
.modal-backdrop{position:fixed;inset:0;z-index:150;background:rgba(15,18,35,.45);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:1rem;opacity:0;pointer-events:none;transition:opacity .18s}
.modal-backdrop.open{opacity:1;pointer-events:auto}
.modal-panel{background:var(--surface);border:1px solid var(--border);border-radius:20px;box-shadow:var(--shadow-lg);width:100%;max-width:24rem;padding:1.6rem;transform:scale(.94) translateY(8px);transition:transform .22s cubic-bezier(.16,1,.3,1)}
.modal-backdrop.open .modal-panel{transform:scale(1) translateY(0)}
.modal-icon{width:3rem;height:3rem;border-radius:1rem;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem}

/* ---------- 统计卡片 ---------- */
.stat{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:1.05rem 1.15rem;display:flex;align-items:center;gap:.9rem;box-shadow:var(--shadow);transition:transform .15s}
.stat:hover{transform:translateY(-2px)}
a.stat{cursor:pointer;text-decoration:none}
a.stat:hover{border-color:var(--brand);box-shadow:var(--shadow-lg)}
a.stat:active{transform:translateY(0)}
.stat-ic{width:2.7rem;height:2.7rem;border-radius:.9rem;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.stat-num{font-size:1.35rem;font-weight:800;letter-spacing:-.02em;color:var(--text-1);line-height:1.2}
.stat-lbl{font-size:.75rem;color:var(--text-2);font-weight:500}

/* ---------- 开关（checkbox 美化） ---------- */
.switch{position:relative;display:inline-block;width:42px;height:24px;flex-shrink:0;vertical-align:middle}
.switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;z-index:1}
.switch .tr{position:absolute;inset:0;border-radius:999px;background:var(--border-strong);transition:background .18s}
.switch .th{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .18s}
.switch input:checked~.tr{background:var(--brand-600)}
.switch input:checked~.th{transform:translateX(18px)}
.switch input:focus-visible~.tr{outline:2px solid var(--brand);outline-offset:2px}
.switch-row{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.85rem 0}
.switch-row+.switch-row{border-top:1px solid var(--border)}

/* ---------- 设置区块操作行 ---------- */
.panel-actions{display:flex;align-items:center;gap:.75rem;margin-top:1.1rem;flex-wrap:wrap}
.panel-actions .spacer{flex:1}

/* ---------- 附件 ---------- */
.att{display:flex;align-items:center;gap:.8rem;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:.8rem .9rem;transition:all .15s}
.att:hover{border-color:var(--brand);box-shadow:var(--shadow)}
.att-ic{width:2.5rem;height:2.5rem;border-radius:.8rem;background:var(--brand-50);color:var(--brand-700);display:flex;align-items:center;justify-content:center;flex-shrink:0}

/* ---------- 详情页头部信息 ---------- */
.kv{display:grid;grid-template-columns:auto 1fr;gap:.3rem .9rem;font-size:.83rem}
.kv dt{color:var(--text-3);font-weight:600;white-space:nowrap}
.kv dd{color:var(--text-1);word-break:break-all;user-select:text}

/* ---------- 快捷键 ---------- */
.kbd{display:inline-flex;align-items:center;justify-content:center;min-width:1.6rem;height:1.6rem;padding:0 .4rem;border-radius:.45rem;background:var(--surface-2);border:1px solid var(--border-strong);border-bottom-width:2px;font-size:.72rem;font-weight:700;color:var(--text-2);font-family:inherit}

/* ---------- 登录页 ---------- */
.auth-bg{min-height:100dvh;display:flex;background:var(--bg)}
.auth-side{flex:1;display:none;position:relative;overflow:hidden;background:linear-gradient(140deg,#312e81 0%,#4f46e5 45%,#6d28d9 100%)}
@media(min-width:1024px){.auth-side{display:flex;flex-direction:column;justify-content:space-between;padding:3rem;color:#fff}}
.auth-orb{position:absolute;border-radius:50%;filter:blur(90px);opacity:.5;pointer-events:none}
.auth-form-wrap{flex:1;display:flex;align-items:center;justify-content:center;padding:1.5rem;min-width:0}
.auth-card{width:100%;max-width:26rem}
.feat{display:flex;gap:.9rem;align-items:flex-start}
.feat-ic{width:2.6rem;height:2.6rem;border-radius:.9rem;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;flex-shrink:0;backdrop-filter:blur(4px)}

.safe-bottom{padding-bottom:env(safe-area-inset-bottom)}
.fade-in{animation:fadeIn .3s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes toastIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
`;

const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('cfmail-theme');if(t==='dark'){document.documentElement.classList.add('dark');}}catch(e){}})();`;

// 全局前端脚本：时间渲染、新邮件轮询、弹窗、批量操作、星标、
// iframe 高度自适应、行点击委托、主题、Toast、键盘快捷键。
// 注意：正文 iframe 高度必须「原样采用、绝不加固定增量」，
// 否则会形成"视口变高 → 测得更高 → iframe 再变高"的正反馈
// （详见原实现注释，实测 4 秒能涨 1700px）。
const GLOBAL_SCRIPT = `
(function(){
'use strict';
var ICON_STAR = '${'<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /></svg>'}';
var ICON_STAR_FILL = '${'<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.006z" clip-rule="evenodd" /></svg>'}';

/* ---------- 主题 ---------- */
function currentTheme(){ try{ return localStorage.getItem('cfmail-theme') || 'light'; }catch(e){ return 'light'; } }
function syncThemeIcon(){
  var dark = document.documentElement.classList.contains('dark');
  var a = document.getElementById('theme-ic-light'), b = document.getElementById('theme-ic-dark');
  if(a) a.style.display = dark ? 'none' : '';
  if(b) b.style.display = dark ? '' : 'none';
}
window.toggleTheme = function(){
  var dark = !document.documentElement.classList.contains('dark');
  document.documentElement.classList.toggle('dark', dark);
  try{ localStorage.setItem('cfmail-theme', dark ? 'dark' : 'light'); }catch(e){}
  var meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', dark ? '#0a0d18' : '#4f46e5');
  syncThemeIcon();
};
syncThemeIcon();

/* ---------- Toast ---------- */
window.toast = function(msg, kind){
  var wrap = document.getElementById('toast-wrap');
  if(!wrap) return;
  var t = document.createElement('div');
  t.className = 'toast' + (kind === 'success' ? ' toast-success' : kind === 'error' ? ' toast-error' : '');
  var dot = document.createElement('span'); dot.className = 't-dot';
  var txt = document.createElement('span'); txt.textContent = msg;
  t.appendChild(dot); t.appendChild(txt);
  wrap.appendChild(t);
  requestAnimationFrame(function(){ t.classList.add('show'); });
  setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){ t.remove(); }, 320); }, 3400);
  while(wrap.children.length > 3) wrap.removeChild(wrap.firstChild);
};
// 服务端经 ?toast= 参数传递一次性通知（批量操作后跳转时用）
(function(){
  try{
    var u = new URL(window.location.href);
    var msg = u.searchParams.get('toast');
    if(msg){
      u.searchParams.delete('toast');
      window.history.replaceState(null, '', u.pathname + (u.search ? '?' + u.searchParams.toString() : '') + u.hash);
      // 注意：URLSearchParams.get() 已经做过一次解码，这里不能再 decodeURIComponent，
      // 否则消息里带 %（如主题里的 50%）会抛 URIError。
      setTimeout(function(){ window.toast(msg, 'success'); }, 250);
    }
  }catch(e){}
})();

/* ---------- 时间（服务端只给时间戳，浏览器按本地时区渲染） ---------- */
function formatTs(ts, full){
  var d = new Date(ts), now = new Date();
  var pad = function(n){ return String(n).padStart(2, '0'); };
  var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if(full) return d.getFullYear() + '年' + (d.getMonth()+1) + '月' + d.getDate() + '日 ' + hm;
  if(d.toDateString() === now.toDateString()) return hm;
  if(d.getFullYear() === now.getFullYear()) return (d.getMonth()+1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '年' + (d.getMonth()+1) + '月' + d.getDate() + '日';
}
function hydrateTimes(){
  var nodes = document.querySelectorAll('time[data-ts]');
  for(var i=0;i<nodes.length;i++){
    var el = nodes[i], ts = parseInt(el.getAttribute('data-ts'), 10);
    if(ts > 0) el.textContent = formatTs(ts, el.getAttribute('data-fmt') === 'full');
  }
}
document.addEventListener('DOMContentLoaded', hydrateTimes);

/* ---------- 新邮件轮询（仅收件箱首页） ---------- */
if(window.location.pathname === '/' && window.CURRENT_PAGE_LATEST_TS > 0){
  setInterval(function(){
    fetch('/api/check').then(function(r){ return r.ok ? r.json() : null; }).then(function(data){
      if(data && data.latest > window.CURRENT_PAGE_LATEST_TS){
        toast('收到新邮件，正在刷新…');
        setTimeout(function(){ window.location.reload(); }, 1400);
      }
    }).catch(function(){});
  }, 15000);
}

/* ---------- 弹窗 ---------- */
window._confirmCallback = null;
window.showModal = function(title, msg, callback, isDestructive){
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-msg').textContent = msg;
  var ic = document.getElementById('modal-icon');
  ic.className = 'modal-icon ' + (isDestructive ? '' : '');
  ic.style.background = isDestructive ? 'var(--danger-bg)' : 'var(--brand-50)';
  ic.style.color = isDestructive ? 'var(--danger)' : 'var(--brand-700)';
  var btn = document.getElementById('modal-confirm-btn');
  btn.className = 'btn flex-1 ' + (isDestructive ? 'btn-danger' : 'btn-primary');
  var bd = document.getElementById('modal-backdrop');
  bd.classList.add('open');
  window._confirmCallback = callback;
};
window.hideModal = function(){
  document.getElementById('modal-backdrop').classList.remove('open');
  window._confirmCallback = null;
};
window.onModalConfirm = function(){ if(window._confirmCallback) window._confirmCallback(); hideModal(); };
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') hideModal(); });

window.confirmBatch = function(action){
  var map = { 'delete':'移入回收站', 'purge':'彻底删除', 'restore':'恢复', 'mark_read':'标记为已读', 'mark_unread':'标记为未读', 'star':'加星标', 'unstar':'取消星标' };
  var isDestructive = action === 'delete' || action === 'purge';
  if(action === 'mark_read' || action === 'mark_unread' || action === 'star' || action === 'unstar'){ submitBatchForm(action); return; }
  var label = map[action] || '执行操作';
  showModal(label, '确定要将选中的邮件' + label + '吗？' + (action === 'purge' ? '此操作不可恢复。' : '此操作可撤销。'), function(){ submitBatchForm(action); }, isDestructive);
};
window.submitBatchForm = function(action){
  var form = document.getElementById('batch-form');
  var input = document.createElement('input');
  input.type = 'hidden'; input.name = 'action'; input.value = action;
  form.appendChild(input); form.submit();
};
window.confirmSingle = function(event, msg, isDestructive){
  event.preventDefault();
  var form = event.target;
  showModal('确认操作', msg, function(){ form.submit(); }, !!isDestructive);
  return false;
};
// 危险操作二次确认：第一次点击只"上膛"，4 秒内再点一次才真正提交
window.askClear = function(btn){
  if(btn.dataset.armed === '1') return true;
  btn.dataset.armed = '1';
  var original = btn.innerHTML;
  btn.innerHTML = '再点一次确认清空';
  btn.classList.add('btn-danger');
  setTimeout(function(){ btn.dataset.armed = ''; btn.innerHTML = original; btn.classList.remove('btn-danger'); }, 4000);
  return false;
};

/* ---------- 批量选择 ---------- */
window.toggleAll = function(source){
  var boxes = document.querySelectorAll('#mail-list input[name="keys"]');
  for(var i=0;i<boxes.length;i++){ boxes[i].checked = source.checked; paintRow(boxes[i]); }
  updateToolbar();
};
function paintRow(checkbox){
  var row = checkbox.closest('.email-row');
  if(row) row.classList.toggle('selected', checkbox.checked);
}
window.updateRowStyle = function(checkbox){ paintRow(checkbox); updateToolbar(); };
window.updateToolbar = function(){
  var count = document.querySelectorAll('#mail-list input[name="keys"]:checked').length;
  var actionHeader = document.getElementById('action-header');
  var defaultHeader = document.getElementById('default-header');
  if(actionHeader && defaultHeader){
    actionHeader.classList.toggle('hidden', count === 0);
    defaultHeader.classList.toggle('hidden', count > 0);
    var sc = document.getElementById('selected-count');
    if(sc) sc.textContent = count;
  }
};

/* ---------- 星标（无刷新切换；键名从行 data-key 读取，绝不拼进 JS 字符串） ---------- */
window.setStarUI = function(btn, on){
  btn.classList.toggle('on', !!on);
  btn.innerHTML = on ? ICON_STAR_FILL : ICON_STAR;
  btn.setAttribute('title', on ? '取消星标' : '加星标');
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
};
window.toggleStar = function(btn){
  if(btn.disabled) return false;
  var row = btn.closest ? btn.closest('.email-row') : null;
  var key = row && row.dataset.key ? decodeURIComponent(row.dataset.key) : '';
  if(!key) return false;
  var on = btn.classList.contains('on');
  btn.disabled = true;
  fetch('/api/flag', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ key:key, star:!on }) })
    .then(function(r){ return r.json().catch(function(){ return null; }); })
    .then(function(d){
      if(d && d.ok){ setStarUI(btn, d.star); toast(d.star ? '已加星标' : '已取消星标', 'success'); syncStarBadge(d.starCount); }
      else toast((d && d.error) || '操作失败，请重试', 'error');
    })
    .catch(function(){ toast('网络错误，请稍后重试', 'error'); })
    .then(function(){ btn.disabled = false; });
  return false;
};
function syncStarBadge(n){
  var b = document.getElementById('nav-star-badge');
  if(!b) return;
  if(n > 0){ b.style.display = ''; b.textContent = n > 999 ? '999+' : n; }
  else b.style.display = 'none';
}

/* ---------- 密码可见切换 ---------- */
var ICON_EYE = '${'<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>'}';
var ICON_EYE_OFF = '${'<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>'}';
window.togglePw = function(btn){
  var wrap = btn.closest ? btn.closest('.pw-wrap') : null;
  var input = wrap ? wrap.querySelector('input') : null;
  if(!input) return;
  var show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = show ? ICON_EYE_OFF : ICON_EYE;
  btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  btn.style.color = show ? 'var(--brand-700)' : '';
};

/* ---------- 复制 ---------- */
window.copyText = function(text, msg){
  function done(){ toast(msg || '已复制到剪贴板', 'success'); }
  function fallback(){
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); done(); }catch(e){ toast('复制失败', 'error'); }
    ta.remove();
  }
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done, fallback); }
  else fallback();
};

/* ---------- 移动端侧栏 ---------- */
window.toggleMenu = function(){
  var sidebar = document.getElementById('sidebar');
  var backdrop = document.getElementById('mobile-backdrop');
  var closed = sidebar.classList.contains('-translate-x-full');
  if(closed){ sidebar.classList.remove('-translate-x-full'); backdrop.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
  else { sidebar.classList.add('-translate-x-full'); backdrop.classList.add('hidden'); document.body.style.overflow = ''; }
};

/* ---------- 邮件行点击（事件委托，防 XSS 注入） ----------
   键名绝不拼进 onclick 字符串（encodeURIComponent 不转义单引号），
   而是用 data-key + 委托。行内真正的控件（a/button/input/label）优先。 */
document.addEventListener('click', function(e){
  var t = e.target;
  if(!t || typeof t.closest !== 'function') return;
  var row = t.closest('.email-row');
  if(!row || !row.dataset.key) return;
  if(t.closest('a, button, input, label, select, textarea, iframe')) return;
  window.location.href = '/email/' + row.dataset.key;
});

/* ---------- 正文 iframe 高度自适应 ---------- */
var appliedHeight = -1, lastStep = 0, sameStep = 0;
window.addEventListener('resize', function(){ lastStep = 0; sameStep = 0; });
window.addEventListener('message', function(e){
  var d = e.data;
  if(!d || typeof d.__cfmailHeight !== 'number') return;
  var frame = document.getElementById('mail-frame');
  if(!frame || e.source !== frame.contentWindow) return;
  var h = Math.min(Math.max(Math.ceil(d.__cfmailHeight), 120), 20000);
  if(h === appliedHeight) return;
  var step = appliedHeight > 0 ? h - appliedHeight : 0;
  if(step > 0 && step <= 64 && step === lastStep){ if(++sameStep >= 3) return; }
  else sameStep = 0;
  lastStep = step; appliedHeight = h;
  frame.style.height = h + 'px';
});

/* ---------- 列表键盘快捷键 ---------- */
(function(){
  var list = document.getElementById('mail-list');
  if(!list) return;
  var idx = -1;
  function rows(){ return Array.prototype.slice.call(list.querySelectorAll('.email-row')); }
  function focus(i){
    var rs = rows();
    if(!rs.length) return;
    idx = Math.max(0, Math.min(i, rs.length - 1));
    rs.forEach(function(r){ r.classList.remove('kb-focus'); });
    var r = rs[idx];
    r.classList.add('kb-focus');
    r.scrollIntoView({ block:'nearest', behavior:'smooth' });
  }
  document.addEventListener('keydown', function(e){
    if(e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if(/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    var k = e.key;
    if(k === 'j' || k === 'ArrowDown'){ e.preventDefault(); focus(idx + 1); }
    else if(k === 'k' || k === 'ArrowUp'){ e.preventDefault(); focus(idx < 0 ? 0 : idx - 1); }
    else if(k === 'x'){
      var rs = rows();
      if(idx >= 0 && rs[idx]){ var cb = rs[idx].querySelector('input[name="keys"]'); if(cb){ cb.checked = !cb.checked; paintRow(cb); updateToolbar(); } }
    }
    else if(k === 'Enter'){
      var rs2 = rows();
      if(idx >= 0 && rs2[idx] && rs2[idx].dataset.key) window.location.href = '/email/' + rs2[idx].dataset.key;
    }
    else if(k === '/'){ var s = document.getElementById('list-search'); if(s){ e.preventDefault(); s.focus(); } }
  });
})();
})();
`;

// ---------- 全局布局 ----------
// activePage: inbox | starred | trash | settings
// opts: { unreadCount, starCount, trashCount }

const renderLayout = (content, activePage = 'inbox', latestTimestamp = 0, opts = {}) => {
    const num = v => { const n = Number(v) || 0; return n > 999 ? '999+' : String(n); };
    const badge = (n, hot, id) => n > 0
        ? `<span class="nbadge${hot ? ' hot' : ''}"${id ? ` id="${id}"` : ''}>${num(n)}</span>`
        : `<span class="nbadge" style="display:none"${id ? ` id="${id}"` : ''}>0</span>`;
    const unread = Number(opts.unreadCount) || 0;
    const starred = Number(opts.starCount) || 0;
    const trashed = Number(opts.trashCount) || 0;

    const navItem = (page, href, icon, label, badgeHtml, trashy) => `
        <a href="${href}" class="nav-item${activePage === page ? ' active' : ''}${trashy && activePage === page ? ' trashy' : ''}">
            ${icon}<span>${label}</span>${badgeHtml}
        </a>`;

    const logoSvg = `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" /></svg>`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>CF Mail · Cloudflare 邮箱</title>
    <link rel="manifest" href="/manifest.json">
    <meta name="theme-color" content="#4f46e5">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="apple-touch-icon" href="/logo.svg">
    <script>${THEME_BOOT_SCRIPT}</script>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>${THEME_CSS}</style>
    <script>window.CURRENT_PAGE_LATEST_TS = ${Number(latestTimestamp) || 0};</script>
</head>
<body class="app-shell">
    <div id="toast-wrap" aria-live="polite"></div>

    <div id="modal-backdrop" class="modal-backdrop">
        <div class="absolute inset-0" onclick="hideModal()"></div>
        <div class="modal-panel relative">
            <div id="modal-icon" class="modal-icon">${Icons.alert}</div>
            <h3 id="modal-title" class="text-lg font-bold text-center mb-2" style="color:var(--text-1)"></h3>
            <p id="modal-msg" class="text-sm text-center mb-6 leading-relaxed" style="color:var(--text-2)"></p>
            <div class="flex gap-3">
                <button onclick="hideModal()" class="btn btn-ghost flex-1" style="border:1px solid var(--border)">取消</button>
                <button id="modal-confirm-btn" onclick="onModalConfirm()" class="btn btn-primary flex-1">确定</button>
            </div>
        </div>
    </div>

    <div id="mobile-backdrop" onclick="toggleMenu()" class="fixed inset-0 z-40 hidden md:hidden" style="background:rgba(10,13,24,.5);backdrop-filter:blur(2px)"></div>

    <aside id="sidebar" class="sidebar fixed inset-y-0 left-0 transform -translate-x-full transition-transform duration-300 md:static md:translate-x-0" style="box-shadow:var(--shadow-lg)">
        <div class="brand">
            <div class="brand-logo">${logoSvg}</div>
            <div class="brand-name">CF Mail<small>Cloudflare Webmail</small></div>
            <button onclick="toggleMenu()" class="icon-btn md:hidden ml-auto" aria-label="关闭菜单">${Icons.x}</button>
        </div>
        <nav class="side-nav" aria-label="主导航">
            ${navItem('inbox', '/', Icons.inbox, '收件箱', badge(unread, true))}
            ${navItem('starred', '/starred', Icons.star, '已加星标', badge(starred, false, 'nav-star-badge'))}
            ${navItem('trash', '/trash', Icons.trash, '回收站', badge(trashed, false), true)}
            <div class="my-2" style="border-top:1px solid var(--border)"></div>
            ${navItem('settings', '/settings', Icons.gear, '设置', '')}
        </nav>
        <div class="side-foot safe-bottom">
            <button onclick="toggleTheme()" class="nav-item w-full text-left" aria-label="切换深色模式">
                <span id="theme-ic-light">${Icons.moon}</span><span id="theme-ic-dark" style="display:none">${Icons.sun}</span><span>深色模式</span>
            </button>
            <a href="/logout" class="nav-item" style="color:var(--danger)">${Icons.logout}<span>退出登录</span></a>
        </div>
    </aside>

    <main class="main">${content}</main>
    <script>${GLOBAL_SCRIPT}</script>
</body>
</html>`;
};

// ---------- 登录 / 初始化（共用同一套视觉） ----------

const renderAuthShell = (inner, { title, subtitle, siteKey }) => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>${title} · CF Mail</title>
    <link rel="manifest" href="/manifest.json">
    <meta name="theme-color" content="#4f46e5">
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <script>${THEME_BOOT_SCRIPT}</script>
    <script src="https://cdn.tailwindcss.com"></script>
    ${siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
    <style>${THEME_CSS}</style>
    <script>
    function armSubmit(btn, label){
        if(btn.disabled) return true;
        btn.disabled = true;
        btn.dataset.html = btn.innerHTML;
        btn.innerHTML = '<svg class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> ' + label;
        setTimeout(function(){ if(btn.disabled){ btn.disabled = false; btn.innerHTML = btn.dataset.html; } }, 6000);
        return true;
    }
    <\/script>
</head>
<body>
<div class="auth-bg">
    <div class="auth-side">
        <div class="auth-orb" style="width:420px;height:420px;background:#a78bfa;top:-120px;right:-120px"></div>
        <div class="auth-orb" style="width:340px;height:340px;background:#312e81;bottom:-100px;left:-80px"></div>
        <div class="relative z-10 flex items-center gap-3">
            <div class="brand-logo" style="width:2.8rem;height:2.8rem;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.25);box-shadow:none">
                <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" /></svg>
            </div>
            <div><div class="text-xl font-extrabold tracking-tight">CF Mail</div><div class="text-xs text-indigo-200 tracking-widest uppercase">Cloudflare Webmail</div></div>
        </div>
        <div class="relative z-10 max-w-md">
            <h2 class="text-3xl font-extrabold leading-snug tracking-tight mb-8">跑在 Cloudflare<br>边缘网络上的<br>私人邮箱。</h2>
            <div class="space-y-6">
                <div class="feat"><div class="feat-ic">${Icons.shield}</div><div><div class="font-semibold mb-1">零服务器 · 零数据库</div><div class="text-sm text-indigo-200 leading-relaxed">Email Routing 收信，原始邮件存入 R2，全部跑在免费额度内。</div></div></div>
                <div class="feat"><div class="feat-ic">${Icons.lock}</div><div><div class="font-semibold mb-1">纵深安全设计</div><div class="text-sm text-indigo-200 leading-relaxed">正文沙箱隔离渲染，加盐口令哈希，按 IP 限流防爆破。</div></div></div>
                <div class="feat"><div class="feat-ic">${Icons.translate}</div><div><div class="font-semibold mb-1">一键翻译 · 保留版式</div><div class="text-sm text-indigo-200 leading-relaxed">Workers AI 按原文版式就地翻译，表格图片位置一个不动。</div></div></div>
            </div>
        </div>
        <div class="relative z-10 text-xs text-indigo-300">Powered by Cloudflare Workers · R2 · Workers AI</div>
    </div>
    <div class="auth-form-wrap">
        <div class="auth-card fade-in">
            <div class="lg:hidden flex items-center gap-3 mb-8">
                <div class="brand-logo"><svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" /></svg></div>
                <div class="brand-name">CF Mail</div>
            </div>
            <h1 class="text-2xl font-extrabold tracking-tight mb-2" style="color:var(--text-1)">${title}</h1>
            <p class="text-sm mb-8" style="color:var(--text-2)">${subtitle}</p>
            ${inner}
            <p class="text-xs text-center mt-8" style="color:var(--text-3)">Powered by Cloudflare Workers</p>
        </div>
    </div>
</div>
<script>${GLOBAL_SCRIPT}</script>
</body>
</html>`;

const authField = (label, icon, inputHtml, hint) => `
    <div>
        <label class="field-label">${label}</label>
        <div class="relative">
            <div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none" style="color:var(--text-3)">${icon}</div>
            ${inputHtml}
        </div>
        ${hint ? `<p class="text-xs mt-1.5" style="color:var(--text-3)">${hint}</p>` : ''}
    </div>`;

const authInputCls = 'input pl-11 py-3';

const authPwField = (label, name, autocomplete, placeholder, extra) => `
    <div>
        <label class="field-label">${label}</label>
        <div class="relative pw-wrap">
            <div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none" style="color:var(--text-3)">${Icons.lock}</div>
            <input type="password" name="${name}" autocomplete="${autocomplete}" class="${authInputCls} !pr-11" placeholder="${placeholder}" required ${extra || ''}>
            <button type="button" onclick="togglePw(this)" class="absolute inset-y-0 right-0 pr-3.5 flex items-center transition-colors hover:opacity-80" style="color:var(--text-3)" aria-label="显示密码" tabindex="-1">${Icons.eye}</button>
        </div>
    </div>`;

const renderLogin = (error = "", siteKey = "") => {
    const alert = error
        ? `<div class="alert alert-error mb-6"><span class="flex-shrink-0 mt-0.5">${Icons.alert}</span><span>${escapeHtml(error)}</span></div>`
        : '';
    return renderAuthShell(`
        ${alert}
        <form method="POST" class="space-y-5" onsubmit="return armSubmit(document.getElementById('loginBtn'), '登录中…')">
            ${authField('用户名', Icons.user, `<input type="text" name="username" autocomplete="username" class="${authInputCls}" placeholder="请输入用户名" required autofocus>`)}
            ${authPwField('密码', 'password', 'current-password', '••••••••')}
            ${siteKey ? `<div class="flex justify-center pt-1"><div class="cf-turnstile" data-sitekey="${escapeAttr(siteKey)}" data-theme="auto"></div></div>` : ''}
            <button type="submit" id="loginBtn" class="btn btn-primary w-full py-3.5 text-base">登录</button>
        </form>`,
        { title: '欢迎回来', subtitle: '登录你的 Cloudflare 私人邮箱', siteKey });
};

const renderSetup = (error = "") => {
    const alert = error
        ? `<div class="alert alert-error mb-6"><span class="flex-shrink-0 mt-0.5">${Icons.alert}</span><span>${escapeHtml(error)}</span></div>`
        : `<div class="alert alert-info mb-6"><span class="flex-shrink-0 mt-0.5">${Icons.info}</span><span>首次部署需要创建一个管理员账号，之后用它登录即可管理邮箱。</span></div>`;
    return renderAuthShell(`
        ${alert}
        <form method="POST" action="/setup" class="space-y-5" onsubmit="return armSubmit(document.getElementById('setupBtn'), '创建中…')">
            ${authField('管理员用户名', Icons.user, `<input type="text" name="username" autocomplete="username" class="${authInputCls}" placeholder="请输入用户名" required autofocus>`)}
            ${authPwField('管理员密码', 'password', 'new-password', '至少 8 位', 'minlength="8"')}
            <p class="text-xs -mt-3" style="color:var(--text-3)">密码至少 8 位，请妥善保管</p>
            <button type="submit" id="setupBtn" class="btn btn-primary w-full py-3.5 text-base">完成设置并登录</button>
        </form>`,
        { title: '欢迎使用', subtitle: '只需一步，即可启用你的私人邮箱', siteKey: '' });
};

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

// ---------- 设置 ----------
// v2.3：区块结构统一为 section.panel + 内部独立表单 + panel-actions 操作行；
// 统计卡片可点击跳转；新增「显示与阅读」区块。
// opts = { error, notice, stats: { total, unread, starred, trash } }

function renderSettings(settings, turnstile, forward, opts) {
    const o = opts || {};
    const stats = o.stats || {};
    const secretMask = maskSecret(settings.turnstileSecretKey);
    const secretPlaceholder = secretMask
        ? '已配置：' + secretMask + '（留空则保持不变）'
        : '0x4AAAAAAAxxxxxxxxxxxxxxxx';

    let alertHtml = '';
    if (o.error) {
        alertHtml = '<div class="alert alert-error mb-6"><span class="flex-shrink-0 mt-0.5">' + Icons.alert + '</span><span>' + escapeHtml(o.error) + '</span></div>';
    } else if (o.notice) {
        alertHtml = '<div class="alert alert-ok mb-6"><span class="flex-shrink-0 mt-0.5">' + Icons.check + '</span><span>' + escapeHtml(o.notice) + '</span></div>';
    }

    const turnstileState = turnstile.enabled
        ? '<span class="chip chip-green">已启用</span><span class="text-xs" style="color:var(--text-2)">登录页会显示人机验证</span>'
        : '<span class="chip chip-gray">未启用</span><span class="text-xs" style="color:var(--text-2)">登录页会跳过人机验证</span>';

    const pwInput = (name, autocomplete, extra) => `
        <div class="relative pw-wrap">
            <input type="password" name="${name}" autocomplete="${autocomplete}" required ${extra || ''} class="input !pr-11">
            <button type="button" onclick="togglePw(this)" class="absolute inset-y-0 right-0 pr-3.5 flex items-center" style="color:var(--text-3)" aria-label="显示密码" tabindex="-1">${Icons.eye}</button>
        </div>`;
    const statCard = (href, icon, bg, color, num, label) => `
        <a class="stat" href="${href}">
            <div class="stat-ic" style="background:${bg};color:${color}">${icon}</div>
            <div><div class="stat-num">${num}</div><div class="stat-lbl">${label}</div></div>
        </a>`;

    // 每页数量：只在设置里改默认值，列表页 ?limit= 显式指定时优先
    const pageSize = parseInt(settings.pageSize, 10) || 50;
    const pageOpt = (v) => `<option value="${v}"${pageSize === v ? ' selected' : ''}>${v} 封 / 页</option>`;
    const autoMark = settings.autoMarkRead !== false;

    return `
    <div class="view fade-in">
        <div class="view-head">
            <a href="/" class="icon-btn" title="返回收件箱">${Icons.back}</a>
            <h1 class="view-title ml-1">设置</h1>
        </div>
        <div class="view-body">
            <div class="p-4 sm:p-7 max-w-3xl mx-auto safe-bottom">
                ${alertHtml}

                <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                    ${statCard('/', Icons.inbox, 'var(--brand-50)', 'var(--brand-700)', stats.total || 0, '收件箱邮件')}
                    ${statCard('/?unread=1', Icons.unread, 'var(--info-bg)', 'var(--info-text)', stats.unread || 0, '未读')}
                    ${statCard('/starred', Icons.star, 'var(--warning-bg)', 'var(--warning)', stats.starred || 0, '已加星标')}
                    ${statCard('/trash', Icons.trash, 'var(--danger-bg)', 'var(--danger)', stats.trash || 0, '回收站')}
                </div>

                <p class="panel-desc mb-6">配置保存在你的 R2 存储桶中，部署后无需再打开 Cloudflare 控制台。这里的配置<b style="color:var(--text-1)">优先于</b> Dashboard 上配置的同名环境变量。点上面的统计卡片可直接跳到对应视图。</p>

                <div class="space-y-5">
                    <section class="panel">
                        <h2 class="panel-title"><span style="color:var(--brand-700)">${Icons.send}</span>邮件转发${sourceBadge(forward.source)}</h2>
                        <p class="panel-desc mt-1 mb-4">邮件存入 R2 成功后，自动转发一份到这个邮箱。留空表示不转发。</p>
                        <form method="POST" action="/settings">
                            <input type="email" name="forward_email" autocomplete="off" value="${escapeAttr(settings.forwardEmail || '')}" placeholder="you@example.com" class="input">
                            <div class="panel-actions">
                                <button type="submit" class="btn btn-primary">保存转发设置</button>
                            </div>
                        </form>
                    </section>

                    <section class="panel">
                        <div class="flex items-center justify-between gap-3 mb-1 flex-wrap">
                            <h2 class="panel-title"><span style="color:var(--brand-700)">${Icons.shield}</span>人机验证 · Cloudflare Turnstile</h2>
                            ${sourceBadge(turnstile.source)}
                        </div>
                        <div class="flex items-center gap-2 my-3 flex-wrap">${turnstileState}</div>
                        <p class="panel-desc mb-4">两个 Key 必须<b style="color:var(--text-1)">成对填写</b>；只填一个不会生效，也不会把你自己锁在门外。Secret Key 只保存在 R2，永不回显。</p>
                        <form method="POST" action="/settings">
                            <label class="field-label">Site Key</label>
                            <input type="text" name="turnstile_site_key" autocomplete="off" value="${escapeAttr(settings.turnstileSiteKey || '')}" placeholder="0x4AAAAAAAxxxxxxxxxxxxxxxx" class="input mb-4">
                            <label class="field-label">Secret Key</label>
                            <input type="password" name="turnstile_secret_key" autocomplete="new-password" value="" placeholder="${escapeAttr(secretPlaceholder)}" class="input">
                            <p class="text-xs mt-2" style="color:var(--text-3)">留空表示保持原值不变。</p>
                            <div class="panel-actions">
                                <button type="submit" class="btn btn-primary">保存验证设置</button>
                                <span class="spacer"></span>
                                <button type="submit" formaction="/settings/clear-turnstile" onclick="return askClear(this)" class="btn btn-danger-soft">清空密钥</button>
                            </div>
                        </form>
                    </section>

                    <section class="panel">
                        <h2 class="panel-title"><span style="color:var(--brand-700)">${Icons.eye}</span>显示与阅读</h2>
                        <p class="panel-desc mt-1 mb-2">控制列表一次展示多少邮件，以及打开邮件时的已读行为。</p>
                        <form method="POST" action="/settings">
                            <label class="field-label">每页显示数量</label>
                            <select name="page_size" class="input mb-2">
                                ${pageOpt(25)}${pageOpt(50)}${pageOpt(100)}${pageOpt(200)}
                            </select>
                            <p class="text-xs mb-1" style="color:var(--text-3)">列表页用 <span class="kbd">?limit=</span> 显式指定时优先于这里。</p>
                            <div class="switch-row">
                                <div>
                                    <div class="font-semibold text-sm" style="color:var(--text-1)">打开邮件时自动标记已读</div>
                                    <div class="text-xs mt-0.5" style="color:var(--text-3)">关闭后，未读邮件需要手动标记，已读计数不再自动变化</div>
                                </div>
                                <label class="switch">
                                    <input type="checkbox" name="auto_mark_read" value="1"${autoMark ? ' checked' : ''}>
                                    <span class="tr"></span><span class="th"></span>
                                </label>
                            </div>
                            <div class="panel-actions">
                                <button type="submit" class="btn btn-primary">保存显示设置</button>
                            </div>
                        </form>
                    </section>

                    <section class="panel">
                        <h2 class="panel-title"><span style="color:var(--brand-700)">${Icons.key}</span>修改密码</h2>
                        <p class="panel-desc mt-1 mb-4">更新后<b style="color:var(--text-1)">其它设备上的登录会立即失效</b>，当前设备不受影响，无需重新登录。</p>
                        <form method="POST" action="/settings/password">
                            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <div><label class="field-label">当前密码</label>${pwInput('current_password', 'current-password')}</div>
                                <div><label class="field-label">新密码</label>${pwInput('new_password', 'new-password', 'minlength="8" placeholder="至少 8 位"')}</div>
                                <div><label class="field-label">确认新密码</label>${pwInput('confirm_password', 'new-password', 'minlength="8"')}</div>
                            </div>
                            <div class="panel-actions">
                                <button type="submit" class="btn btn-dark">更新密码</button>
                            </div>
                        </form>
                    </section>

                    <section class="panel" style="border-color:var(--danger-border);background:color-mix(in srgb, var(--danger-bg) 45%, var(--surface))">
                        <h2 class="panel-title" style="color:var(--danger)"><span>${Icons.alert}</span>安全</h2>
                        <p class="panel-desc mt-1 mb-4">怀疑账号在别处被登录？一键让<b style="color:var(--text-1)">其它所有设备</b>立即下线，当前设备不受影响。</p>
                        <form method="POST" action="/settings/logout-others" onsubmit="return confirm('确定要退出其他所有设备上的登录吗？')">
                            <button type="submit" class="btn btn-danger-soft">退出其他设备</button>
                        </form>
                    </section>

                    <div class="panel !p-4">
                        <div class="flex items-start gap-3">
                            <span class="flex-shrink-0 mt-0.5" style="color:var(--text-3)">${Icons.info}</span>
                            <div class="text-xs leading-relaxed" style="color:var(--text-2)">
                                <p class="font-bold mb-1" style="color:var(--text-1)">使用提示</p>
                                <p><span class="kbd">J</span> / <span class="kbd">K</span> 在列表中上下移动　<span class="kbd">X</span> 勾选　<span class="kbd">↵</span> 打开邮件　<span class="kbd">/</span> 聚焦搜索　<span class="kbd">Esc</span> 关闭弹窗</p>
                                <p class="mt-2">Turnstile 的 Site Key 是服务端渲染进登录页的，保存后<b>下次打开登录页</b>生效。</p>
                            </div>
                        </div>
                    </div>
                </div>
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
//
// 返回 { html, removed } —— removed 表示这份正文里**确实**含有可执行内容。
// 详情页靠它决定要不要给用户一行说明：99% 的正常邮件这里是 false，页面上不会多出任何文字。
// 与其在每封邮件下面常驻一句「已剥离脚本」（用户看一百遍也毫无信息量），
// 不如只在真的剥过东西时才解释一句「这封邮件为什么看着不太一样」。
function stripActiveContent(html) {
    const raw = String(html || '');
    const cleaned = raw
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<script\b[^>]*\/?>/gi, '')
        .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
        .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
        .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
        .replace(/(href|src)\s*=\s*(["'])\s*javascript:/gi, '$1=$2blocked:');
    return { html: cleaned, removed: cleaned !== raw };
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

// 正文的「内容部分」。原文与译文都从这里出发，保证两边外壳、字体、行高完全一致。
function frameInnerHtml(email) {
    if (email.html) return stripActiveContent(email.html).html;
    if (email.text && email.text.trim()) return '<pre class="plain">' + escapeHtml(email.text) + '</pre>';
    return '<p style="color:#6b7280">（无正文内容，请查看附件）</p>';
}

// 沙箱文档外壳。译文同样走这里 —— 译文是「就地替换文字」后的 HTML，
// 因此渲染出来的版式与原文一模一样，切回原文时显示位置也不会跳。
function frameShell(inner) {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<meta name="referrer" content="no-referrer">'
        + '<style>' + FRAME_CSS + '@media print{#mail-root{padding:0}body{font-size:13px;color:#000}a{color:#000;text-decoration:none}}' + '</style></head><body>'
        + '<div id="mail-root">' + inner + '</div>'
        + '<script>' + FRAME_HEIGHT_SCRIPT + '<\/script>'
        + '<script>try{if(/(?:^|&)print=1(?:&|$)/.test(location.search.slice(1))){window.addEventListener("load",function(){setTimeout(function(){window.print()},450)})}}catch(e){}<\/script>'
        + '</body></html>';
}

function buildFrameDocument(email) {
    return frameShell(frameInnerHtml(email));
}

// 正文沙箱文档的统一响应头。原文 / 译文共用，避免两条分支的头不一致。
function frameResponse(body) {
    return new Response(body, {
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

// 正文是否值得翻译（决定要不要给用户提示「本来就是中文」等）。
function emailSourceText(email) {
    const text = String(email.text || '').trim();
    if (text) return text;
    return email.html ? htmlToText(email.html) : '';
}

// 把一封邮件的正文翻成「保留版式的译文 HTML 文档」。
async function buildTranslatedFrame(env, email, source) {
    const result = await translateHtmlPreservingLayout(env, frameInnerHtml(email), source);
    return {
        html: frameShell(result.html),
        segments: result.segments,
        skipped: result.skipped,
        truncated: result.truncated
    };
}

// ---------- 邮件详情渲染 ----------
// 收件箱与回收站两条分支共用这一份，避免改一处漏一处。

// ---------- 邮件详情 ----------
// extra = { prevKey, nextKey, isStarred, isRead }

function renderEmailDetail(email, key, isTrash, uploaded, extra) {
    const ex = extra || {};
    const fromRaw = String(email.headers['from'] || '');
    const senderName = (fromRaw.split('<')[0] || '').trim().replace(/"/g, '') || '未知发件人';
    const senderEmail = (fromRaw.match(/<([^>]+)>/) || [])[1] || fromRaw.replace(/[<>]/g, '').trim();
    const initial = escapeHtml((senderName[0] || '?').toUpperCase());
    const avatarColor = getAvatarColor(senderName);
    const subject = email.headers['subject'] || '(无主题)';
    const uploadedTs = new Date(uploaded).getTime();
    const uploadedIso = Number.isFinite(uploadedTs) ? new Date(uploadedTs).toISOString() : '';
    const encodedKey = encodeURIComponent(key);
    const isStarred = !!ex.isStarred;
    const isRead = ex.isRead !== false;

    const strippedNotice = (email.html && stripActiveContent(email.html).removed)
        ? `<div class="alert alert-info mt-4"><span class="flex-shrink-0 mt-0.5">${Icons.shield}</span><span>这封邮件含有脚本或内联事件，已为安全起见移除；正文其余内容不受影响。</span></div>`
        : '';

    let attachmentsHtml = '';
    if (email.attachments.length > 0) {
        attachmentsHtml = `
        <div class="panel !p-4 sm:!p-5 mb-6">
            <div class="flex items-center text-sm font-bold mb-4" style="color:var(--text-1)"><span style="color:var(--brand-700)">${Icons.attach}</span><span class="ml-2">附件</span><span class="chip chip-gray ml-2">${email.attachments.length}</span></div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                ${email.attachments.map((att, index) => `
                <div class="att">
                    <div class="att-ic">${Icons.file}</div>
                    <div class="min-w-0 flex-1">
                        <p class="text-sm font-semibold truncate" style="color:var(--text-1)" title="${escapeAttr(att.filename)}">${escapeHtml(att.filename)}</p>
                        <p class="text-xs" style="color:var(--text-3)">${escapeHtml(att.sizeStr)}</p>
                    </div>
                    <a href="/attachment/${encodedKey}/${index}" download="${escapeAttr(att.filename)}" class="icon-btn" title="下载附件">${Icons.download}</a>
                </div>`).join('')}
            </div>
        </div>`;
    }

    // （已移除「查看原始头部」入口）

    const navBtn = (targetKey, icon, label, disabled) => disabled
        ? `<span class="icon-btn" style="opacity:.3;cursor:not-allowed" aria-disabled="true" title="${label}">${icon}</span>`
        : `<a href="/email/${encodeURIComponent(targetKey)}" class="icon-btn" title="${label}">${icon}</a>`;

    const starBtn = isTrash ? '' : `
        <button id="detail-star-btn" onclick="toggleStarDetail()" class="star-btn !w-10 !h-10${isStarred ? ' on' : ''}"
            title="${isStarred ? '取消星标' : '加星标'}" aria-pressed="${isStarred ? 'true' : 'false'}">
            ${isStarred ? Icons.starFill : Icons.star}
        </button>`;

    const readBtn = isTrash ? '' : `
        <button id="detail-read-btn" onclick="toggleReadDetail()" class="icon-btn" title="${isRead ? '标记为未读' : '标记为已读'}">
            ${isRead ? Icons.unread : Icons.read}
        </button>`;

    const toolbar = `
        <div class="flex items-center gap-0.5 sm:gap-1">
            ${navBtn(ex.prevKey, Icons.chevL, '上一封（更新的）', !ex.prevKey)}
            ${navBtn(ex.nextKey, Icons.chevR, '下一封（更早的）', !ex.nextKey)}
            <span class="w-px h-6 mx-1 hidden sm:block" style="background:var(--border)"></span>
            ${starBtn}
            ${readBtn}
            <button id="translate-btn" onclick="translateMail()" class="btn btn-soft !py-2 !px-3 !text-[13px]" title="按原文版式就地翻译成中文">${Icons.translate}<span class="hidden sm:inline">翻译</span></button>
            <a href="/raw/${encodedKey}" download class="icon-btn" title="下载原始邮件（.eml）">${Icons.download}</a>
            <button onclick="printMail()" class="icon-btn" title="打印邮件正文">${Icons.print}</button>
            ${isTrash ? `
            <form method="POST" action="/restore" onsubmit="return confirmSingle(event, '确定要恢复这封邮件吗？')" class="contents">
                <input type="hidden" name="key" value="${escapeAttr(key)}">
                <button class="icon-btn" style="color:var(--success)" title="恢复到收件箱">${Icons.refresh}</button>
            </form>
            <form method="POST" action="/purge" onsubmit="return confirmSingle(event, '彻底删除后将无法恢复，确定吗？', true)" class="contents">
                <input type="hidden" name="key" value="${escapeAttr(key)}">
                <button class="icon-btn danger" title="彻底删除">${Icons.trash}</button>
            </form>` : `
            <form method="POST" action="/delete" onsubmit="return confirmSingle(event, '确定要将这封邮件移入回收站吗？')" class="contents">
                <input type="hidden" name="key" value="${escapeAttr(key)}">
                <button class="icon-btn danger" title="移入回收站">${Icons.trash}</button>
            </form>`}
        </div>`;

    return `
    <div class="view fade-in">
        <div class="view-head">
            <a href="${isTrash ? '/trash' : '/'}" class="icon-btn" title="返回列表">${Icons.back}</a>
            <div class="flex-1 min-w-0"></div>
            ${toolbar}
        </div>
        <div class="view-body">
            <div class="px-4 sm:px-8 py-6 sm:py-8 max-w-4xl mx-auto safe-bottom">
                <h1 class="text-xl sm:text-[1.7rem] font-extrabold leading-snug tracking-tight mb-5 break-words select-text" style="color:var(--text-1)">${escapeHtml(subject)}</h1>

                <div class="panel !p-4 sm:!p-5 mb-6">
                    <div class="flex items-center gap-3 sm:gap-4">
                        <div class="avatar w-11 h-11 sm:w-12 sm:h-12 text-lg ${avatarColor}">${initial}</div>
                        <div class="min-w-0 flex-1">
                            <div class="font-bold text-[15px] truncate select-text" style="color:var(--text-1)">${escapeHtml(senderName)}</div>
                            <button data-email="${escapeAttr(senderEmail)}" onclick="copyText(this.dataset.email, '发件人地址已复制')" class="text-[13px] truncate select-text flex items-center gap-1.5 min-w-0 max-w-full hover:underline" style="color:var(--text-2)" title="点击复制地址">
                                <span class="truncate">&lt;${escapeHtml(senderEmail)}&gt;</span><span class="flex-shrink-0" style="color:var(--text-3)">${Icons.copy}</span>
                            </button>
                        </div>
                        <div class="text-xs whitespace-nowrap flex-shrink-0" style="color:var(--text-3)">
                            <time data-ts="${Number.isFinite(uploadedTs) ? uploadedTs : 0}" data-fmt="full" datetime="${escapeAttr(uploadedIso)}"></time>
                        </div>
                    </div>
                    <div class="flex flex-wrap gap-2 mt-3.5">
                        ${isStarred ? '<span class="chip chip-amber">★ 已加星标</span>' : ''}
                        ${isTrash ? '<span class="chip chip-gray">回收站</span>' : (isRead ? '<span class="chip chip-blue">已读</span>' : '<span class="chip chip-green">未读</span>')}
                        ${email.attachments.length ? `<span class="chip chip-gray">${Icons.attach} ${email.attachments.length} 个附件</span>` : ''}
                    </div>
                </div>

                ${attachmentsHtml}

                <div id="translate-status" class="hidden"></div>
                <div id="mail-body">
                    <iframe id="mail-frame" src="/frame/${encodedKey}" title="邮件正文" class="w-full border-0 block" style="height:320px;background:var(--surface);border-radius:14px" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>
                    ${strippedNotice}
                </div>
            </div>
        </div>
    </div>
    <script>
    (function () {
        var KEY = ${jsonForScript(key)};
        var ORIGINAL_SRC = '/frame/' + encodeURIComponent(KEY);
        var TRANSLATED_SRC = ORIGINAL_SRC + '?t=1';
        var translated = false;
        var busy = false;
        function el(id) { return document.getElementById(id); }

        function setStatus(text, kind) {
            var box = el('translate-status');
            if (!box) return;
            if (!text) { box.className = 'hidden'; box.textContent = ''; return; }
            box.className = 'alert mb-5 ' + (kind === 'error' ? 'alert-error' : 'alert-info');
            box.textContent = text;
        }
        function setLabel(btn, text) {
            var label = btn ? btn.querySelector('span') : null;
            if (label) label.textContent = text;
        }

        // 原文与译文共用同一个 iframe 元素，切换只改 src —— 元素位置不动，只换内容。
        window.translateMail = function () {
            var btn = el('translate-btn');
            var frame = el('mail-frame');
            if (busy) return;
            if (!btn || btn.disabled) return;
            if (translated) {
                translated = false;
                if (frame) frame.src = ORIGINAL_SRC;
                setLabel(btn, '翻译');
                setStatus('', 'info');
                return;
            }
            btn.disabled = true;
            busy = true;
            btn.classList.add('opacity-60');
            setLabel(btn, '翻译中…');
            setStatus('正在按原文版式就地翻译，长邮件可能需要十几秒…', 'info');
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
                    setLabel(btn, '翻译');
                    return;
                }
                translated = true;
                if (frame) frame.src = TRANSLATED_SRC;
                var note = '已按原文版式就地翻译 · 源语言：' + data.sourceLang;
                if (data.truncated) note += ' · 另有 ' + data.skipped + ' 个片段保留原文（超出预算或未翻出）';
                setStatus(note, 'info');
                setLabel(btn, '显示原文');
            }).catch(function () {
                setStatus('网络错误，请稍后重试', 'error');
                setLabel(btn, '翻译');
            }).then(function () {
                btn.disabled = false;
                busy = false;
                btn.classList.remove('opacity-60');
            });
        };

        // 详情页星标切换（无刷新）
        window.toggleStarDetail = function () {
            var btn = el('detail-star-btn');
            if (!btn || btn.disabled) return;
            var on = btn.classList.contains('on');
            btn.disabled = true;
            fetch('/api/flag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY, star: !on }) })
                .then(function (r) { return r.json().catch(function () { return null; }); })
                .then(function (d) {
                    if (d && d.ok) { setStarUI(btn, d.star); toast(d.star ? '已加星标' : '已取消星标', 'success'); }
                    else toast((d && d.error) || '操作失败', 'error');
                })
                .catch(function () { toast('网络错误', 'error'); })
                .then(function () { btn.disabled = false; });
        };

        // 详情页已读 / 未读切换（无刷新）
        var detailRead = ${isRead ? 'true' : 'false'};
        window.toggleReadDetail = function () {
            var btn = el('detail-read-btn');
            if (!btn || btn.disabled) return;
            btn.disabled = true;
            fetch('/api/flag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY, read: !detailRead }) })
                .then(function (r) { return r.json().catch(function () { return null; }); })
                .then(function (d) {
                    if (d && d.ok) {
                        detailRead = d.read;
                        btn.title = detailRead ? '标记为未读' : '标记为已读';
                        btn.innerHTML = detailRead ? ${jsonForScript(Icons.unread)} : ${jsonForScript(Icons.read)};
                        toast(detailRead ? '已标记为已读' : '已标记为未读', 'success');
                    } else toast((d && d.error) || '操作失败', 'error');
                })
                .catch(function () { toast('网络错误', 'error'); })
                .then(function () { btn.disabled = false; });
        };

        // 打印：在新标签页打开纯净正文文档并自动调起打印
        window.printMail = function () {
            window.open(ORIGINAL_SRC + (ORIGINAL_SRC.indexOf('?') >= 0 ? '&' : '?') + 'print=1', '_blank');
        };
    })();
    <\/script>`;
}

// ---------- 邮件列表页 ----------
// p = {
//   mode: 'inbox' | 'starred' | 'trash',
//   title, countLine, query, searchAction,
//   rows: [{ fullKey, dataKey, senderName, subject, ts, iso, isRead, isStarred, avatarColor, initial }],
//   empty: { icon, title, desc },
//   hasMore, nextHref, remaining,
//   showMarkAllRead
// }

function renderMailListPage(p) {
    const isTrash = p.mode === 'trash';
    const isStarred = p.mode === 'starred';

    const batchButtons = isTrash ? `
        <button type="button" onclick="confirmBatch('restore')" class="btn btn-success-soft !py-2 !px-3.5 !text-[13px]">${Icons.refresh}<span class="hidden sm:inline">恢复</span></button>
        <button type="button" onclick="confirmBatch('purge')" class="btn btn-danger-soft !py-2 !px-3.5 !text-[13px]">${Icons.trash}<span class="hidden sm:inline">彻底删除</span></button>`
    : isStarred ? `
        <button type="button" onclick="confirmBatch('mark_read')" class="icon-btn" title="标记为已读">${Icons.read}</button>
        <button type="button" onclick="confirmBatch('mark_unread')" class="icon-btn" title="标记为未读">${Icons.unread}</button>
        <button type="button" onclick="confirmBatch('unstar')" class="btn btn-soft !py-2 !px-3.5 !text-[13px]">${Icons.star}<span class="hidden sm:inline">取消星标</span></button>
        <button type="button" onclick="confirmBatch('delete')" class="icon-btn danger" title="移入回收站">${Icons.trash}</button>`
    : `
        <button type="button" onclick="confirmBatch('mark_read')" class="icon-btn" title="标记为已读">${Icons.read}</button>
        <button type="button" onclick="confirmBatch('mark_unread')" class="icon-btn" title="标记为未读">${Icons.unread}</button>
        <button type="button" onclick="confirmBatch('star')" class="icon-btn" title="加星标">${Icons.star}</button>
        <button type="button" onclick="confirmBatch('delete')" class="icon-btn danger" title="移入回收站">${Icons.trash}</button>`;

    const rowsHtml = p.rows.map(r => {
        const starBtn = isTrash ? '' : `
            <button class="star-btn${r.isStarred ? ' on' : ''}" onclick="return toggleStar(this)"
                title="${r.isStarred ? '取消星标' : '加星标'}" aria-pressed="${r.isStarred ? 'true' : 'false'}" aria-label="星标">
                ${r.isStarred ? Icons.starFill : Icons.star}
            </button>`;
        return `
        <div class="email-row${r.isRead ? '' : ' unread'}" data-key="${r.dataKeyAttr}">
            <div class="flex items-center gap-2.5 sm:gap-3.5 px-3 sm:px-5 py-3 sm:py-3.5">
                <label class="cbx flex-shrink-0" aria-label="选择">
                    <input type="checkbox" name="keys" value="${r.fullKeyAttr}" onchange="updateRowStyle(this)">
                    <span class="box"><svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></span>
                </label>
                ${starBtn}
                <div class="avatar w-10 h-10 text-[15px] ${r.avatarColor}">${r.initial}</div>
                <div class="min-w-0 flex-1">
                    <div class="flex items-baseline justify-between gap-3">
                        <p class="text-[15px] truncate ${r.isRead ? '' : 'font-bold'}" style="color:var(--text-1)">${r.isRead || isTrash ? '' : '<span class="unread-dot"></span>'}${r.senderName}</p>
                        <time class="text-xs flex-shrink-0" style="color:var(--text-3)" data-ts="${r.ts}" datetime="${r.iso}"></time>
                    </div>
                    <p class="text-[13.5px] truncate mt-0.5 ${r.isRead ? '' : 'font-semibold'}" style="color:${r.isRead ? 'var(--text-2)' : 'var(--text-1)'}">${r.subject}</p>
                </div>
            </div>
        </div>`;
    }).join('');

    const emptyHtml = p.rows.length === 0 ? `
        <div class="empty">
            <div class="empty-icon">${p.empty.icon}</div>
            <h3>${p.empty.title}</h3>
            <p>${p.empty.desc}</p>
        </div>` : '';

    const footerHtml = p.hasMore ? `
        <div class="px-4 py-6 text-center">
            <a href="${p.nextHrefAttr}" class="btn btn-outline">加载更多<span class="chip chip-gray ml-1">还有 ${p.remaining} 封</span></a>
        </div>` : (p.rows.length > 0 ? `
        <div class="px-4 py-6 text-center text-xs" style="color:var(--text-3)">— 已经到底了 —</div>` : '');

    const markAllRead = (!isTrash && !isStarred && p.showMarkAllRead) ? `
        <form method="POST" action="/mark-all-read" onsubmit="return confirmSingle(event, '将收件箱全部邮件标记为已读？')" class="flex-shrink-0">
            <input type="hidden" name="next" value="/">
            <button class="icon-btn" title="全部标记为已读">${Icons.checkAll}</button>
        </form>` : '';

    const unreadFilter = (!isTrash) ? `
        <a href="${p.filterToggleHref}" class="icon-btn${p.unreadOnly ? ' on' : ''}" title="${p.unreadOnly ? '显示全部邮件' : '只看未读邮件'}">${Icons.unread}</a>` : '';

    const emptyTrash = (isTrash && p.showEmptyTrash) ? `
        <form method="POST" action="/purge-all" onsubmit="return confirmSingle(event, '确定要清空回收站吗？所有邮件将被彻底删除，此操作不可恢复！', true)" class="flex-shrink-0">
            <button class="icon-btn danger" title="清空回收站">${Icons.trash}</button>
        </form>` : '';

    return `
    <div class="view fade-in">
        <div class="view-head">
            <button onclick="toggleMenu()" class="icon-btn md:hidden" aria-label="打开菜单">${Icons.menu}</button>
            <label class="cbx flex-shrink-0 ml-1" title="全选" aria-label="全选">
                <input type="checkbox" onclick="toggleAll(this)">
                <span class="box"><svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></span>
            </label>
            <div id="default-header" class="flex items-center justify-between flex-1 min-w-0 ml-1">
                <div class="min-w-0">
                    <h1 class="view-title truncate">${p.title}</h1>
                </div>
                <div class="flex items-center gap-0.5 flex-shrink-0">
                    ${unreadFilter}
                    ${markAllRead}
                    ${emptyTrash}
                    <button onclick="window.location.reload()" class="icon-btn" title="刷新">${Icons.refresh}</button>
                    <a href="/settings" class="icon-btn" title="设置">${Icons.gear}</a>
                </div>
            </div>
            <div id="action-header" class="hidden flex-1 items-center justify-between min-w-0 ml-1">
                <span class="text-sm font-medium whitespace-nowrap mr-2" style="color:var(--text-2)">已选 <span id="selected-count" class="font-extrabold" style="color:var(--brand-700)">0</span></span>
                <div class="flex items-center gap-1">${batchButtons}</div>
            </div>
        </div>

        <form method="GET" action="${p.searchAction}" class="flex items-center gap-2 px-3 sm:px-5 py-2.5 flex-shrink-0" style="border-bottom:1px solid var(--border);background:var(--surface)">
            ${p.unreadOnly ? '<input type="hidden" name="unread" value="1">' : ''}
            <div class="relative flex-1 min-w-0">
                <span class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none" style="color:var(--text-3)">${Icons.search}</span>
                <input id="list-search" type="search" name="q" value="${p.queryAttr}" autocomplete="off" placeholder="搜索主题或发件人…  ( 按 / 快速聚焦 )"
                    class="input !py-2.5 !pl-10 !rounded-xl !text-[13.5px]">
            </div>
            <button type="submit" class="btn btn-primary !py-2.5">搜索</button>
            ${p.query ? `<a href="${p.searchAction}" class="btn btn-ghost !py-2.5">清除</a>` : ''}
        </form>

        <div class="view-body">
            <form id="batch-form" method="POST" action="/batch-action">
                <input type="hidden" name="next" value="${p.nextValue}">
                <input type="hidden" name="q" value="${p.queryAttr}">
                <input type="hidden" name="limit" value="${p.pageSizeAttr}">
                <div class="px-4 sm:px-5 py-2 flex items-center justify-between gap-3 flex-shrink-0" style="border-bottom:1px solid var(--border)">
                    <span class="text-xs" style="color:var(--text-3)">${p.countLine}</span>
                    <span class="text-xs hidden lg:flex items-center gap-1.5" style="color:var(--text-3)">
                        <span class="kbd">J</span><span class="kbd">K</span> 移动
                        <span class="kbd ml-1">X</span> 选择
                        <span class="kbd ml-1">↵</span> 打开
                    </span>
                </div>
                <div id="mail-list">${rowsHtml}</div>
                ${emptyHtml}
                ${footerHtml}
                <div class="safe-bottom"></div>
            </form>
        </div>
    </div>`;
}

// ---------- 邮箱计数缓存 ----------
// _sys/counts.json: { total, unread, starred, trash }
// 目的：侧栏徽标、设置页统计不再每次全量 list() R2（翻到底最多 20 页，很贵），
// 读一次小 JSON 即可。所有写操作都增量维护；列表页是权威数据源，
// 每次渲染顺手用真实值校准缓存，兜住一切漂移。
const COUNTS_FILE = SYS_PREFIX + 'counts.json';
async function getCounts(env) {
    try {
        const obj = await env.MAIL_BUCKET.get(COUNTS_FILE);
        if (obj) {
            const c = await obj.json();
            if (c && typeof c.total === 'number') return c;
        }
    } catch (e) {}
    return null;
}
async function putCounts(env, c) {
    try {
        await env.MAIL_BUCKET.put(COUNTS_FILE, JSON.stringify(c), {
            httpMetadata: { contentType: 'application/json' }
        });
    } catch (e) {}
}
async function refreshCounts(env) {
    const c = { total: 0, unread: 0, starred: 0, trash: 0 };
    try {
        for (const o of await listAllObjects(env)) {
            if (o.key.startsWith(TRASH_PREFIX)) { c.trash++; continue; }
            if (!isMailKey(o.key)) continue;
            c.total++;
            const md = o.customMetadata || {};
            if (md.isRead !== 'true') c.unread++;
            if (md.isStarred === 'true') c.starred++;
        }
    } catch (e) {}
    await putCounts(env, c);
    return c;
}
async function countsOrRefresh(env) {
    return (await getCounts(env)) || (await refreshCounts(env));
}
// 增量更新计数并钳住不小于 0；缓存缺失时先全量重建再增量。
async function bumpCounts(env, d) {
    const c = (await getCounts(env)) || (await refreshCounts(env));
    let touched = false;
    for (const k of ['total', 'unread', 'starred', 'trash']) {
        if (d[k]) { c[k] = Math.max(0, c[k] + d[k]); touched = true; }
    }
    if (touched) await putCounts(env, c);
    return c;
}
// 批量并发：R2 子请求并行能力很强，25 路并发；
// Workers 单次调用子请求上限约 1000，超大批量按 chunk 切分兜底。
// （顺序 for+await 在批量删 50 封时是 150 次串行 R2 调用，慢一个数量级；
//   之前 5 路限流太保守，25 路 + 批量删除后只剩 2~3 波往返。）
const BATCH_CONCURRENCY = 25;
const BATCH_CHUNK = 120;
async function eachLimit(items, limit, fn) {
    const ret = new Array(items.length);
    let i = 0;
    async function worker() {
        while (i < items.length) {
            const idx = i++;
            ret[idx] = await fn(items[idx], idx);
        }
    }
    const n = Math.min(limit, items.length);
    const workers = [];
    for (let w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);
    return ret;
}
// 分块高并发：每 120 个一切分，块内 25 路并行。
// 单块最多约 120×3=360 个子请求，远低于单次调用上限；邮件正文是流式转发的，不占内存。
async function eachChunk(items, fn) {
    const out = [];
    for (let s = 0; s < items.length; s += BATCH_CHUNK) {
        const part = await eachLimit(items.slice(s, s + BATCH_CHUNK), BATCH_CONCURRENCY, fn);
        for (const r of part) out.push(r);
    }
    return out;
}
// 批量删除：R2 binding 支持一次删除多个键，N 次 DELETE 合并成 1 个子请求。
// 按 1000 切分兼容批量上限；删除幂等，不存在的键直接忽略。
async function bulkDelete(env, keys) {
    for (let s = 0; s < keys.length; s += 1000) {
        const chunk = keys.slice(s, s + 1000);
        if (!chunk.length) continue;
        try { await env.MAIL_BUCKET.delete(chunk); }
        catch (e) { for (const k of chunk) { try { await env.MAIL_BUCKET.delete(k); } catch (e2) {} } }
    }
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
        // 这个接口每 15 秒被轮询一次，绝不能在这里做全量列举 ——
        // 收信时已经把一个轻量标记对象写好了，直接读它即可（一次 GET）。
        let latest = 0;
        try {
            const marker = await env.MAIL_BUCKET.get(LATEST_FILE);
            if (marker) latest = Number(JSON.parse(await marker.text()).ts) || 0;
        } catch (e) {
            latest = 0;
        }
        if (!latest) {
            // 标记缺失（老部署刚升级上来、或标记写入曾失败）时退回列举。
            // 这种情况只持续到下一封新邮件到达为止，之后就一直走上面的快路径。
            for (const item of await listAllObjects(env)) {
                if (!isMailKey(item.key)) continue;
                const ts = keyTimestamp(item.key);
                if (ts > latest) latest = ts;
            }
        }
        return jsonResponse({ latest: latest });
    }

    // ---------- 正文翻译 ----------
    // 走 Workers AI（m2m100）。注意：邮件正文会被送进模型推理，
    // 但对个人自建的邮箱来说，推理跑在同一个 Cloudflare 账号的基础设施内。
    //
    // 这里只负责「翻 + 缓存 + 回报状态」；真正的译文 HTML 由 /frame/<key>?t=1 提供，
    // 前端拿到 ok 之后把 iframe 的 src 换成 ?t=1 即可 —— 元素位置不变，只换内容。
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
        const text = emailSourceText(email);
        if (!text) return jsonResponse({ ok: false, error: '这封邮件没有可翻译的正文' }, 422);

        const source = detectSourceLang(text);
        if (TRANSLATE_LANGS.indexOf(source) === -1) {
            return jsonResponse({ ok: false, error: '翻译模型暂不支持该语言，仅支持英/中/法/西/阿拉伯/俄/德/日/葡/印地语' }, 422);
        }
        if (source === TRANSLATE_TARGET) {
            return jsonResponse({ ok: false, error: '这封邮件本来就是中文，无需翻译' }, 422);
        }

        try {
            const result = await buildTranslatedFrame(env, email, source);
            // 缓存整篇译文：来回切换原文/译文时直接命中，不再重复计费。
            try {
                await env.MAIL_BUCKET.put(await translationCacheKey(target.key), result.html, {
                    httpMetadata: { contentType: 'text/html; charset=utf-8' }
                });
            } catch (e) {
                console.error('Cache translated html failed:', e && e.stack ? e.stack : e);
            }
            return jsonResponse({
                ok: true,
                sourceLang: source,
                segments: result.segments,
                skipped: result.skipped,
                truncated: result.truncated
            });
        } catch (e) {
            console.error('Translate failed:', e && e.stack ? e.stack : e);
            // 不笼统地说「翻译失败」：把底层原因分类后回显，用户才知道该等一等还是该去查绑定。
            return jsonResponse({ ok: false, error: describeTranslateFailure(e && e.reason) }, 502);
        }
    }

    // ---------- 应用内设置页 ----------
    // ---------- 星标 / 已读状态（JSON，无刷新切换） ----------
    // 计数走增量缓存：原来每次点星标都要全量 list() 翻到底，现在只是一次小 JSON 读写。
    if (url.pathname === '/api/flag' && method === 'POST') {
        let body = null;
        try { body = await request.json(); } catch (e) {}
        const rawKey = body && typeof body.key === 'string' ? body.key : '';
        // resolveEmailKey 会拒绝 CONFIG_FILE 与 _sys/ 内部键，天然防越权
        const resolved = rawKey ? await resolveEmailKey(env, rawKey) : null;
        if (!resolved) return jsonResponse({ ok: false, error: '邮件不存在或已删除' }, 404);
        const before = Object.assign({}, resolved.obj.customMetadata);
        const meta = Object.assign({}, before);
        const delta = {};
        let changed = false;
        if (body && typeof body.star === 'boolean') {
            const want = body.star ? 'true' : 'false';
            if (before.isStarred !== want) {
                meta.isStarred = want; changed = true;
                delta.starred = body.star ? 1 : -1;
            }
        }
        if (body && typeof body.read === 'boolean' && !resolved.isTrash) {
            const want = body.read ? 'true' : 'false';
            if (before.isRead !== want) {
                meta.isRead = want; changed = true;
                delta.unread = body.read ? -1 : 1;
            }
        }
        if (changed) {
            const buf = await resolved.obj.arrayBuffer();
            await env.MAIL_BUCKET.put(resolved.key, buf, { customMetadata: meta });
        }
        const counts = await bumpCounts(env, delta);
        return jsonResponse({ ok: true, star: meta.isStarred === 'true', read: meta.isRead !== 'false', starCount: counts.starred });
    }

    // ---------- 全部标记为已读（25 路并发 + 分块） ----------
    if (url.pathname === '/mark-all-read' && method === 'POST') {
        const fd = await request.formData();
        const back = String(fd.get('next') || '') === '/starred' ? '/starred' : '/';
        const targets = [];
        for (const o of await listAllObjects(env)) {
            if (!isMailKey(o.key)) continue;
            if ((o.customMetadata || {}).isRead === 'true') continue;
            targets.push(o.key);
        }
        // 25 路并发 + 分块：之前 5 路，200 封未读要 80 波往返，现在 8 波；单封失败不影响整批
        await eachChunk(targets, async (key) => {
            try {
                const obj = await env.MAIL_BUCKET.get(key);
                if (!obj) return;
                await env.MAIL_BUCKET.put(key, obj.body, {
                    customMetadata: Object.assign({}, obj.customMetadata, { isRead: 'true' })
                });
            } catch (e) {}
        });
        // 全部已读后未读数直接清零，不用重算
        const c = (await getCounts(env)) || (await refreshCounts(env));
        c.unread = 0;
        await putCounts(env, c);
        const msg = targets.length > 0 ? ('已将 ' + targets.length + ' 封邮件标记为已读') : '没有未读邮件';
        return Response.redirect(url.origin + back + '?toast=' + encodeURIComponent(msg), 302);
    }

    // ---------- 清空回收站（批量删除：N 封只用 2~3 个子请求） ----------
    if (url.pathname === '/purge-all' && method === 'POST') {
        const keys = [];
        for (const o of await listAllObjects(env, { prefix: TRASH_PREFIX })) keys.push(o.key);
        // 译文缓存键是本地算出来的（sha256），同样批量删，不用逐封 R2 查询
        const cacheKeys = await eachChunk(keys, async (key) => {
            try { return await translationCacheKey(key); } catch (e) { return null; }
        });
        await bulkDelete(env, keys);
        await bulkDelete(env, cacheKeys.filter(k => k));
        if (keys.length) await bumpCounts(env, { trash: -keys.length });
        const msg = keys.length > 0 ? ('已清空回收站（' + keys.length + ' 封）') : '回收站已经是空的';
        return Response.redirect(url.origin + '/trash?toast=' + encodeURIComponent(msg), 302);
    }

    if (url.pathname === '/settings') {
        const settings = await getSettings(env);
        const stats = await countsOrRefresh(env);
        const layoutOpts = { unreadCount: stats.unread, starCount: stats.starred };

        if (method === 'POST') {
            const fd = await request.formData();
            const next = Object.assign({}, settings);

            // v2.3：各设置区块独立表单、独立保存 —— 只更新本次提交的字段，
            // 没提交的字段保持原值（之前是整表覆盖，分开提交会误清空别的区块）。
            // 非密钥字段：区块内会回显当前值，所以「空串」就是「清空」。
            if (fd.has('forward_email')) next.forwardEmail = cleanStr(fd.get('forward_email'));
            if (fd.has('turnstile_site_key')) next.turnstileSiteKey = cleanStr(fd.get('turnstile_site_key'));

            // Secret Key：页面永远不回显明文，所以「空串」只能理解为「不修改」。
            // 想清空请用 Turnstile 区块里的「清空密钥」按钮。
            const submittedSecret = cleanStr(fd.get('turnstile_secret_key'));
            if (submittedSecret) next.turnstileSecretKey = submittedSecret;

            // 显示与阅读：page_size 必提交（select），auto_mark_read 勾选才提交（checkbox）
            if (fd.has('page_size')) {
                const ps = parseInt(String(fd.get('page_size')), 10);
                next.pageSize = Number.isFinite(ps) ? Math.min(Math.max(ps, 10), PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT;
                next.autoMarkRead = fd.has('auto_mark_read');
            }

            // 成对校验：只填一个 Key 属于半配置，会让用户以为配好了、实际验证永远过不去
            const hasSite = !!cleanStr(next.turnstileSiteKey);
            const hasSecret = !!cleanStr(next.turnstileSecretKey);
            if (hasSite !== hasSecret) {
                return htmlResponse(renderLayout(
                    renderSettings(
                        { forwardEmail: next.forwardEmail, turnstileSiteKey: next.turnstileSiteKey, turnstileSecretKey: settings.turnstileSecretKey },
                        resolveTurnstile(settings, env),
                        resolveForwardEmail(settings, env),
                        { error: 'Turnstile 的 Site Key 与 Secret Key 必须成对填写：要么都填，要么都不填。', stats: stats }
                    ),
                    'settings',
                    0,
                    layoutOpts
                ), 400);
            }

            await putSettings(env, next);
            return Response.redirect(url.origin + '/settings?saved=1', 302);
        }

        const notice = url.searchParams.get('saved')
            ? '设置已保存。'
            : (url.searchParams.get('cleared')
                ? 'Turnstile 密钥已清空。'
                : (url.searchParams.get('pwchanged')
                    ? '密码已更新，其它设备上的登录已失效。'
                    : (url.searchParams.get('loggedout') ? '已退出其他设备上的登录，本机不受影响。' : '')));

        return htmlResponse(renderLayout(
            renderSettings(settings, resolveTurnstile(settings, env), resolveForwardEmail(settings, env), { notice: notice, stats: stats }),
            'settings',
            0,
            layoutOpts
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

    // ---------- 退出其他设备 ----------
    // 轮换会话 token：其它设备上的旧 Cookie 立刻失效；当前这台用响应里下发的新 Cookie 续上，无需重新登录。
    if (url.pathname === '/settings/logout-others' && method === 'POST') {
        config.sessionToken = randomHex(32);
        config.sessionExpires = Date.now() + SESSION_TTL_MS;
        await env.MAIL_BUCKET.put(CONFIG_FILE, JSON.stringify(config), { httpMetadata: { contentType: 'application/json' } });
        return new Response(null, {
            status: 302,
            headers: Object.assign({}, BASE_HEADERS, {
                'Set-Cookie': SESSION_NAME + '=' + config.sessionToken + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
                'Location': '/settings?loggedout=1'
            })
        });
    }

    // ---------- 修改密码 ----------
    // 以前想改密码只能删掉 sys_config.json 重新初始化 —— 那会连带清掉全部配置和会话，太糙了。
    if (url.pathname === '/settings/password' && method === 'POST') {
        const settings = await getSettings(env);
        const stats2 = await countsOrRefresh(env);
        const back = (opts, status) => htmlResponse(renderLayout(
            renderSettings(settings, resolveTurnstile(settings, env), resolveForwardEmail(settings, env),
                Object.assign({}, opts, { stats: stats2 })),
            'settings',
            0,
            { unreadCount: stats2.unread, starCount: stats2.starred }
        ), status);

        const fd = await request.formData();
        const currentPwd = String(fd.get('current_password') || '');
        const newPwd = String(fd.get('new_password') || '');
        const confirmPwd = String(fd.get('confirm_password') || '');

        if (!await verifyPassword(config, currentPwd)) return back({ error: '当前密码不正确。' }, 400);
        if (newPwd.length < 8) return back({ error: '新密码至少需要 8 位。' }, 400);
        if (newPwd !== confirmPwd) return back({ error: '两次输入的新密码不一致。' }, 400);
        if (newPwd === currentPwd) return back({ error: '新密码不能与当前密码相同。' }, 400);

        // 重新加盐 + **轮换会话 token**：改密码的常见诉求之一就是「把其它设备踢下线」。
        // 轮换后别的设备上的旧 Cookie 立刻失效；当前这台用响应里下发的新 Cookie 续上，无需重新登录。
        const salt = randomHex(16);
        config.salt = salt;
        config.password = await hashPassword(newPwd, salt);
        config.sessionToken = randomHex(32);
        config.sessionExpires = Date.now() + SESSION_TTL_MS;
        await env.MAIL_BUCKET.put(CONFIG_FILE, JSON.stringify(config), { httpMetadata: { contentType: 'application/json' } });

        return new Response(null, {
            status: 302,
            headers: Object.assign({}, BASE_HEADERS, {
                'Set-Cookie': SESSION_NAME + '=' + config.sessionToken + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
                'Location': '/settings?pwchanged=1'
            })
        });
    }

    if (url.pathname === '/delete' && method === 'POST') {
        const fd = await request.formData();
        const key = fd.get('key');
        // _sys/ 系统键永不参与删除：防伪造表单删掉计数缓存等内部文件
        if (key && !key.startsWith(TRASH_PREFIX) && key !== CONFIG_FILE && !String(key).startsWith(SYS_PREFIX)) {
            const obj = await env.MAIL_BUCKET.get(key);
            if (obj) {
                const md = obj.customMetadata || {};
                // 移动时保留已读/星标元数据（原实现会丢）
                await env.MAIL_BUCKET.put(TRASH_PREFIX + key, obj.body, { customMetadata: Object.assign({}, md) });
                await env.MAIL_BUCKET.delete(key);
                await bumpCounts(env, {
                    total: -1, trash: 1,
                    unread: md.isRead !== 'true' ? -1 : 0,
                    starred: md.isStarred === 'true' ? -1 : 0
                });
            }
        }
        return Response.redirect(url.origin + '/?toast=' + encodeURIComponent('已移入回收站'), 302);
    }
    if (url.pathname === '/purge' && method === 'POST') {
        const fd = await request.formData();
        const key = fd.get('key');
        if (key && key.startsWith(TRASH_PREFIX)) {
            await env.MAIL_BUCKET.delete(key);
            // 顺手清掉这封邮件缓存的译文，免得留下永远读不到的孤儿对象。
            await dropTranslationCache(env, key);
            await bumpCounts(env, { trash: -1 });
        }
        return Response.redirect(url.origin + '/trash?toast=' + encodeURIComponent('已彻底删除'), 302);
    }
    if (url.pathname === '/restore' && method === 'POST') {
        const fd = await request.formData();
        const key = fd.get('key');
        if (key && key.startsWith(TRASH_PREFIX)) {
            const obj = await env.MAIL_BUCKET.get(key);
            if (obj) {
                const md = obj.customMetadata || {};
                await env.MAIL_BUCKET.put(key.replace(TRASH_PREFIX, ''), obj.body, { customMetadata: Object.assign({}, md) });
                await env.MAIL_BUCKET.delete(key);
                await bumpCounts(env, {
                    total: 1, trash: -1,
                    unread: md.isRead !== 'true' ? 1 : 0,
                    starred: md.isStarred === 'true' ? 1 : 0
                });
            }
        }
        return Response.redirect(url.origin + '/trash?toast=' + encodeURIComponent('已恢复到收件箱'), 302);
    }

    if (url.pathname === '/batch-action' && method === 'POST') {
        const fd = await request.formData();
        // _sys/ 系统键永不参与批量操作：防伪造表单删掉计数缓存等内部文件
        const keys = fd.getAll('keys').filter(k => k && k !== CONFIG_FILE && !String(k).startsWith(SYS_PREFIX));
        const action = fd.get('action');
        const totals = { total: 0, unread: 0, starred: 0, trash: 0 };
        let done = 0;
        const movedSources = [];  // 移动成功后的源键：第二阶段一次批量删除
        const purgeKeys = [];     // 彻底删除的键：第二阶段一次批量删除

        // 单封处理函数：返回 { ok, d }，d 为该封邮件带来的计数变化。
        // 移动（删除/恢复）时保留 customMetadata，原实现会丢已读/星标状态。
        const applyOne = async (key) => {
            const d = { total: 0, unread: 0, starred: 0, trash: 0 };
            const wasUnread = md => (md.isRead !== 'true' ? 1 : 0);
            const wasStarred = md => (md.isStarred === 'true' ? 1 : 0);
            if (action === 'delete') {
                if (key.startsWith(TRASH_PREFIX)) return { ok: false, d };
                const obj = await env.MAIL_BUCKET.get(key);
                if (!obj) return { ok: false, d };
                const md = obj.customMetadata || {};
                // 第一阶段只做 GET→PUT，源键留到第二阶段一次批量删除（N 次 DELETE → 1 个子请求）
                await env.MAIL_BUCKET.put(TRASH_PREFIX + key, obj.body, { customMetadata: Object.assign({}, md) });
                d.total = -1; d.trash = 1; d.unread = -wasUnread(md); d.starred = -wasStarred(md);
                return { ok: true, d, src: key };
            }
            if (action === 'purge') {
                if (!key.startsWith(TRASH_PREFIX)) return { ok: false, d };
                d.trash = -1;
                return { ok: true, d, purge: key };
            }
            if (action === 'restore') {
                if (!key.startsWith(TRASH_PREFIX)) return { ok: false, d };
                const obj = await env.MAIL_BUCKET.get(key);
                if (!obj) return { ok: false, d };
                const md = obj.customMetadata || {};
                await env.MAIL_BUCKET.put(key.replace(TRASH_PREFIX, ''), obj.body, { customMetadata: Object.assign({}, md) });
                d.total = 1; d.trash = -1; d.unread = wasUnread(md); d.starred = wasStarred(md);
                return { ok: true, d, src: key };
            }
            if (action === 'mark_read' || action === 'mark_unread') {
                if (key.startsWith(TRASH_PREFIX)) return { ok: false, d };
                const obj = await env.MAIL_BUCKET.get(key);
                if (!obj) return { ok: false, d };
                const md = Object.assign({}, obj.customMetadata);
                const want = action === 'mark_read' ? 'true' : 'false';
                if (md.isRead === want) return { ok: false, d };
                d.unread = action === 'mark_read' ? -1 : 1;
                md.isRead = want;
                await env.MAIL_BUCKET.put(key, obj.body, { customMetadata: md });
                return { ok: true, d };
            }
            if (action === 'star' || action === 'unstar') {
                if (key.startsWith(TRASH_PREFIX)) return { ok: false, d };
                const obj = await env.MAIL_BUCKET.get(key);
                if (!obj) return { ok: false, d };
                const md = Object.assign({}, obj.customMetadata);
                const want = action === 'star' ? 'true' : 'false';
                if (md.isStarred === want) return { ok: false, d };
                d.starred = action === 'star' ? 1 : -1;
                md.isStarred = want;
                await env.MAIL_BUCKET.put(key, obj.body, { customMetadata: md });
                return { ok: true, d };
            }
            return { ok: false, d };
        };

        // 两阶段批量：第一阶段 25 路并发只做 GET→PUT（移动/改标记），不逐封 DELETE；
        // 25 封批量删从 15 波往返降到 3 波（GET 波 + PUT 波 + 1 次批量 DELETE）。
        // 单封失败只记 ok:false，不让整批 500。
        const safeApply = async (key) => {
            try { return await applyOne(key); }
            catch (e) { return { ok: false, d: { total: 0, unread: 0, starred: 0, trash: 0 } }; }
        };
        const results = await eachChunk(keys, safeApply);
        for (const r of results) {
            if (!r || !r.ok) continue;
            done++;
            for (const k of ['total', 'unread', 'starred', 'trash']) totals[k] += r.d[k];
            if (r.src) movedSources.push(r.src);
            if (r.purge) purgeKeys.push(r.purge);
        }
        // 第二阶段：源键一次批量删除（N 次 DELETE → 1 个子请求）
        await bulkDelete(env, movedSources.concat(purgeKeys));
        // 彻底删除的邮件顺手清译文缓存（缓存键本地可算，同样批量删）
        if (purgeKeys.length) {
            const cacheKeys = await eachChunk(purgeKeys, async (k) => {
                try { return await translationCacheKey(k); } catch (e) { return null; }
            });
            await bulkDelete(env, cacheKeys.filter(k => k));
        }
        if (done) await bumpCounts(env, totals);

        // 回跳：白名单校验防开放重定向；保留 q/limit 搜索条件，回到之前的视图
        const nextRaw = String(fd.get('next') || '');
        const next = nextRaw.indexOf('/trash') === 0 ? '/trash' : (nextRaw === '/starred' ? '/starred' : '/');
        const qs = [];
        const lim = parseInt(String(fd.get('limit') || ''), 10);
        if (Number.isFinite(lim)) qs.push('limit=' + Math.min(Math.max(lim, PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX));
        const q = String(fd.get('q') || '').trim().slice(0, 100);
        if (q) qs.push('q=' + encodeURIComponent(q));
        const actionLabel = {
            delete: '已移入回收站', purge: '已彻底删除', restore: '已恢复到收件箱',
            mark_read: '已标记为已读', mark_unread: '已标记为未读',
            star: '已加星标', unstar: '已取消星标'
        }[action] || '操作完成';
        qs.push('toast=' + encodeURIComponent(done > 0 ? (actionLabel + '（' + done + ' 封）') : '没有选中任何邮件'));
        return Response.redirect(url.origin + next + '?' + qs.join('&'), 302);
    }

    if (url.pathname.startsWith('/frame/')) {
        const resolved = await resolveEmailKey(env, safeDecode(url.pathname.slice('/frame/'.length)));
        if (!resolved) return textResponse('Not Found', 404);

        // ?t=1 → 保留版式的译文文档。和原文走同一个 iframe、同一套外壳，
        // 所以切换原文/译文时元素位置不动，只是里面的文字换了语言。
        if (url.searchParams.get('t') === '1') {
            const cacheKey = await translationCacheKey(resolved.key);
            try {
                const cached = await env.MAIL_BUCKET.get(cacheKey);
                if (cached) return frameResponse(await cached.text());
            } catch (e) {}

            if (env.AI) {
                try {
                    const email = processEmail(bufferToBinaryString(await resolved.obj.arrayBuffer()));
                    const text = emailSourceText(email);
                    const source = detectSourceLang(text);
                    if (text && TRANSLATE_LANGS.indexOf(source) !== -1 && source !== TRANSLATE_TARGET) {
                        const result = await buildTranslatedFrame(env, email, source);
                        try {
                            await env.MAIL_BUCKET.put(cacheKey, result.html, {
                                httpMetadata: { contentType: 'text/html; charset=utf-8' }
                            });
                        } catch (e) {}
                        return frameResponse(result.html);
                    }
                } catch (e) {
                    console.error('Translated frame failed:', e && e.stack ? e.stack : e);
                }
            }
            // 翻不了（未绑定 AI / 语种不支持 / 模型报错）就静默退回原文，绝不让 iframe 空着。
        }

        const email = processEmail(bufferToBinaryString(await resolved.obj.arrayBuffer()));
        return frameResponse(buildFrameDocument(email));
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

    // 下载原始邮件（.eml）。归档备份、喂给别的邮件客户端、排障看真实头部都用得上。
    if (url.pathname.startsWith('/raw/')) {
        const resolved = await resolveEmailKey(env, safeDecode(url.pathname.slice('/raw/'.length)));
        if (!resolved) return textResponse('Not Found', 404);

        const safeName = resolved.key.replace(TRASH_PREFIX, '').replace(/[\r\n"]/g, '_').replace(/\.eml$/i, '') + '.eml';
        const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_');
        const encodedName = encodeURIComponent(safeName).replace(/'/g, '%27');
        return new Response(await resolved.obj.arrayBuffer(), {
            headers: Object.assign({}, BASE_HEADERS, {
                // message/rfc822 是 .eml 的标准类型；配 attachment + nosniff，
                // 浏览器只会下载、绝不会当成页面渲染。
                'Content-Type': 'message/rfc822',
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
        const meta0 = resolved.obj.customMetadata || {};
        // 「设置 → 显示与阅读」可关闭自动标已读；默认开启（保持原行为）
        const detailSettings = await getSettings(env);
        const willMarkRead = detailSettings.autoMarkRead !== false && !resolved.isTrash && meta0.isRead !== 'true';
        if (willMarkRead) {
            // ⚠️ 必须保留已有 customMetadata（isStarred 等），不能只写 isRead ——
            // 否则打开一封星标邮件就会悄悄抹掉它的星标。
            ctx.waitUntil(env.MAIL_BUCKET.put(resolved.key, buffer, { customMetadata: Object.assign({}, meta0, { isRead: 'true' }) }));
        }

        // 上一封 / 下一封：单次列举定位邻居；同一趟数据顺手校准计数缓存
        // （徽标不再单独列举，直接用这里的权威值，零额外开销）
        let prevKey = null, nextKey = null, counts = null;
        try {
            const dAll = await listAllObjects(env);
            counts = { total: 0, unread: 0, starred: 0, trash: 0 };
            const dMails = [];
            for (const o of dAll) {
                if (o.key.startsWith(TRASH_PREFIX)) { counts.trash++; if (resolved.isTrash) dMails.push(o); continue; }
                if (!isMailKey(o.key)) continue;
                counts.total++;
                const md = o.customMetadata || {};
                if (md.isRead !== 'true') counts.unread++;
                if (md.isStarred === 'true') counts.starred++;
                if (!resolved.isTrash) dMails.push(o);
            }
            dMails.sort((a, b) => keyTimestamp(b.key) - keyTimestamp(a.key));
            const di = dMails.findIndex(m => m.key === resolved.key);
            if (di >= 0) {
                if (di > 0) prevKey = dMails[di - 1].key;
                if (di < dMails.length - 1) nextKey = dMails[di + 1].key;
            }
            // 本次打开会把这封标为已读，计数里先减掉，免得徽标本次闪一下旧值
            if (willMarkRead && counts.unread > 0) counts.unread--;
            ctx.waitUntil(putCounts(env, counts));
        } catch (e) {}
        const badge = counts || (await countsOrRefresh(env));

        const email = processEmail(bufferToBinaryString(buffer));
        return htmlResponse(renderLayout(
            renderEmailDetail(email, resolved.key, resolved.isTrash, resolved.obj.uploaded, {
                prevKey: prevKey,
                nextKey: nextKey,
                isStarred: meta0.isStarred === 'true',
                isRead: resolved.isTrash || meta0.isRead === 'true'
            }),
            resolved.isTrash ? 'trash' : 'inbox',
            0,
            { unreadCount: badge.unread, starCount: badge.starred }
        ));
    }

    const LIST_MODE = url.pathname === '/trash' ? 'trash' : (url.pathname === '/starred' ? 'starred' : (url.pathname === '/' ? 'inbox' : null));
    if (LIST_MODE) {
        // 显示设置（每页数量）：小 JSON，一次读取；?limit= 显式指定时优先
        const listSettings = await getSettings(env);
        const isTrashPage = LIST_MODE === 'trash';
        const isStarredPage = LIST_MODE === 'starred';

        // 一次列举、内存里分拣：收件箱 / 回收站 / 计数一次算完。
        // （R2 list 按键名字典序返回，这里自己按时间戳重排；新邮件永远置顶。）
        const all = await listAllObjects(env);
        const inboxMails = all.filter(o => isMailKey(o.key)).sort((a, b) => keyTimestamp(b.key) - keyTimestamp(a.key));
        const trashMails = all.filter(o => o.key.startsWith(TRASH_PREFIX)).sort((a, b) => keyTimestamp(b.key) - keyTimestamp(a.key));

        let unreadCount = 0, starCount = 0;
        for (const m of inboxMails) {
            const md = m.customMetadata || {};
            if (md.isRead !== 'true') unreadCount++;
            if (md.isStarred === 'true') starCount++;
        }

        let emails = isTrashPage ? trashMails : inboxMails;
        if (isStarredPage) emails = inboxMails.filter(o => (o.customMetadata || {}).isStarred === 'true');

        // 只看未读（收件箱 / 星标页），和搜索可叠加
        const unreadOnly = !isTrashPage && url.searchParams.get('unread') === '1';
        if (unreadOnly) emails = emails.filter(o => (o.customMetadata || {}).isRead !== 'true');

        const displayKeyOf = o => (isTrashPage ? o.key.replace(TRASH_PREFIX, '') : o.key);

        // 搜索：只匹配主题与发件人。键名里存的就是入库时解码好的明文，
        // 不用读正文，所以成本基本为零。
        const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
        const needle = query.toLowerCase();
        const matched = needle
            ? emails.filter(o => {
                const meta = parseKeyMeta(displayKeyOf(o));
                return meta.from.toLowerCase().includes(needle) || meta.subject.toLowerCase().includes(needle);
            })
            : emails;

        // 分页：夹在 [50, 2000]，避免 ?limit= 被放大成任意值；
        // 默认值走「设置 → 显示与阅读」里的每页数量
        const requested = parseInt(url.searchParams.get('limit') || '', 10);
        const savedPageSize = parseInt(listSettings.pageSize, 10);
        const defaultPageSize = Number.isFinite(savedPageSize)
            ? Math.min(Math.max(savedPageSize, 10), PAGE_SIZE_MAX)
            : PAGE_SIZE_DEFAULT;
        const pageSize = Number.isFinite(requested)
            ? Math.min(Math.max(requested, PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX)
            : defaultPageSize;
        const shown = matched.slice(0, pageSize);
        const nextSize = Math.min(pageSize * 2, PAGE_SIZE_MAX);
        const hasMore = matched.length > shown.length;

        // 列表页是计数的权威数据源：渲染完顺手校准缓存（waitUntil，不阻塞响应）
        ctx.waitUntil(putCounts(env, { total: inboxMails.length, unread: unreadCount, starred: starCount, trash: trashMails.length }));

        const rows = shown.map(e => {
            const fullKey = e.key;
            const displayKey = displayKeyOf(e);
            const meta = parseKeyMeta(displayKey);
            const senderName = (meta.from.includes('<')
                ? meta.from.split('<')[0].replace(/"/g, '').trim()
                : meta.from.trim()) || '未知发件人';
            const subject = meta.subject.trim() || '(无主题)';
            const color = getAvatarColor(senderName);
            const ts = keyTimestamp(displayKey);
            const isRead = (e.customMetadata || {}).isRead === 'true';
            const isStarred = (e.customMetadata || {}).isStarred === 'true';
            // 主题与发件人完全由发件人控制，必须转义后才能拼进 HTML；
            // data-key 走 encodeURIComponent + escapeAttr，行点击用事件委托（防 XSS）。
            return {
                fullKeyAttr: escapeAttr(fullKey),
                dataKeyAttr: escapeAttr(encodeURIComponent(displayKey)),
                senderName: escapeHtml(senderName),
                subject: escapeHtml(subject),
                ts: ts,
                iso: ts > 0 ? escapeAttr(new Date(ts).toISOString()) : '',
                isRead: isRead,
                isStarred: isStarred,
                avatarColor: color,
                initial: escapeHtml((senderName[0] || '?').toUpperCase())
            };
        });

        const titles = { inbox: '收件箱', starred: '已加星标', trash: '回收站' };
        const emptyCfg = {
            inbox: { icon: Icons.inbox, title: '暂无邮件', desc: '您的收件箱空空如也。新邮件到达时会自动出现在这里。' },
            starred: { icon: Icons.star, title: '还没有加星标的邮件', desc: '把鼠标移到邮件行上（或点开邮件），点亮星标即可收藏到这里。' },
            trash: { icon: Icons.trash, title: '回收站是空的', desc: '被删除的邮件会在这里保留，彻底删除后无法恢复。' }
        }[LIST_MODE];
        if (query) { emptyCfg.title = '没有匹配的邮件'; emptyCfg.desc = '换个关键词试试。搜索范围是主题与发件人。'; }
        else if (unreadOnly) { emptyCfg.icon = Icons.checkAll; emptyCfg.title = '没有未读邮件'; emptyCfg.desc = '干得漂亮，收件箱已清空。'; }

        const searchAction = LIST_MODE === 'trash' ? '/trash' : (LIST_MODE === 'starred' ? '/starred' : '/');
        const countLine = query
            ? ('找到 ' + matched.length + ' 封匹配「' + query + '」的邮件')
            : (unreadOnly
                ? ('共 ' + emails.length + ' 封未读邮件')
                : ('共 ' + emails.length + ' 封邮件' + (hasMore ? '，当前显示最新 ' + shown.length + ' 封' : '')));
        const nextHref = searchAction + '?limit=' + nextSize + (query ? '&q=' + encodeURIComponent(query) : '') + (unreadOnly ? '&unread=1' : '');

        // 未读筛选开关：保留搜索词
        const toggleParams = [];
        if (query) toggleParams.push('q=' + encodeURIComponent(query));
        if (!unreadOnly) toggleParams.push('unread=1');
        const filterToggleHref = searchAction + (toggleParams.length ? '?' + toggleParams.join('&') : '');

        // 收件箱首页轮询新邮件用：最新一封的时间戳
        const latestTimestamp = LIST_MODE === 'inbox' && inboxMails.length > 0 ? keyTimestamp(inboxMails[0].key) : 0;

        const html = renderMailListPage({
            mode: LIST_MODE,
            title: titles[LIST_MODE],
            countLine: escapeHtml(countLine),
            queryAttr: escapeAttr(query),
            query: query,
            searchAction: searchAction,
            nextValue: searchAction,
            pageSizeAttr: escapeAttr(String(pageSize)),
            rows: rows,
            empty: { icon: emptyCfg.icon, title: escapeHtml(emptyCfg.title), desc: escapeHtml(emptyCfg.desc) },
            hasMore: hasMore,
            nextHrefAttr: escapeAttr(nextHref),
            remaining: matched.length - shown.length,
            showMarkAllRead: LIST_MODE === 'inbox' && unreadCount > 0,
            unreadOnly: unreadOnly,
            filterToggleHref: escapeAttr(filterToggleHref),
            showEmptyTrash: isTrashPage && trashMails.length > 0
        });
        return htmlResponse(renderLayout(html, LIST_MODE, latestTimestamp, {
            unreadCount: unreadCount, starCount: starCount, trashCount: trashMails.length
        }));
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
            return htmlResponse('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>服务异常 · CF Mail</title><script src="https://cdn.tailwindcss.com"></script><style>' + THEME_CSS + '</style></head><body style="min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1.5rem"><div class="card" style="max-width:26rem;width:100%;padding:2.5rem 2rem;text-align:center"><div class="empty-icon" style="margin:0 auto 1.2rem;color:var(--danger)">' + Icons.alert + '</div><h1 style="font-size:1.3rem;font-weight:800;margin-bottom:.5rem">服务暂时不可用</h1><p style="font-size:.87rem;color:var(--text-2);line-height:1.7">请稍后重试。若持续出现，请查看 Worker 日志（Dashboard 的 Logs 页或 wrangler tail）。</p><a href="/" class="btn btn-primary" style="margin-top:1.5rem">返回收件箱</a></div></body></html>', 500);
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
        const now = Date.now();
        const key = now + '_' + keyFrom.length + '_' + keyFrom + keySubject + '.eml';

        try {
            const rawData = await new Response(message.raw).arrayBuffer();
            await env.MAIL_BUCKET.put(key, rawData, { customMetadata: { isRead: 'false' } });
            // 增量维护计数缓存：新邮件 total+1、unread+1
            ctx.waitUntil(bumpCounts(env, { total: 1, unread: 1 }));
            // 更新「最新邮件」标记，供前端每 15 秒的轮询直接读取（避免全量列举）。
            // 与键名用同一个 now，保证页面里的 CURRENT_PAGE_LATEST_TS 与它可直接比较。
            try {
                await env.MAIL_BUCKET.put(LATEST_FILE, JSON.stringify({ ts: now }), { httpMetadata: { contentType: 'application/json' } });
            } catch (e) {
                console.error('Failed to update latest marker:', e && e.stack ? e.stack : e);
            }
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
