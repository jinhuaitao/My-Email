/**
 * Cloudflare Workers 邮箱客户端 - v11.2 (UI/UX 优化版)
 * 更新内容：
 * 1. UI 布局和颜色现代化 (主色调：Indigo/Blue)
 * 2. 改进了登录页面的设计和动画效果
 * 3. 优化了邮件列表和详情页面的视觉层次和信息密度
 * 4. 保留并集成了 v11.1 的乱码修复逻辑
 */

const CONFIG_FILE = 'sys_config.json';
const SESSION_NAME = 'auth_session';
const TRASH_PREFIX = 'trash/';

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
    theme_color: "#4f46e5", // Indigo-600
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
// 2. 核心工具函数 (保留了乱码修复逻辑)
// ==========================================

async function hashPassword(password) {
    const msgBuffer = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
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

/**
 * 修复版 decodeContent: 基于字节流处理，解决多字节字符（如中文）乱码
 */
function decodeContent(str, encoding, charset = 'utf-8') {
    if (!str) return '';
    
    // 1. 规范化字符集，GB2312 -> GBK 以支持更多汉字
    let label = (charset || 'utf-8').toLowerCase().trim();
    if (label === 'gb2312' || label === 'gb_2312-80') label = 'gbk';
    
    // 2. 准备解码器
    let decoder;
    try {
        decoder = new TextDecoder(label);
    } catch (e) {
        decoder = new TextDecoder('utf-8'); // 回退
    }

    try {
        let bytes;
        if (encoding === 'base64') {
            // Base64 -> Uint8Array
            const cleanStr = str.replace(/[\r\n\s]/g, '');
            const binaryString = atob(cleanStr);
            bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
        } else if (encoding === 'quoted-printable' || encoding === 'quoted') {
            // Quoted-Printable -> Uint8Array (关键修复)
            const cleanStr = str.replace(/=\r?\n/g, ''); // 移除软换行
            const buffer = [];
            for (let i = 0; i < cleanStr.length; i++) {
                const c = cleanStr[i];
                if (c === '=') {
                    const hex = cleanStr.substr(i + 1, 2);
                    if (/^[\da-fA-F]{2}$/.test(hex)) {
                        buffer.push(parseInt(hex, 16));
                        i += 2;
                    } else {
                        buffer.push(61); // '=' ASCII
                    }
                } else {
                    buffer.push(c.charCodeAt(0));
                }
            }
            bytes = new Uint8Array(buffer);
        } else {
            // Default -> Uint8Array
            bytes = new Uint8Array(str.length);
            for (let i = 0; i < str.length; i++) {
                bytes[i] = str.charCodeAt(i);
            }
        }
        
        return decoder.decode(bytes);
    } catch (e) {
        console.error('Decoding error:', e);
        return str;
    }
}

/**
 * 修复版 decodeHeaderValue: 处理 RFC 2047 分段空格
 */
function decodeHeaderValue(text) {
    if (!text) return '';
    
    // RFC 2231 (filename*=utf-8''...)
    if (text.includes("''")) {
        const parts = text.split("''");
        if (parts.length === 2) { try { return decodeURIComponent(parts[1]); } catch (e) {} }
    }

    // RFC 2047 (=?charset?B?content?=)
    const rfc2047Regex = /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g;
    if (rfc2047Regex.test(text)) {
        // 关键修复：移除分段编码之间的空格 (e.g. "=?UTF-8?B?...?= =?UTF-8?B?...?=")
        const cleanText = text.replace(/\?=\s+=\?/g, '?==?');
        return cleanText.replace(rfc2047Regex, (_, charset, type, content) => {
            const encoding = type.toUpperCase() === 'B' ? 'base64' : 'quoted-printable';
            return decodeContent(content, encoding, charset);
        });
    }
    
    if (text.includes('%')) { try { return decodeURIComponent(text); } catch (e) {} }
    return text.replace(/^["']|["']$/g, '');
}

function parseMimeParts(rawText, boundary) {
    const parts = [];
    if (!boundary) return [{ headers: {}, body: rawText }];
    const rawParts = rawText.split(`--${boundary}`);
    for (const chunk of rawParts) {
        if (chunk.trim() === '' || chunk.trim() === '--') continue;
        const [headerPart, ...bodyParts] = chunk.split(/\r?\n\r?\n/);
        const bodyPart = bodyParts.join('\n\n');
        const headers = {};
        headerPart.split(/\r?\n/).forEach(line => {
            const match = line.match(/^([^:]+):\s*(.*)$/i);
            if (match) headers[match[1].toLowerCase()] = match[2];
        });
        const contentType = headers['content-type'] || '';
        const subBoundaryMatch = contentType.match(/boundary=["']?([^"';]+)/i);
        if (subBoundaryMatch) {
            parts.push(...parseMimeParts(bodyPart, subBoundaryMatch[1]));
        } else {
            parts.push({ headers, body: bodyPart });
        }
    }
    return parts;
}

function processEmail(rawText) {
    const [topHeaderRaw, ...rest] = rawText.split(/\r?\n\r?\n/);
    const topBodyRaw = rest.join('\n\n');
    const headers = {};
    topHeaderRaw.replace(/\r?\n\s+/g, ' ').split(/\r?\n/).forEach(line => {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (match) headers[match[1].toLowerCase()] = match[2];
    });
    if (headers['subject']) headers['subject'] = decodeHeaderValue(headers['subject']);
    if (headers['from']) headers['from'] = decodeHeaderValue(headers['from']);

    const boundaryMatch = (headers['content-type'] || '').match(/boundary=["']?([^"';]+)/i);
    const boundary = boundaryMatch ? boundaryMatch[1] : null;
    const allParts = parseMimeParts(topBodyRaw, boundary);

    let htmlBody = '';
    let textBody = '';
    const attachments = [];

    for (const part of allParts) {
        const type = part.headers['content-type'] || 'text/plain';
        const disposition = part.headers['content-disposition'] || '';
        const encoding = (part.headers['content-transfer-encoding'] || '').toLowerCase();
        const charsetMatch = type.match(/charset=["']?([\w-]+)/i);
        const charset = charsetMatch ? charsetMatch[1] : 'utf-8';
        
        // 优化文件名提取正则
        const filenameMatch = disposition.match(/filename\*?=(?:utf-8'')?(?:"([^"]+)"|'([^']+)'|([^"';\r\n]+))/i) || type.match(/name=(?:"([^"]+)"|'([^']+)'|([^"';\r\n]+))/i);
        
        if (disposition.includes('attachment') || filenameMatch) {
            let filename = 'unknown_file';
            if (filenameMatch) {
                filename = filenameMatch[1] || filenameMatch[2] || filenameMatch[3] || 'unknown_file';
            }
            filename = decodeHeaderValue(filename);
            
            const cleanBase64 = part.body.replace(/\s/g, '');
            let dataUri = '';
            if (encoding === 'base64') {
                const mime = type.split(';')[0].trim();
                dataUri = `data:${mime};base64,${cleanBase64}`;
            }
            // 简单估算大小
            const sizeInBytes = Math.round(cleanBase64.length * 0.75);
            let sizeStr = sizeInBytes + ' B';
            if(sizeInBytes > 1024) sizeStr = Math.round(sizeInBytes/1024) + ' KB';
            if(sizeInBytes > 1024*1024) sizeStr = (sizeInBytes/(1024*1024)).toFixed(1) + ' MB';

            attachments.push({ filename: filename, size: sizeStr, data: dataUri, type: type });
        } else {
            if (type.includes('text/html')) {
                htmlBody = decodeContent(part.body, encoding, charset);
            } else if (type.includes('text/plain') && !htmlBody) {
                textBody = decodeContent(part.body, encoding, charset);
            }
        }
    }
    let finalBody = htmlBody || `<pre class="whitespace-pre-wrap font-sans text-gray-700">${textBody}</pre>`;
    if (!htmlBody && !textBody) finalBody = "<i>（无正文内容，请查看附件）</i>";
    return { headers, body: finalBody, attachments, date: headers['date'] };
}

function getAvatarColor(name) {
    const colors = ['bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-green-500', 'bg-emerald-500', 'bg-teal-500', 'bg-cyan-500', 'bg-blue-500', 'bg-indigo-500', 'bg-violet-500', 'bg-purple-500', 'bg-fuchsia-500', 'bg-pink-500', 'bg-rose-500'];
    let hash = 0;
    const cleanName = name || '?';
    for (let i = 0; i < cleanName.length; i++) hash = cleanName.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
}

// ==========================================
// 3. UI 渲染
// ==========================================

const Icons = {
    inbox: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>`,
    trash: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`,
    refresh: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>`,
    logout: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>`,
    back: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>`,
    attach: `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>`,
    download: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>`,
    menu: `<svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" /></svg>`,
    user: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>`,
    lock: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>`,
    spinner: `<svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`,
    alert: `<svg class="w-10 h-10 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>`,
    read: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 19v-8.93a2 2 0 01.89-1.664l7-4.666a2 2 0 012.22 0l7 4.666A2 2 0 0121 10.07V19M3 19a2 2 0 002 2h14a2 2 0 002-2M3 19l6.75-4.5M21 19l-6.75-4.5M3 10l6.75 4.5M21 10l-6.75 4.5m0 0l-1.14.76a2 2 0 01-2.22 0l-1.14-.76" /></svg>`,
    unread: `<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>`
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

        // --- 自动刷新逻辑 ---
        const CURRENT_PAGE_LATEST_TS = ${latestTimestamp};
        if (window.location.pathname === '/' && CURRENT_PAGE_LATEST_TS > 0) {
            setInterval(async () => {
                try {
                    const res = await fetch('/api/check');
                    if (res.ok) {
                        const data = await res.json();
                        if (data.latest > CURRENT_PAGE_LATEST_TS) {
                            console.log('New mail detected, refreshing...');
                            // 使用 smooth transition 刷新
                            const toast = document.createElement('div');
                            toast.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 p-3 bg-indigo-600 text-white rounded-xl shadow-lg shadow-indigo-600/50 z-[70] transition-opacity duration-300';
                            toast.textContent = '检测到新邮件，正在刷新...';
                            document.body.appendChild(toast);
                            setTimeout(() => { window.location.reload(); }, 1500);
                        }
                    }
                } catch(e) {}
            }, 15000); // 每15秒检测一次
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
    </script>
</head>
<body class="bg-gray-50 h-screen flex overflow-hidden text-gray-800">
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
        </nav>
        <div class="p-4 border-t border-gray-100 safe-bottom"><a href="/logout" class="flex items-center px-3 py-3 text-base font-medium text-red-600 rounded-xl hover:bg-red-50 transition-colors"><span class="mr-3">${Icons.logout}</span>退出登录</a></div>
    </aside>
    <main class="flex-1 flex flex-col min-w-0 bg-white md:bg-gray-50 w-full relative z-0">${content}</main>
</body></html>`;

const renderLogin = (error = "", siteKey = "") => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><title>登录</title><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#ffffff"><link rel="icon" type="image/svg+xml" href="/logo.svg"><script src="https://cdn.tailwindcss.com"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');body{font-family:'Inter',system-ui,sans-serif}</style><script>function handleLogin(btn){btn.disabled=true;btn.innerHTML='${Icons.spinner} 登录中...';btn.classList.add('opacity-75','cursor-not-allowed');setTimeout(()=>{if(btn.disabled){btn.disabled=false;btn.innerHTML='登录';btn.classList.remove('opacity-75','cursor-not-allowed')}},5000);return true}</script></head><body class="h-screen w-full flex items-center justify-center p-4 bg-gradient-to-br from-indigo-50 via-white to-blue-50"><div class="w-full max-w-sm bg-white/80 backdrop-blur-xl rounded-2xl shadow-[0_12px_40px_rgb(0,0,0,0.1)] border border-gray-100/70 overflow-hidden"><div class="p-8"><div class="text-center mb-10"><div class="inline-flex items-center justify-center w-14 h-14 bg-indigo-600 rounded-2xl text-white font-bold text-2xl mb-4 shadow-lg shadow-indigo-600/30 transition-all hover:scale-[1.02]">M</div><h1 class="text-2xl font-bold text-gray-900 tracking-tight">欢迎回来</h1><p class="text-sm text-gray-500 mt-2">请登录您的 Cloudflare 邮箱</p></div>${error ? `<div class="mb-6 p-4 bg-red-50/80 border border-red-100 text-red-600 text-sm rounded-xl flex items-center shadow-sm animate-pulse"><span class="mr-2">⚠️</span>${error}</div>` : ''}<form method="POST" class="space-y-5" onsubmit="return handleLogin(document.getElementById('loginBtn'))"><div class="space-y-1.5"><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider ml-1">用户名</label><div class="relative group"><div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400 group-focus-within:text-indigo-500 transition-colors">${Icons.user}</div><input type="text" name="username" class="block w-full pl-10 pr-4 py-3 bg-gray-50/50 border border-gray-200 text-gray-900 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all duration-200" placeholder="请输入用户名" required></div></div><div class="space-y-1.5"><label class="block text-xs font-semibold text-gray-500 uppercase tracking-wider ml-1">密码</label><div class="relative group"><div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400 group-focus-within:text-indigo-500 transition-colors">${Icons.lock}</div><input type="password" name="password" class="block w-full pl-10 pr-4 py-3 bg-gray-50/50 border border-gray-200 text-gray-900 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all duration-200" placeholder="••••••••" required></div></div>${siteKey ? `<div class="flex justify-center pt-2"><div class="cf-turnstile" data-sitekey="${siteKey}" data-theme="light"></div></div>` : ''}<button type="submit" id="loginBtn" class="w-full py-3.5 bg-indigo-600 text-white rounded-xl font-semibold shadow-lg shadow-indigo-600/40 hover:bg-indigo-700 hover:shadow-indigo-600/50 active:scale-[0.98] transition-all duration-200 flex items-center justify-center">登录</button></form></div><div class="bg-gray-50/50 p-4 text-center border-t border-gray-100"><p class="text-xs text-gray-400">Powered by Cloudflare Workers</p></div></div></body></html>`;

const renderSetup = () => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>系统初始化</title><script src="https://cdn.tailwindcss.com"></script><style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');body{font-family:'Inter',system-ui,sans-serif}</style></head><body class="h-screen w-full flex items-center justify-center p-4 bg-gradient-to-br from-indigo-600 to-blue-700"><div class="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden"><div class="p-8"><h1 class="text-3xl font-bold text-gray-900 mb-2">欢迎使用</h1><p class="text-gray-500 mb-8">请设置您的管理员账号以完成部署。</p><form method="POST" action="/setup" class="space-y-6"><div><label class="block text-sm font-semibold text-gray-700 mb-2">设置用户名</label><input type="text" name="username" class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all" placeholder="admin" required></div><div><label class="block text-sm font-semibold text-gray-700 mb-2">设置密码</label><input type="password" name="password" class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all" placeholder="••••••••" required></div><button class="w-full py-3.5 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-all shadow-lg hover:shadow-xl active:scale-[0.98]">完成设置并登录</button></form></div></div></body></html>`;

// ==========================================
// 4. 业务逻辑
// ==========================================

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const cookies = parseCookies(request);

    if (url.pathname === '/manifest.json') return new Response(renderManifest(), { headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/logo.svg') return new Response(renderAppIcon(), { headers: { 'Content-Type': 'image/svg+xml' } });
    if (url.pathname === '/sw.js') return new Response(renderServiceWorker(), { headers: { 'Content-Type': 'application/javascript' } });

    let config = null;
    try {
        const configObj = await env.MAIL_BUCKET.get(CONFIG_FILE);
        if (configObj) config = await configObj.json();
    } catch (e) {}

    if (!config) {
        if (url.pathname === '/setup' && method === 'POST') {
            const fd = await request.formData();
            await env.MAIL_BUCKET.put(CONFIG_FILE, JSON.stringify({
                username: fd.get('username'),
                password: await hashPassword(fd.get('password')),
                sessionToken: crypto.randomUUID()
            }));
            return Response.redirect(url.origin + '/login', 302);
        }
        return new Response(renderSetup(), { headers: { 'Content-Type': 'text/html' } });
    }

    if (url.pathname === '/login') {
        const siteKey = env.TURNSTILE_SITE_KEY || '';
        if (method === 'POST') {
            const fd = await request.formData();
            if (siteKey && env.TURNSTILE_SECRET_KEY) {
                const token = fd.get('cf-turnstile-response');
                const ip = request.headers.get('CF-Connecting-IP');
                const passed = await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, ip);
                if (!passed) return new Response(renderLogin("验证码校验失败，请重试", siteKey), { headers: { 'Content-Type': 'text/html' } });
            }
            if (fd.get('username') === config.username && await hashPassword(fd.get('password')) === config.password) {
                return new Response(null, {
                    status: 302,
                    headers: { 'Set-Cookie': `${SESSION_NAME}=${config.sessionToken}; HttpOnly; Secure; Path=/; Max-Age=2592000`, 'Location': '/' }
                });
            }
            return new Response(renderLogin("用户名或密码错误", siteKey), { headers: { 'Content-Type': 'text/html' } });
        }
        return new Response(renderLogin("", siteKey), { headers: { 'Content-Type': 'text/html' } });
    }

    if (cookies[SESSION_NAME] !== config.sessionToken) return Response.redirect(url.origin + '/login', 302);
    if (url.pathname === '/logout') return new Response(null, { status: 302, headers: { 'Set-Cookie': `${SESSION_NAME}=; Path=/; Max-Age=0`, 'Location': '/login' }});

    // --- API: Check New Mail ---
    if (url.pathname === '/api/check') {
        const list = await env.MAIL_BUCKET.list({ limit: 10 });
        const emails = list.objects.filter(o => o.key !== CONFIG_FILE && !o.key.startsWith(TRASH_PREFIX));
        // Sort same as list view
        emails.sort((a, b) => {
            const getTs = (k) => {
                const parts = k.replace(TRASH_PREFIX, '').split('_');
                return parts.length > 0 ? parseInt(parts[0]) : 0;
            };
            return getTs(b.key) - getTs(a.key);
        });
        const latest = emails.length > 0 ? (() => {
            const parts = emails[0].key.replace(TRASH_PREFIX, '').split('_');
            return parts.length > 0 ? parseInt(parts[0]) : 0;
        })() : 0;
        return new Response(JSON.stringify({ latest }), { headers: { 'Content-Type': 'application/json' } });
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
                            customMetadata: { isRead: action === 'mark_read' ? 'true' : 'false' }
                        });
                    }
                }
            }
        }
        return Response.redirect(request.headers.get('Referer') || '/', 302);
    }

    if (url.pathname.startsWith('/email/')) {
        let key = decodeURIComponent(url.pathname.replace('/email/', ''));
        let isTrash = false;
        let obj = await env.MAIL_BUCKET.get(key);
        if (!obj) {
            key = TRASH_PREFIX + key;
            obj = await env.MAIL_BUCKET.get(key);
            isTrash = true;
        }
        if (!obj) return Response.redirect(url.origin + '/', 302);

        if (!isTrash && obj.customMetadata?.isRead !== 'true') {
            const rawTextForUpdate = await obj.text();
            ctx.waitUntil(env.MAIL_BUCKET.put(key, rawTextForUpdate, { customMetadata: { isRead: 'true' } }));
            const email = processEmail(rawTextForUpdate);
             const senderName = (email.headers['from']?.split('<')[0] || 'Unknown').trim().replace(/"/g, '');
             const senderEmail = (email.headers['from']?.match(/<([^>]+)>/) || [])[1] || '';
             const initial = senderName[0]?.toUpperCase() || '?';
             const avatarColor = getAvatarColor(senderName);
             let attachmentsHtml = '';
             if (email.attachments.length > 0) {
                 attachmentsHtml = `
                 <div class="mb-6 bg-gray-50 border border-gray-200 rounded-xl p-4">
                     <div class="flex items-center text-sm font-semibold text-gray-700 mb-3">${Icons.attach} <span class="ml-2">附件 (${email.attachments.length})</span></div>
                     <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                         ${email.attachments.map(att => `
                             <div class="flex items-center justify-between bg-white p-3 rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
                                 <div class="flex items-center min-w-0 flex-1 mr-2"><div class="bg-indigo-100 text-indigo-600 rounded-md p-1.5 mr-3 flex-shrink-0"><svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg></div><div class="min-w-0"><p class="text-sm font-medium text-gray-900 truncate" title="${att.filename}">${att.filename}</p><p class="text-xs text-gray-500">${att.size}</p></div></div>
                                 ${att.data ? `<a href="${att.data}" download="${att.filename}" class="text-indigo-600 hover:text-indigo-800 p-2 hover:bg-indigo-50 rounded-full transition active:scale-95" title="下载">${Icons.download}</a>` : `<span class="text-xs text-gray-400">N/A</span>`}
                             </div>`).join('')}
                     </div>
                 </div>`;
             }
             const toolbar = isTrash ? `
                 <div class="flex items-center space-x-1 sm:space-x-2">
                     <form method="POST" action="/restore" onsubmit="return confirmSingle(event, '确定要恢复这封邮件吗？')">
                         <input type="hidden" name="key" value="${key}"><button class="flex items-center px-3 py-2 bg-green-50 text-green-700 hover:bg-green-100 rounded-lg text-sm font-medium transition whitespace-nowrap active:scale-[0.98]">${Icons.refresh} <span class="ml-1">恢复</span></button>
                     </form>
                     <form method="POST" action="/purge" onsubmit="return confirmSingle(event, '彻底删除后将无法恢复，确定吗？', true)">
                         <input type="hidden" name="key" value="${key}"><button class="flex items-center px-3 py-2 bg-red-50 text-red-700 hover:bg-red-100 rounded-lg text-sm font-medium transition whitespace-nowrap active:scale-[0.98]">${Icons.trash} <span class="ml-1">删除</span></button>
                     </form>
                 </div>` : `
                 <form method="POST" action="/delete" onsubmit="return confirmSingle(event, '确定要将这封邮件移入回收站吗？')"><input type="hidden" name="key" value="${key}"><button class="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors active:scale-95" title="移入回收站">${Icons.trash}</button></form>`;
             const html = `
             <div class="flex flex-col h-full bg-white md:rounded-xl md:shadow-lg overflow-hidden">
                 <div class="flex items-center justify-between px-3 py-3 sm:px-4 border-b border-gray-100 bg-white z-10 sticky top-0 shadow-sm"><div class="flex items-center"><a href="${isTrash ? '/trash' : '/'}" class="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-full transition-colors mr-1 active:scale-95">${Icons.back}</a></div>${toolbar}</div>
                 <div class="flex-1 overflow-y-auto custom-scrollbar"><div class="p-4 sm:p-8 max-w-4xl mx-auto safe-bottom">
                         <h1 class="text-xl sm:text-3xl font-bold text-gray-900 mb-5 leading-snug select-text break-words">${email.headers['subject'] || '(无主题)'}</h1>
                         <div class="flex items-start justify-between pb-6 border-b border-gray-100 mb-6"><div class="flex items-center overflow-hidden"><div class="w-10 h-10 sm:w-12 sm:h-12 ${avatarColor} rounded-full flex items-center justify-center text-white font-bold text-lg shadow-md flex-shrink-0">${initial}</div><div class="ml-3 sm:ml-4 min-w-0"><div class="font-semibold text-gray-900 text-sm sm:text-base select-text truncate">${senderName}</div><div class="text-xs sm:text-sm text-gray-500 select-text truncate">&lt;${senderEmail}&gt;</div></div></div><div class="text-xs sm:text-sm text-gray-400 whitespace-nowrap ml-2 mt-1">${new Date(obj.uploaded).toLocaleDateString('zh-CN', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}</div></div>
                         ${attachmentsHtml}<div class="email-body prose prose-sm sm:prose max-w-none text-gray-800 leading-relaxed select-text pt-2 break-words">${email.body}</div>
                 </div></div></div>`;
             return new Response(renderLayout(html, isTrash ? 'trash' : 'inbox'), { headers: { 'Content-Type': 'text/html' } });

        } else {
             const rawText = await obj.text();
             const email = processEmail(rawText);
             const senderName = (email.headers['from']?.split('<')[0] || 'Unknown').trim().replace(/"/g, '');
             const senderEmail = (email.headers['from']?.match(/<([^>]+)>/) || [])[1] || '';
             const initial = senderName[0]?.toUpperCase() || '?';
             const avatarColor = getAvatarColor(senderName);
             let attachmentsHtml = '';
             if (email.attachments.length > 0) {
                 attachmentsHtml = `
                 <div class="mb-6 bg-gray-50 border border-gray-200 rounded-xl p-4">
                     <div class="flex items-center text-sm font-semibold text-gray-700 mb-3">${Icons.attach} <span class="ml-2">附件 (${email.attachments.length})</span></div>
                     <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                         ${email.attachments.map(att => `
                             <div class="flex items-center justify-between bg-white p-3 rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
                                 <div class="flex items-center min-w-0 flex-1 mr-2"><div class="bg-indigo-100 text-indigo-600 rounded-md p-1.5 mr-3 flex-shrink-0"><svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg></div><div class="min-w-0"><p class="text-sm font-medium text-gray-900 truncate" title="${att.filename}">${att.filename}</p><p class="text-xs text-gray-500">${att.size}</p></div></div>
                                 ${att.data ? `<a href="${att.data}" download="${att.filename}" class="text-indigo-600 hover:text-indigo-800 p-2 hover:bg-indigo-50 rounded-full transition active:scale-95" title="下载">${Icons.download}</a>` : `<span class="text-xs text-gray-400">N/A</span>`}
                             </div>`).join('')}
                     </div>
                 </div>`;
             }
             const toolbar = isTrash ? `
                 <div class="flex items-center space-x-1 sm:space-x-2">
                     <form method="POST" action="/restore" onsubmit="return confirmSingle(event, '确定要恢复这封邮件吗？')">
                         <input type="hidden" name="key" value="${key}"><button class="flex items-center px-3 py-2 bg-green-50 text-green-700 hover:bg-green-100 rounded-lg text-sm font-medium transition whitespace-nowrap active:scale-[0.98]">${Icons.refresh} <span class="ml-1">恢复</span></button>
                     </form>
                     <form method="POST" action="/purge" onsubmit="return confirmSingle(event, '彻底删除后将无法恢复，确定吗？', true)">
                         <input type="hidden" name="key" value="${key}"><button class="flex items-center px-3 py-2 bg-red-50 text-red-700 hover:bg-red-100 rounded-lg text-sm font-medium transition whitespace-nowrap active:scale-[0.98]">${Icons.trash} <span class="ml-1">删除</span></button>
                     </form>
                 </div>` : `
                 <form method="POST" action="/delete" onsubmit="return confirmSingle(event, '确定要将这封邮件移入回收站吗？')"><input type="hidden" name="key" value="${key}"><button class="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors active:scale-95" title="移入回收站">${Icons.trash}</button></form>`;
             const html = `
             <div class="flex flex-col h-full bg-white md:rounded-xl md:shadow-lg overflow-hidden">
                 <div class="flex items-center justify-between px-3 py-3 sm:px-4 border-b border-gray-100 bg-white z-10 sticky top-0 shadow-sm"><div class="flex items-center"><a href="${isTrash ? '/trash' : '/'}" class="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-full transition-colors mr-1 active:scale-95">${Icons.back}</a></div>${toolbar}</div>
                 <div class="flex-1 overflow-y-auto custom-scrollbar"><div class="p-4 sm:p-8 max-w-4xl mx-auto safe-bottom">
                         <h1 class="text-xl sm:text-3xl font-bold text-gray-900 mb-5 leading-snug select-text break-words">${email.headers['subject'] || '(无主题)'}</h1>
                         <div class="flex items-start justify-between pb-6 border-b border-gray-100 mb-6"><div class="flex items-center overflow-hidden"><div class="w-10 h-10 sm:w-12 sm:h-12 ${avatarColor} rounded-full flex items-center justify-center text-white font-bold text-lg shadow-md flex-shrink-0">${initial}</div><div class="ml-3 sm:ml-4 min-w-0"><div class="font-semibold text-gray-900 text-sm sm:text-base select-text truncate">${senderName}</div><div class="text-xs sm:text-sm text-gray-500 select-text truncate">&lt;${senderEmail}&gt;</div></div></div><div class="text-xs sm:text-sm text-gray-400 whitespace-nowrap ml-2 mt-1">${new Date(obj.uploaded).toLocaleDateString('zh-CN', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}</div></div>
                         ${attachmentsHtml}<div class="email-body prose prose-sm sm:prose max-w-none text-gray-800 leading-relaxed select-text pt-2 break-words">${email.body}</div>
                 </div></div></div>`;
             return new Response(renderLayout(html, isTrash ? 'trash' : 'inbox'), { headers: { 'Content-Type': 'text/html' } });
        }
    }

    const isTrashPage = url.pathname === '/trash';
    if (url.pathname === '/' || isTrashPage) {
        const options = isTrashPage ? { prefix: TRASH_PREFIX, limit: 50, include: ['customMetadata'] } : { limit: 100, include: ['customMetadata'] };
        const list = await env.MAIL_BUCKET.list(options);
        const emails = list.objects.filter(o => o.key !== CONFIG_FILE).filter(o => isTrashPage ? true : !o.key.startsWith(TRASH_PREFIX));
        
        emails.sort((a, b) => {
            const getTs = (k) => {
                const parts = k.replace(TRASH_PREFIX, '').split('_');
                return parts.length > 0 ? parseInt(parts[0]) : 0;
            };
            return getTs(b.key) - getTs(a.key);
        });

        const listHtml = emails.map(e => {
            const fullKey = e.key;
            const displayKey = isTrashPage ? e.key.replace(TRASH_PREFIX, '') : e.key;
            const parts = displayKey.split('_');
            const senderRaw = parts.length > 1 ? parts[1] : 'Unknown';
            const senderName = senderRaw.includes('<') ? senderRaw.split('<')[0].replace(/"/g, '').trim() : senderRaw;
            const subjectRaw = parts.length > 2 ? parts.slice(2).join('_').replace('.eml', '') : displayKey;
            let subject = subjectRaw;
            try { subject = decodeURIComponent(subjectRaw).replace(/_/g, ' '); } catch(e){}
            const color = getAvatarColor(senderName);
            const timeStr = new Date(parseInt(parts[0])).toLocaleDateString('zh-CN', {month:'short', day:'numeric'});
            
            // Read Status Check
            const isRead = e.customMetadata?.isRead === 'true';
            const fontWeight = isRead ? 'font-normal' : 'font-semibold';
            const textColor = isRead ? 'text-gray-600' : 'text-gray-900';
            const dotHtml = !isRead && !isTrashPage ? `<span class="unread-dot"></span>` : '';

            return `
            <div class="group email-row block bg-white hover:bg-gray-50 border-b border-gray-100 transition-all cursor-pointer relative select-none" onclick="window.location.href='/email/${encodeURIComponent(displayKey)}'">
                <div class="px-3 sm:px-6 py-3 sm:py-4 flex items-center">
                    <div class="flex-shrink-0 mr-3 sm:mr-4 z-20 h-full flex items-center" onclick="event.stopPropagation()"><label class="custom-checkbox cursor-pointer flex items-center justify-center w-6 h-6 sm:w-5 sm:h-5"><input type="checkbox" name="keys" value="${fullKey}" class="hidden" onchange="updateRowStyle(this)"><div class="w-5 h-5 border-2 border-gray-300 rounded-md bg-white flex items-center justify-center transition-colors hover:border-indigo-400"><svg class="w-3 h-3 text-white hidden pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg></div></label></div>
                    <div class="flex-shrink-0 mr-3 sm:mr-5"><div class="w-10 h-10 ${color} rounded-full flex items-center justify-center text-white font-semibold text-sm shadow-sm">${senderName[0]?.toUpperCase()}</div></div>
                    <div class="min-w-0 flex-1 flex flex-col justify-center">
                        <div class="flex justify-between items-baseline mb-1">
                            <p class="text-sm sm:text-base ${fontWeight} ${isRead ? 'text-gray-900' : 'text-gray-900'} truncate mr-2">${dotHtml}${senderName}</p>
                            <p class="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">${timeStr}</p>
                        </div>
                        <p class="text-sm ${textColor} truncate leading-snug"><span class="${fontWeight}">${subject}</span></p>
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
            
        // Calculate latest timestamp for client-side polling
        let latestTimestamp = 0;
        if (emails.length > 0) {
             const parts = emails[0].key.replace(TRASH_PREFIX, '').split('_');
             latestTimestamp = parts.length > 0 ? parseInt(parts[0]) : 0;
        }

        const html = `
        <div class="flex flex-col h-full bg-white md:rounded-xl md:shadow-lg overflow-hidden">
            <div class="h-14 sm:h-16 px-3 sm:px-6 border-b border-gray-100 flex items-center justify-between bg-white shrink-0 z-20 sticky top-0 shadow-sm">
                <div class="flex items-center w-full">
                     <div class="mr-3 sm:mr-4 flex items-center"><button onclick="toggleMenu()" class="md:hidden mr-3 text-gray-500 p-1 -ml-2 rounded-full hover:bg-gray-100 active:scale-95">${Icons.menu}</button><label class="custom-checkbox cursor-pointer flex items-center justify-center w-6 h-6 sm:w-5 sm:h-5"><input type="checkbox" onclick="toggleAll(this)" class="hidden"><div class="w-5 h-5 border-2 border-gray-300 rounded-md bg-white flex items-center justify-center transition-colors hover:border-indigo-400"><svg class="w-3 h-3 text-white hidden pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg></div></label></div>
                    <div id="default-header" class="flex items-center justify-between w-full"><h1 class="text-lg sm:text-xl font-bold text-gray-800">${isTrashPage ? '回收站' : '收件箱'}</h1><button onclick="window.location.reload()" class="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-colors active:scale-95" title="刷新">${Icons.refresh}</button></div>
                    <div id="action-header" class="hidden flex items-center justify-between w-full"><span class="text-sm text-gray-600 font-medium whitespace-nowrap mr-2">已选 <span id="selected-count" class="text-indigo-600 font-bold">0</span></span><div class="flex items-center">${batchButtons}</div></div>
                </div>
            </div>
            <form id="batch-form" method="POST" action="/batch-action" class="flex-1 overflow-y-auto custom-scrollbar bg-white safe-bottom">${emails.length > 0 ? listHtml : emptyState}</form>
        </div>`;
        return new Response(renderLayout(html, isTrashPage ? 'trash' : 'inbox', latestTimestamp), { headers: { 'Content-Type': 'text/html' } });
    }
    return new Response("Not Found", { status: 404 });
}

export default {
    async fetch(request, env, ctx) {
        try { return await handleRequest(request, env, ctx); } 
        catch (e) { return new Response(`App Error: ${e.message}`, { status: 500 }); }
    },
    async email(message, env, ctx) {
        if (!env.MAIL_BUCKET) return;
        try {
            const subject = message.headers.get("subject") || "No_Subject";
            const from = message.from || "Unknown";
            const safeSubject = subject.replace(/[\/\\:*?"<>|\r\n]/g, "_").trim().substring(0, 60);
            const key = `${Date.now()}_${from}_${safeSubject}.eml`;
            const rawData = await new Response(message.raw).arrayBuffer();
            await env.MAIL_BUCKET.put(key, rawData);
        } catch (e) { console.error(e); }
    }
};
