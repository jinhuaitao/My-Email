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
// 分段翻译：单次请求塞太长会被模型截断，按段落切开分别翻再拼回去。
const TRANSLATE_CHUNK_SIZE = 2500;
const TRANSLATE_MAX_CHUNKS = 6;

// ==========================================
// 1. PWA & UI 资源
// ==========================================

// ---------- 品牌资产 ----------
//
// 登录页、初始化页、侧栏共用同一枚标记（一个信封），
// 避免「首次部署」与「日常登录」看起来像两个不同的产品。
// 图标本身是纯 SVG，不依赖任何图标字体或外部 CDN。

function brandMark(cls) {
    return '<svg viewBox="0 0 40 40" class="' + (cls || 'brand-mark') + '" aria-hidden="true" focusable="false">'
        + '<defs><linearGradient id="cfmailMark" x1="0" y1="0" x2="1" y2="1">'
        + '<stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#4338ca"/>'
        + '</linearGradient></defs>'
        + '<rect width="40" height="40" rx="12" fill="url(#cfmailMark)"/>'
        + '<rect x="8" y="11" width="24" height="18.5" rx="3.6" fill="#ffffff" opacity="0.96"/>'
        + '<path d="M9.6 13.4l9.2 7.2c0.7 0.55 1.7 0.55 2.4 0l9.2-7.2" fill="none" stroke="#4338ca" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg>';
}

// 复选框里的对勾。它必须能被 CSS 染色，所以不写死颜色。
const CHECK_MARK = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

// 样式表的版本号。改动 APP_CSS 时把它 +1，
// 页面引用的 /app.css?v=N 随之变化，浏览器就不会继续用旧缓存。
const UI_VERSION = 1;

// ---------- 设计系统 ----------
//
// 为什么不用 Tailwind CDN / Google Fonts：
//   1) cdn.tailwindcss.com 官方明确标注「仅供原型，不要用于生产」，且体积上百 KB；
//   2) 这两个域名在中国大陆网络下经常不可达，页面会长时间白屏或掉字体；
//   3) 邮件客户端最怕「首屏样式没到」——登录框裸露在屏幕上是最不专业的观感。
// 因此这里改成一份自包含的样式表：只写这个应用真正用到的组件，
// 体积约为 Tailwind 运行时的 1/20，且通过 /app.css?v=N 长缓存分发。
//
// 主题：所有颜色都走 CSS 变量，:root 是浅色，[data-theme="dark"] 覆盖成深色。
// 由 <head> 里的内联脚本在首帧之前把 data-theme 写到 <html> 上，所以不会闪一下白底。
const APP_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --r-xs:6px;--r-sm:9px;--r-md:12px;--r-lg:16px;--r-xl:22px;--r-full:999px;
  --sidebar-w:264px;--tabbar-h:58px;
  --ease:cubic-bezier(.16,1,.3,1);
  --t-fast:.14s var(--ease);--t:.22s var(--ease);
  color-scheme:light;
  --bg:#f4f5f7;
  --surface:#ffffff;
  --surface-2:#fafbfc;
  --surface-3:#f1f3f5;
  --border:#e7e9ee;
  --border-2:#d7dae1;
  --text:#0f172a;
  --text-2:#4b5563;
  --text-3:#67707f;
  --text-4:#8b93a3;
  --accent:#4f46e5;--accent-h:#4338ca;--accent-fg:#ffffff;
  --accent-soft:#eef2ff;--accent-soft-2:#e0e7ff;
  --danger:#dc2626;--danger-h:#b91c1c;--danger-fg:#ffffff;--danger-soft:#fef2f2;--danger-bd:#fbd5d5;
  --success:#047857;--success-fg:#ffffff;--success-soft:#ecfdf5;--success-bd:#c7f0e0;
  --warn:#b45309;--warn-soft:#fffbeb;--warn-bd:#fde9c8;
  --ring:0 0 0 3.5px rgba(79,70,229,.18);
  --sh-1:0 1px 2px rgba(15,23,42,.06);
  --sh-2:0 2px 6px rgba(15,23,42,.05),0 10px 26px -14px rgba(15,23,42,.18);
  --sh-3:0 24px 60px -18px rgba(15,23,42,.34);
  --scrim:rgba(15,23,42,.42);
  --hover:#f7f8fa;
  --sel:#eef2ff;
}
[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0d0f14;
  --surface:#151821;
  --surface-2:#1b1f29;
  --surface-3:#222732;
  --border:#272c38;
  --border-2:#3a4150;
  --text:#e9ecf3;
  --text-2:#b6bdcb;
  --text-3:#98a1b3;
  --text-4:#7b8496;
  --accent:#818cf8;--accent-h:#a5b4fc;--accent-fg:#0d0f14;
  --accent-soft:#1e2136;--accent-soft-2:#2b3050;
  --danger:#f87171;--danger-h:#fca5a5;--danger-fg:#1a0f0f;--danger-soft:#2a1a1c;--danger-bd:#4d272b;
  --success:#34d399;--success-fg:#04150f;--success-soft:#12271f;--success-bd:#1f4b39;
  --warn:#fbbf24;--warn-soft:#2a2213;--warn-bd:#4d3c17;
  --ring:0 0 0 3.5px rgba(129,140,248,.28);
  --sh-1:0 1px 2px rgba(0,0,0,.45);
  --sh-2:0 2px 6px rgba(0,0,0,.4),0 12px 32px -16px rgba(0,0,0,.7);
  --sh-3:0 24px 60px -18px rgba(0,0,0,.8);
  --scrim:rgba(0,0,0,.62);
  --hover:#1c212c;
  --sel:#242a45;
}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--font);background:var(--bg);color:var(--text);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
h1,h2,h3,h4,p,figure{margin:0}
a{color:var(--accent);text-decoration:none}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer;background:none;border:0;padding:0}
img{max-width:100%}
[hidden]{display:none!important}
*{scrollbar-width:thin;scrollbar-color:var(--border-2) transparent}
::-webkit-scrollbar{width:11px;height:11px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border-2);border-radius:99px;border:3.5px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:var(--text-4);background-clip:content-box}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip-link{position:fixed;top:8px;left:8px;z-index:100;transform:translateY(-200%);background:var(--surface);color:var(--text);padding:10px 16px;border-radius:var(--r-sm);box-shadow:var(--sh-2);font-size:13.5px;font-weight:600;transition:transform var(--t)}
.skip-link:focus{transform:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.ic{width:20px;height:20px;flex:none;display:block}
.spin{animation:cfspin .8s linear infinite}
@keyframes cfspin{to{transform:rotate(360deg)}}
@keyframes cffade{from{opacity:0}}
@keyframes cfpop{from{opacity:0;transform:translateY(8px) scale(.97)}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}
}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grow{flex:1;min-width:0}
.mono{font-family:var(--mono);font-size:.94em}
.muted{color:var(--text-3)}
// 按钮里的文字标签：窄屏（手机）只留图标，宽屏才把文字放出来。
// 名字容易写反 —— 旧名 .only-sm 读起来像「只在小屏显示」，实际是反过来（大屏才显示）。
.lbl-wide{display:none}
@media (min-width:640px){.lbl-wide{display:inline}}

/* ---------- 应用外壳 ---------- */
.app{display:flex;height:100vh;height:100dvh;overflow:hidden}
.sidebar{width:var(--sidebar-w);flex:none;display:none;flex-direction:column;background:var(--surface);border-right:1px solid var(--border);min-height:0}
@media (min-width:900px){.sidebar{display:flex}}
.main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative}
@media (min-width:900px){.main{padding:18px 18px 18px 0}}
@media (max-width:899px){.main{padding-bottom:calc(var(--tabbar-h) + env(safe-area-inset-bottom))}}
.panel{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--surface);overflow:hidden}
@media (min-width:900px){.panel{border-radius:var(--r-lg);border:1px solid var(--border);box-shadow:var(--sh-1)}}
.brand{display:flex;align-items:center;gap:11px;padding:0 18px;height:64px;border-bottom:1px solid var(--border);flex:none}
.brand-mark{width:34px;height:34px;flex:none;border-radius:10px}
.brand-name{font-size:16px;font-weight:650;letter-spacing:-.01em;line-height:1.2}
.brand-sub{font-size:11px;color:var(--text-3)}
.nav{padding:10px;display:flex;flex-direction:column;gap:2px;overflow-y:auto;flex:1;min-height:0}
.nav-item{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:var(--r-sm);color:var(--text-2);font-size:14.5px;font-weight:500;position:relative;transition:background var(--t-fast),color var(--t-fast)}
.nav-item:hover{background:var(--hover);color:var(--text)}
.nav-item.active{background:var(--accent-soft);color:var(--accent);font-weight:650}
.nav-item.active::before{content:"";position:absolute;left:-10px;top:50%;transform:translateY(-50%);width:3px;height:18px;border-radius:0 3px 3px 0;background:var(--accent)}
.nav-item.danger.active{background:var(--danger-soft);color:var(--danger)}
.nav-item.danger.active::before{background:var(--danger)}
.nav-item.logout{color:var(--danger)}
.nav-item.logout:hover{background:var(--danger-soft);color:var(--danger)}
.nav-badge{margin-left:auto;min-width:22px;height:20px;padding:0 7px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--r-full);background:var(--accent);color:var(--accent-fg);font-size:11.5px;font-weight:700;font-variant-numeric:tabular-nums}
.nav-foot{padding:10px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:10px;flex:none}
.nav-foot-label{font-size:11px;font-weight:650;color:var(--text-4);letter-spacing:.04em;padding:0 3px}
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:60;display:flex;background:var(--surface);border-top:1px solid var(--border);padding-bottom:env(safe-area-inset-bottom);height:calc(var(--tabbar-h) + env(safe-area-inset-bottom))}
@media (min-width:900px){.tabbar{display:none}}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:10.5px;font-weight:600;color:var(--text-3);position:relative;text-decoration:none}
.tab.active{color:var(--accent)}
.tab-badge{position:absolute;top:5px;left:50%;margin-left:5px;min-width:16px;height:16px;padding:0 4px;border-radius:var(--r-full);background:var(--accent);color:var(--accent-fg);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}

/* ---------- 顶栏 ---------- */
.topbar{flex:none;display:flex;align-items:center;gap:9px;padding:10px 12px;border-bottom:1px solid var(--border);background:var(--surface);min-height:60px;z-index:20}
@media (min-width:640px){.topbar{padding:10px 18px;min-height:64px}}
.topbar h1{font-size:17px;font-weight:650;letter-spacing:-.01em;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar-actions{margin-left:auto;display:flex;align-items:center;gap:6px;flex:none}
@media (max-width:639px){.topbar.selecting h1{display:none}}
.sel-count{font-size:13px;color:var(--text-2);white-space:nowrap}
.sel-count b{color:var(--accent);font-weight:700}

/* ---------- 按钮 ---------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:8px 13px;border-radius:var(--r-sm);font-size:13.5px;font-weight:600;border:1px solid transparent;white-space:nowrap;transition:background var(--t-fast),border-color var(--t-fast),color var(--t-fast),transform var(--t-fast),box-shadow var(--t-fast)}
.btn:active{transform:scale(.975)}
.btn:disabled{opacity:.55;cursor:not-allowed;transform:none}
.btn.primary{background:var(--accent);color:var(--accent-fg);box-shadow:0 1px 2px rgba(15,23,42,.12)}
.btn.primary:hover{background:var(--accent-h)}
.btn.danger{background:var(--danger);color:var(--danger-fg)}
.btn.danger:hover{background:var(--danger-h)}
.btn.ghost{background:transparent;color:var(--text-2);border-color:var(--border-2)}
.btn.ghost:hover{background:var(--hover);color:var(--text)}
.btn.soft{background:var(--accent-soft);color:var(--accent)}
.btn.soft:hover{background:var(--accent-soft-2)}
.btn.danger-soft{background:var(--danger-soft);color:var(--danger)}
.btn.danger-soft:hover{box-shadow:inset 0 0 0 1px var(--danger-bd)}
.btn.ok-soft{background:var(--success-soft);color:var(--success)}
.btn.ok-soft:hover{box-shadow:inset 0 0 0 1px var(--success-bd)}
.btn.solid-dark{background:var(--text);color:var(--surface)}
.btn.solid-dark:hover{opacity:.88}
.btn.block{width:100%}
.btn.lg{padding:12px 18px;font-size:15px;border-radius:var(--r-md)}
.iconbtn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:var(--r-sm);color:var(--text-3);flex:none;transition:background var(--t-fast),color var(--t-fast),transform var(--t-fast)}
.iconbtn:hover{background:var(--hover);color:var(--text)}
.iconbtn:active{transform:scale(.94)}
.iconbtn.danger:hover{background:var(--danger-soft);color:var(--danger)}

/* ---------- 表单 ---------- */
.stack{display:flex;flex-direction:column;gap:16px}
.stack.tight{gap:12px}
.settings-actions{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.pw-grid{display:grid;grid-template-columns:1fr;gap:12px}
@media (min-width:700px){.pw-grid{grid-template-columns:1fr 1fr 1fr}}
.field{display:flex;flex-direction:column;gap:6px;min-width:0}
.label{font-size:12.5px;font-weight:650;color:var(--text-2)}
.input{width:100%;padding:11px 13px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:var(--r-sm);font-size:14.5px;transition:border-color var(--t-fast),box-shadow var(--t-fast),background var(--t-fast)}
.input::placeholder{color:var(--text-4)}
.input:hover{border-color:var(--text-4)}
.input:focus{outline:none;background:var(--surface);border-color:var(--accent);box-shadow:var(--ring)}
.input-wrap{position:relative;display:flex;align-items:center}
.input-wrap .lead{position:absolute;left:12px;color:var(--text-4);pointer-events:none;display:flex}
.input-wrap .input.has-lead{padding-left:41px}
.input-wrap .trail{position:absolute;right:5px;display:flex}
.input-wrap .trail .iconbtn{width:30px;height:30px}
.hint{font-size:12px;color:var(--text-3);line-height:1.55}
.hint.warn{color:var(--warn)}
.hint.bad{color:var(--danger)}
.hint.ok{color:var(--success)}

/* ---------- 卡片 / 徽章 / 提示条 ---------- */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:16px}
.card-danger{border-color:var(--danger-bd)}
.card-head{display:flex;align-items:center;gap:10px;justify-content:space-between;margin-bottom:5px}
.card-head h2{font-size:14.5px;font-weight:650}
.card-desc{font-size:12.5px;color:var(--text-3);line-height:1.65;margin-bottom:12px}
.card-desc:last-child{margin-bottom:0}
.badge{display:inline-flex;align-items:center;gap:5px;padding:2.5px 8px;border-radius:var(--r-xs);border:1px solid var(--border);font-size:11.5px;font-weight:650;white-space:nowrap;background:var(--surface-3);color:var(--text-3)}
.badge.ok{background:var(--success-soft);color:var(--success);border-color:var(--success-bd)}
.badge.info{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-soft-2)}
.badge.warn{background:var(--warn-soft);color:var(--warn);border-color:var(--warn-bd)}
.badge .ic{width:14px;height:14px}
.alert{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:var(--r-sm);font-size:13.5px;line-height:1.6;border:1px solid;margin-bottom:16px}
.alert:last-child{margin-bottom:0}
.alert .ic{margin-top:1px;width:18px;height:18px}
.alert.error{background:var(--danger-soft);color:var(--danger);border-color:var(--danger-bd)}
.alert.ok{background:var(--success-soft);color:var(--success);border-color:var(--success-bd)}
.alert.info{background:var(--accent-soft);color:var(--accent);border-color:var(--accent-soft-2)}
.alert.plain{background:var(--surface-3);color:var(--text-2);border-color:var(--border)}
.note{display:flex;gap:8px;margin-top:12px;padding:10px 12px;border-radius:var(--r-sm);background:var(--surface-3);color:var(--text-3);font-size:12.5px;line-height:1.65}
.seg{display:flex;gap:2px;padding:3px;background:var(--surface-3);border-radius:var(--r-sm)}
.seg-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:7px 6px;border-radius:7px;font-size:12.5px;font-weight:600;color:var(--text-3);transition:background var(--t-fast),color var(--t-fast),box-shadow var(--t-fast)}
.seg-btn:hover{color:var(--text)}
.seg-btn[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:var(--sh-1)}
.avatar{display:inline-flex;align-items:center;justify-content:center;border-radius:var(--r-full);color:#fff;font-weight:650;letter-spacing:.02em;flex:none;user-select:none}
.avatar.md{width:40px;height:40px;font-size:15px}
.avatar.lg{width:46px;height:46px;font-size:17px}
.av-0{background:linear-gradient(140deg,#6366f1,#4338ca)}
.av-1{background:linear-gradient(140deg,#f97316,#ea580c)}
.av-2{background:linear-gradient(140deg,#0ea5e9,#0369a1)}
.av-3{background:linear-gradient(140deg,#10b981,#047857)}
.av-4{background:linear-gradient(140deg,#ec4899,#be185d)}
.av-5{background:linear-gradient(140deg,#8b5cf6,#6d28d9)}
.av-6{background:linear-gradient(140deg,#14b8a6,#0f766e)}
.av-7{background:linear-gradient(140deg,#f59e0b,#b45309)}

/* ---------- 搜索 ---------- */
.searchbar{flex:none;display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);background:var(--surface)}
@media (min-width:640px){.searchbar{padding:10px 18px}}
.searchbar .input-wrap{flex:1;min-width:0}
.searchbar .input{padding:9px 12px 9px 38px;font-size:14px;border-radius:var(--r-sm)}
.searchbar .lead{left:11px}
kbd{font-family:var(--mono);font-size:11px;padding:1.5px 5px;border-radius:5px;border:1px solid var(--border-2);background:var(--surface-2);color:var(--text-3)}

/* ---------- 邮件列表 ---------- */
.listwrap{flex:1;min-height:0;overflow-y:auto;overscroll-behavior-y:contain;background:var(--surface);-webkit-overflow-scrolling:touch}
.rowlist-meta{padding:8px 12px;font-size:11.5px;color:var(--text-3);border-bottom:1px solid var(--border);background:var(--surface-2)}
@media (min-width:640px){.rowlist-meta{padding:8px 18px}}
.daysep{position:sticky;top:0;z-index:5;padding:7px 12px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:11.5px;font-weight:700;color:var(--text-3);letter-spacing:.02em}
@media (min-width:640px){.daysep{padding:7px 18px}}
.row{position:relative;display:flex;align-items:center;gap:12px;padding:11px 12px 11px 0;border-bottom:1px solid var(--border);cursor:pointer;background:var(--surface);transition:background var(--t-fast)}
@media (min-width:640px){.row{padding:13px 18px 13px 0}}
.row:hover{background:var(--hover)}
.row.sel{background:var(--sel)}
.row.unread::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent)}
.row-check{flex:none;display:flex;padding:0 2px 0 12px}
@media (min-width:640px){.row-check{padding-left:18px}}
.check{position:relative;display:inline-flex;width:18px;height:18px;flex:none}
.check input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1}
.check .box{width:18px;height:18px;border:1.5px solid var(--border-2);border-radius:5px;background:var(--surface);display:flex;align-items:center;justify-content:center;transition:background var(--t-fast),border-color var(--t-fast),box-shadow var(--t-fast)}
.check .box svg{width:12px;height:12px;stroke:var(--accent-fg);stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round;opacity:0}
.check input:checked+.box{background:var(--accent);border-color:var(--accent)}
.check input:checked+.box svg{opacity:1}
.check input:indeterminate+.box{background:var(--accent);border-color:var(--accent)}
.check input:focus-visible+.box{box-shadow:var(--ring)}
.row-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.row-top{display:flex;align-items:baseline;gap:10px}
.row-from{font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.row.unread .row-from{font-weight:650}
.row-time{font-size:11.5px;color:var(--text-3);white-space:nowrap;flex:none;font-variant-numeric:tabular-nums}
.row-subj{font-size:13.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row.unread .row-subj{color:var(--text)}
.dot{width:7px;height:7px;border-radius:var(--r-full);background:var(--accent);display:inline-block;margin-right:7px;vertical-align:1px}
.row-acts{flex:none;display:flex;align-items:center;gap:1px;opacity:0;transition:opacity var(--t-fast)}
.row:hover .row-acts,.row:focus-within .row-acts{opacity:1}
@media (hover:none){.row-acts{display:none}}
.loadmore{padding:18px;text-align:center}

/* ---------- 空状态 ---------- */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px 24px;gap:3px}
.empty-ic{width:60px;height:60px;border-radius:var(--r-full);display:flex;align-items:center;justify-content:center;background:var(--surface-3);color:var(--text-4);margin-bottom:10px}
.empty-ic .ic{width:26px;height:26px}
.empty h3{font-size:15px;font-weight:650}
.empty p{font-size:13px;color:var(--text-3);max-width:32em;line-height:1.6}

/* ---------- 邮件详情 ---------- */
.doc{flex:1;min-height:0;overflow-y:auto;overscroll-behavior-y:contain;background:var(--surface)}
.doc-inner{max-width:860px;margin:0 auto;padding:20px 16px 44px}
@media (min-width:640px){.doc-inner{padding:26px 32px 56px}}
.subject{font-size:21px;font-weight:700;line-height:1.35;letter-spacing:-.015em;word-break:break-word}
@media (min-width:640px){.subject{font-size:26px}}
.sender{display:flex;align-items:flex-start;gap:12px;padding:16px 0 18px;border-bottom:1px solid var(--border);margin-bottom:20px}
.sender-name{font-size:14px;font-weight:650}
.sender-mail{display:flex;align-items:center;gap:2px;font-size:12.5px;color:var(--text-3);min-width:0}
.sender-mail a{color:var(--text-3);word-break:break-all}
.sender-mail a:hover{color:var(--accent)}
.sender-mail .iconbtn{width:26px;height:26px}
.sender-mail .iconbtn .ic{width:15px;height:15px}
.sender-time{font-size:12px;color:var(--text-3);white-space:nowrap;margin-left:auto;padding-top:2px;font-variant-numeric:tabular-nums}
.attach{border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;margin-bottom:20px}
.attach-head{display:flex;align-items:center;gap:8px;padding:10px 13px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:12.5px;font-weight:650;color:var(--text-2)}
.attach-head .ic{width:16px;height:16px}
.attach-grid{display:grid;grid-template-columns:1fr;gap:1px;background:var(--border)}
@media (min-width:560px){.attach-grid{grid-template-columns:1fr 1fr}}
@media (min-width:900px){.attach-grid{grid-template-columns:1fr 1fr 1fr}}
.attach-item{display:flex;align-items:center;gap:11px;padding:11px 13px;background:var(--surface);min-width:0;transition:background var(--t-fast)}
.attach-item:hover{background:var(--hover)}
.attach-ic{width:34px;height:34px;border-radius:var(--r-sm);display:flex;align-items:center;justify-content:center;background:var(--accent-soft);color:var(--accent);flex:none}
.attach-ic .ic{width:17px;height:17px}
.attach-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attach-size{font-size:11.5px;color:var(--text-3)}
.frame-wrap{position:relative;border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;background:#fff}
#mail-frame{width:100%;border:0;display:block;background:#fff}
.frame-load{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:9px;color:#8b93a3;font-size:13px;background:#fff}
.frame-load .ic{width:17px;height:17px}
.translated{background:var(--accent-soft);border:1px solid var(--accent-soft-2);border-radius:var(--r-md);padding:16px;white-space:pre-wrap;word-break:break-word;font-size:15px;line-height:1.75;color:var(--text)}
.toolbar-inline{display:flex;gap:8px;margin-top:12px}

/* ---------- 对话框 ---------- */
.modal{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:18px}
.modal-scrim{position:absolute;inset:0;background:var(--scrim);backdrop-filter:blur(3px);animation:cffade .18s var(--ease)}
.modal-card{position:relative;width:100%;max-width:384px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--sh-3);padding:22px;text-align:center;animation:cfpop .22s var(--ease)}
.modal-ic{width:46px;height:46px;border-radius:var(--r-full);display:flex;align-items:center;justify-content:center;margin:0 auto 13px;background:var(--accent-soft);color:var(--accent)}
.modal-ic.danger{background:var(--danger-soft);color:var(--danger)}
.modal-ic .ic{width:22px;height:22px}
.modal-card h3{font-size:16px;font-weight:650;margin-bottom:6px}
.modal-card p{font-size:13.5px;color:var(--text-2);line-height:1.65;margin-bottom:20px}
.modal-actions{display:flex;gap:9px}
.modal-actions .btn{flex:1}
body.modal-open{overflow:hidden}

/* ---------- 浮层提示 ---------- */
.toast-region{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(18px + env(safe-area-inset-bottom));z-index:90;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:max-content;max-width:calc(100vw - 32px)}
@media (max-width:899px){.toast-region{bottom:calc(var(--tabbar-h) + 16px + env(safe-area-inset-bottom))}}
.toast{display:flex;align-items:center;gap:9px;padding:11px 16px;border-radius:var(--r-full);background:var(--text);color:var(--surface);font-size:13.5px;font-weight:600;box-shadow:var(--sh-3);animation:cfpop .22s var(--ease);transition:opacity .2s,transform .2s}
.toast .ic{width:17px;height:17px}
.toast.ok{background:var(--success);color:var(--success-fg)}
.toast.err{background:var(--danger);color:var(--danger-fg)}

/* ---------- 登录 / 初始化 ---------- */
.auth{min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(1100px 560px at 50% -12%,var(--accent-soft),transparent 62%),var(--bg)}
.auth-card{width:100%;max-width:404px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-xl);box-shadow:var(--sh-2);overflow:hidden}
.auth-body{padding:30px 28px 26px}
.auth-head{text-align:center;margin-bottom:22px}
.auth-mark{width:52px;height:52px;border-radius:15px;margin:0 auto 16px;display:block;box-shadow:0 12px 28px -12px rgba(79,70,229,.75)}
.auth-head h1{font-size:21px;font-weight:700;letter-spacing:-.015em}
.auth-sub{font-size:13.5px;color:var(--text-3);margin-top:6px;line-height:1.6}
.auth-foot{padding:13px;text-align:center;border-top:1px solid var(--border);background:var(--surface-2);font-size:11.5px;color:var(--text-3)}
.auth-form{display:flex;flex-direction:column;gap:16px}
.turnstile-wrap{display:flex;justify-content:center;padding-top:2px}
@media (max-width:420px){.auth-body{padding:26px 20px 22px}}
`;

// ---------- 主题引导 ----------
//
// 必须内联在 <head> 里、并且早于样式表求值：
// 这样 <html data-theme> 在首帧之前就定好了，深色系统下不会先闪一下白底。
// 用户显式选过 light/dark 就用他的选择，否则跟随系统；选择存在 localStorage，不上传服务器。
const THEME_BOOT = '<script>(function(){'
    + 'var K="cfmail-theme",s=null;'
    + 'try{s=localStorage.getItem(K)}catch(e){}'
    + 'var mq=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null;'
    + 'function r(){return (s==="light"||s==="dark")?s:((mq&&mq.matches)?"dark":"light")}'
    + 'function a(){document.documentElement.setAttribute("data-theme",r())}'
    + 'a();'
    + 'if(mq){try{mq.addEventListener("change",function(){if(s!=="light"&&s!=="dark")a()})}catch(e){}}'
    + 'window.__cfmailTheme={'
    + 'mode:function(){return s||"auto"},'
    + 'set:function(v){s=(v==="light"||v==="dark")?v:null;'
    + 'try{if(s)localStorage.setItem(K,s);else localStorage.removeItem(K)}catch(e){}'
    + 'a();if(window.__cfmailSyncTheme)window.__cfmailSyncTheme()}};'
    + '})();<\/script>';

const renderAppIcon = () => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="cfmailLogo" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#4338ca"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="152" fill="url(#cfmailLogo)"/>
  <rect x="104" y="140" width="304" height="232" rx="46" fill="#ffffff" opacity="0.96"/>
  <path d="M126 174l111 87c11 8.6 27 8.6 38 0l111-87" fill="none" stroke="#4338ca" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const renderManifest = () => JSON.stringify({
    name: "CF Mail · Cloudflare 邮箱",
    short_name: "CF Mail",
    description: "基于 Cloudflare Workers 的无服务器网页邮箱",
    lang: "zh-CN",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    background_color: "#ffffff",
    theme_color: "#4f46e5",
    orientation: "portrait-primary",
    categories: ["productivity", "utilities"],
    icons: [
        { src: "/logo.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: "/logo.svg", sizes: "192x192", type: "image/svg+xml" },
        { src: "/logo.svg", sizes: "512x512", type: "image/svg+xml" }
    ]
});

// Service Worker：只做两件事 —— 立即接管，以及缓存两枚不会变的静态资源。
//
// 刻意**不**缓存任何 HTML：本站所有页面都是「已登录才可见」的私人数据，
// 缓存它们意味着退出登录后仍可能从缓存里翻出邮件。静态资源则相反，值得缓存。
const SW_STATIC = ['/logo.svg', '/manifest.json'];

const renderServiceWorker = () => `
var STATIC = ${JSON.stringify(SW_STATIC)};
self.addEventListener('install', function (e) {
    self.skipWaiting();
    e.waitUntil(caches.open('cfmail-static').then(function (c) { return c.addAll(STATIC); }).catch(function () {}));
});
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
    var req = e.request;
    if (req.method !== 'GET') return;
    var url;
    try { url = new URL(req.url); } catch (err) { return; }
    if (url.origin !== self.location.origin) return;
    if (STATIC.indexOf(url.pathname) === -1) return;
    e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req); }));
});
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

// 抢救「没做 RFC 2047 编码、直接塞 UTF-8 原始字节」的头部。
//
// 有些发信程序（国内 CMS、PHP mail()、部分监控告警系统）不把中文主题编码成
//     Subject: =?UTF-8?B?6ZW/6YKu5Lu2?=
// 而是直接写原始字节
//     Subject: <E9 95 BF E9 82 AE E4 BB B6>
// 这不合规，但真实存在。邮件本体被 bufferToBinaryString 逐字节读成单字节字符后，
// 显示出来就是「é•¿é‚®ä»¶」这种乱码 —— 看起来像坏数据，其实是完好的 UTF-8 被当成了单字节字符集。
// Gmail / Outlook 都会在这里按 UTF-8 兜一次，这里做同样的事。
//
// 同一条路还能治另一个高频错误：发信方把 UTF-8 字节**错标**成 ISO-8859-1
//     Subject: =?ISO-8859-1?B?6ZW/6YKu5Lu2?=
// 解出来同样是单字节乱码，形状完全一致。
//
// ⚠️ 判定单字节时必须同时认 windows-1252 的「高位区映射」：
//    WHATWG 编码规范把 iso-8859-1 这个标签别名到了 windows-1252，字节 0x80–0x9F
//    解出来是 € ‚ ƒ „ … † ‡ ˆ ‰ Š ‹ Œ Ž ‘ ’ “ ” • – — ˜ ™ š › œ ž Ÿ 这些**大于 0xFF** 的字符。
//    只按「charCode ≤ 0xFF」判断会漏掉一大片（UTF-8 的 E9 95 BF 里，0x95 就变成了 U+2022 •），
//    于是乱码原样留在页面上。
//
// 三道门必须同时通过，避免误伤真正的西欧文本（例如 "Café"）：
//   ① 每个字符都能映射回**单个字节**（直接落在 0x00–0xFF，或命中 windows-1252 高位区反查表）；
//   ② 拼回的字节流用 **fatal 模式** 按 UTF-8 解码必须成功。真正的 Latin-1 / windows-1252 文本
//      几乎必然失败：'é' 是单字节 0xE9，后面还得跟两个 0x80–0xBF 的续字节，而 "Café" 里
//      0xE9 后面是串尾 → 抛错 → 保持原样；
//   ③ 解出的结果里，非 ASCII 字符 ≥ 2 个，或存在码点 > U+07FF 的字符（即用到了 3 字节及以上的
//      UTF-8 序列）。这一条挡的是「两个字节恰好凑成一个合法 UTF-8 字符」的巧合（如 "Ã©"→"é"）：
//      宁可留一个明显坏掉的字符，也不要因为猜错把一个本来正确的字符改坏。
//
// 注意这里**不猜 GBK**：GBK 字节流不具自校验性，任意字节序列都能解出「像那么回事」的汉字，
// 猜错比乱码更糟（乱码至少一眼看得出是坏的）。没有声明字符集的原始字节，只认 UTF-8。
const WIN1252_HIGH = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
    0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
    0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F
};

function salvageUtf8Bytes(text) {
    if (!text) return text;
    const bytes = new Uint8Array(text.length);
    let hasHighByte = false;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        let b;
        if (c < 0x80) {
            b = c;
        } else if (c <= 0xFF) {
            b = c;                                   // 直接落在单字节区
            hasHighByte = true;
        } else if (Object.prototype.hasOwnProperty.call(WIN1252_HIGH, c)) {
            b = WIN1252_HIGH[c];                     // windows-1252 高位区反查
            hasHighByte = true;
        } else {
            return text;                             // ① 存在无法还原成单字节的字符 → 不是这种乱码
        }
        bytes[i] = b;
    }
    if (!hasHighByte) return text;                   // 纯 ASCII，无事可做

    let decoded;
    try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);   // ②
    } catch (e) {
        return text;
    }

    let wide = 0;
    let hasThreeByte = false;
    for (const ch of decoded) {
        const cp = ch.codePointAt(0);
        if (cp > 0xFF) wide++;
        if (cp > 0x7FF) hasThreeByte = true;
    }
    return (wide >= 2 || hasThreeByte) ? decoded : text;                     // ③
}

function decodeHeaderValue(text) {
    return salvageUtf8Bytes(decodeHeaderValueRaw(text));
}

// 还原原始字节之前的所有解码步骤。拆成两层是为了让「UTF-8 字节抢救」成为**最后**一道工序 ——
// 上面几条分支都可能产出单字节乱码：最典型的是发信方把 UTF-8 字节错标成 ISO-8859-1
// （=?ISO-8859-1?B?6ZW/6YKu5Lu2?=），解出来正好是 U+0080–U+00FF 区间，同样需要抢救。
function decodeHeaderValueRaw(text) {
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

// 头像底色。返回的是 CSS 类名（.av-0 ~ .av-7），不是 Tailwind 调色板 ——
// 调色板挪进了设计系统，这样浅色 / 深色两套主题下的对比度都能统一控制。
function getAvatarColor(name) {
    let hash = 0;
    const cleanName = name || '?';
    for (let i = 0; i < cleanName.length; i++) hash = cleanName.charCodeAt(i) + ((hash << 5) - hash);
    return 'av-' + (Math.abs(hash) % 8);
}

// ==========================================
// 3. UI 渲染与滚动修复
// ==========================================

// 图标集。
//
// 全部按 24 网格、1.75 描边统一绘制，尺寸交给 CSS 的 .ic 控制，
// 这样按钮、列表、卡片里的图标粗细与视觉重量天然一致
// （旧版混用 w-5/w-6 与两套 stroke-width，并排放就会显得不齐）。
// 纯内联 SVG：不引图标字体、不引 sprite 文件，离线可用。
const _ic = (paths) => '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths + '</svg>';

const Icons = {
    inbox: _ic('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    trash: _ic('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
    refresh: _ic('<path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.36 2.64L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.36-2.64L3 16"/><path d="M3 21v-5h5"/>'),
    restore: _ic('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
    logout: _ic('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>'),
    back: _ic('<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>'),
    attach: _ic('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
    file: _ic('<path d="M14 3v5h5"/><path d="M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>'),
    image: _ic('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="M21 15l-4.5-4.5L7 20"/>'),
    download: _ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'),
    user: _ic('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    lock: _ic('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    alert: _ic('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    mailOpen: _ic('<path d="M22 9 12 15 2 9"/><path d="M2 9.6 12 4l10 5.6V19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>'),
    mail: _ic('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'),
    gear: _ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    translate: _ic('<path d="M4 5h10"/><path d="M9 3v2"/><path d="M11.5 15.5 8 8l-3.5 7.5"/><path d="M5.5 13h5"/><path d="M14 20l4-9 4 9"/><path d="M15.5 17h5"/>'),
    search: _ic('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    check: _ic('<path d="M20 6 9 17l-5-5"/>'),
    copy: _ic('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    sun: _ic('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
    moon: _ic('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
    auto: _ic('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    eye: _ic('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
    eyeOff: _ic('<path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.4 0 10 7 10 7a17 17 0 0 1-2.16 3.19M6.6 6.6A17 17 0 0 0 2 11s3.6 7 10 7a9.3 9.3 0 0 0 5.4-1.6"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/><path d="M2 2l20 20"/>'),
    shield: _ic('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
    spinner: '<svg class="ic spin" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity=".22"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>'
};

const renderLayout = (content, activePage = 'inbox', latestTimestamp = 0, opts = {}) => {
    const o = opts || {};
    const docTitle = o.title ? escapeHtml(o.title) + ' · CF Mail' : 'CF Mail';
    const unreadCount = Number(o.unreadCount) || 0;
    const navBadge = unreadCount > 0
        ? '<span class="nav-badge">' + (unreadCount > 999 ? '999+' : unreadCount) + '</span>'
        : '';
    const tabBadge = unreadCount > 0
        ? '<span class="tab-badge">' + (unreadCount > 99 ? '99+' : unreadCount) + '</span>'
        : '';

    // 导航项。aria-current 让读屏软件知道「你在哪一页」，
    // 左侧那条竖线（.nav-item.active::before）是给眼睛看的同一件事。
    const navItem = (page, href, label, icon, extraClass) =>
        '<a href="' + href + '" class="nav-item' + (extraClass ? ' ' + extraClass : '') + (activePage === page ? ' active' : '') + '"'
        + (activePage === page ? ' aria-current="page"' : '') + '>'
        + icon + '<span>' + label + '</span>' + (page === 'inbox' ? navBadge : '') + '</a>';

    const tabItem = (page, href, label, icon) =>
        '<a href="' + href + '" class="tab' + (activePage === page ? ' active' : '') + '"'
        + (activePage === page ? ' aria-current="page"' : '') + '>'
        + icon + '<span>' + label + '</span>' + (page === 'inbox' ? tabBadge : '') + '</a>';

    // 主题选择器。浅色 / 深色 / 跟随系统三档显式可选，
    // 比一个「点一下转一圈」的图标按钮更容易理解，也不用猜现在是哪一档。
    const themeSeg = '<div class="seg" role="group" aria-label="外观主题">'
        + '<button type="button" class="seg-btn" data-theme-opt="light" aria-pressed="false">' + Icons.sun + '<span>浅色</span></button>'
        + '<button type="button" class="seg-btn" data-theme-opt="dark" aria-pressed="false">' + Icons.moon + '<span>深色</span></button>'
        + '<button type="button" class="seg-btn" data-theme-opt="auto" aria-pressed="false">' + Icons.auto + '<span>系统</span></button>'
        + '</div>';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${docTitle}</title>
${THEME_BOOT}
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d0f14" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="apple-touch-icon" href="/logo.svg">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="CF Mail">
<link rel="stylesheet" href="/app.css?v=${UI_VERSION}">
</head>
<body>
<a class="skip-link" href="#main">跳到主要内容</a>
<div class="app">
    <aside class="sidebar" id="sidebar">
        <div class="brand">
            ${brandMark()}
            <div class="grow">
                <div class="brand-name">CF Mail</div>
                <div class="brand-sub">Cloudflare Workers 邮箱</div>
            </div>
        </div>
        <nav class="nav" aria-label="主导航">
            ${navItem('inbox', '/', '收件箱', Icons.inbox)}
            ${navItem('trash', '/trash', '已删除', Icons.trash, 'danger')}
            ${navItem('settings', '/settings', '设置', Icons.gear)}
        </nav>
        <div class="nav-foot">
            <div class="nav-foot-label">外观</div>
            ${themeSeg}
            <a href="/logout" class="nav-item logout">${Icons.logout}<span>退出登录</span></a>
        </div>
    </aside>
    <main class="main" id="main" tabindex="-1">${content}</main>
</div>
<nav class="tabbar" aria-label="页面切换">
    ${tabItem('inbox', '/', '收件箱', Icons.inbox)}
    ${tabItem('trash', '/trash', '已删除', Icons.trash)}
    ${tabItem('settings', '/settings', '设置', Icons.gear)}
</nav>
<div class="modal" id="modal-backdrop" hidden>
    <div class="modal-scrim" data-modal-close></div>
    <div class="modal-card" id="modal-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-msg">
        <div class="modal-ic" id="modal-icon">${Icons.alert}</div>
        <h3 id="modal-title"></h3>
        <p id="modal-msg"></p>
        <div class="modal-actions">
            <button type="button" class="btn ghost" data-modal-close>取消</button>
            <button type="button" class="btn primary" id="modal-confirm-btn">确定</button>
        </div>
    </div>
</div>
<div class="toast-region" id="toast-region" role="status" aria-live="polite"></div>
<script>
(function () {
    'use strict';
    var LATEST_TS = ${latestTimestamp};
    var DANGER = 'danger';

    function $(id) { return document.getElementById(id); }

    // 注册 Service Worker（用于缓存 logo / manifest 这类静态资源，不缓存任何邮件页面）。
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(function () {});
    }

    /* ---------- 时间 ---------- */
    // 一律在客户端按用户本地时区格式化。Workers 运行时是 UTC，
    // 在服务端 toLocaleDateString 会让中国用户看到整整差 8 小时的日期。
    function formatTs(ts, full) {
        var d = new Date(ts), now = new Date();
        function pad(n) { return String(n).padStart(2, '0'); }
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        if (full) return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
        if (d.toDateString() === now.toDateString()) return hm;
        if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
        return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }

    function hydrateTimes() {
        var nodes = document.querySelectorAll('time[data-ts]');
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var ts = parseInt(el.getAttribute('data-ts'), 10);
            if (!(ts > 0)) continue;
            el.textContent = formatTs(ts, el.getAttribute('data-fmt') === 'full');
            if (!el.title) el.title = formatTs(ts, true);
        }
    }

    /* ---------- 日期分组 ---------- */
    // 列表按「今天 / 昨天 / 本周 / 更早」分组。分组必须在浏览器里算 ——
    // 服务端只知道 UTC，跨时区算出来的「今天」是错的。
    function dayLabel(ts) {
        var d = new Date(ts), n = new Date();
        var today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
        var that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        var diff = Math.round((today - that) / 86400000);
        if (diff <= 0) return '今天';
        if (diff === 1) return '昨天';
        if (diff < 7) return '本周';
        if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + '月';
        return d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
    }

    function groupDays() {
        var wrap = $('list-wrap');
        if (!wrap) return;
        var rows = wrap.querySelectorAll('.row');
        var cur = null;
        for (var i = 0; i < rows.length; i++) {
            var ts = parseInt(rows[i].getAttribute('data-ts') || '0', 10);
            var key = ts > 0 ? String(new Date(ts).toDateString()) : 'unknown';
            if (key === cur) continue;
            cur = key;
            var sep = document.createElement('div');
            sep.className = 'daysep';
            sep.textContent = ts > 0 ? dayLabel(ts) : '日期未知';
            wrap.insertBefore(sep, rows[i]);
        }
    }

    /* ---------- 主题 ---------- */
    function syncTheme() {
        var mode = window.__cfmailTheme ? window.__cfmailTheme.mode() : 'auto';
        var nodes = document.querySelectorAll('[data-theme-opt]');
        for (var i = 0; i < nodes.length; i++) {
            var on = nodes[i].getAttribute('data-theme-opt') === mode;
            nodes[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }
    window.__cfmailSyncTheme = syncTheme;

    /* ---------- 浮层提示 ---------- */
    function toast(msg, kind) {
        var region = $('toast-region');
        if (!region) return;
        var el = document.createElement('div');
        el.className = 'toast' + (kind ? ' ' + kind : '');
        el.textContent = msg;
        region.appendChild(el);
        setTimeout(function () {
            el.style.opacity = '0';
            el.style.transform = 'translateY(6px)';
            setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
        }, 3200);
    }
    window.cfToast = toast;
    window.cfCopyText = copyText;

    /* ---------- 对话框 ---------- */
    // 用真 <dialog> 之外的最小可用实现，但把无障碍该有的都补上：
    // role=dialog / aria-modal、打开时移入焦点、Tab 循环、ESC 关闭、关闭后焦点归位。
    var modalState = { open: false, lastFocus: null, cb: null };

    function showModal(title, msg, cb, destructive) {
        var back = $('modal-backdrop'), card = $('modal-panel'), btn = $('modal-confirm-btn');
        if (!back || !card || !btn) return;
        $('modal-title').textContent = title;
        $('modal-msg').textContent = msg;
        $('modal-icon').className = 'modal-ic' + (destructive ? ' ' + DANGER : '');
        btn.className = 'btn ' + (destructive ? DANGER : 'primary');
        modalState.lastFocus = document.activeElement;
        modalState.cb = cb;
        modalState.open = true;
        back.hidden = false;
        document.body.classList.add('modal-open');
        btn.focus();
    }

    function hideModal() {
        var back = $('modal-backdrop');
        if (!back || back.hidden) return;
        back.hidden = true;
        document.body.classList.remove('modal-open');
        modalState.open = false;
        modalState.cb = null;
        if (modalState.lastFocus && modalState.lastFocus.focus) {
            try { modalState.lastFocus.focus(); } catch (e) {}
        }
    }

    function onModalConfirm() {
        var cb = modalState.cb;
        hideModal();
        if (cb) cb();
    }
    window.showModal = showModal;
    window.hideModal = hideModal;

    var confirmBtn = $('modal-confirm-btn');
    if (confirmBtn) confirmBtn.addEventListener('click', onModalConfirm);

    /* ---------- 选择与批量操作 ---------- */
    // ⚠️ 统计范围必须限定在 #batch-form 内。页面里还有一个 #single-form（行内快捷操作
    //    用的独立表单），它也有一个 name="keys" 的隐藏输入框；如果按 document 全局查询，
    //    这个隐藏框会被算进总数，于是「全选」永远满足不了「已勾选数 == 总数」，
    //    表头的全选框就永远不会显示为选中。
    function batchBoxes() {
        var form = $('batch-form');
        return form ? form.querySelectorAll('input[name="keys"]') : [];
    }

    function markRow(cb) {
        var row = cb.closest('.row');
        if (row) row.classList.toggle('sel', cb.checked);
    }

    function updateToolbar() {
        var boxes = batchBoxes();
        var n = 0;
        for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) n++;
        var action = $('action-header'), normal = $('default-header');
        if (action && normal) { action.hidden = n === 0; normal.hidden = n > 0; }
        var bar = document.querySelector('.topbar');
        if (bar) bar.classList.toggle('selecting', n > 0);
        var counter = $('selected-count');
        if (counter) counter.textContent = n;
        var all = $('check-all');
        if (all && boxes.length) {
            all.checked = n > 0 && n === boxes.length;
            all.indeterminate = n > 0 && n < boxes.length;
        }
    }

    function updateRowStyle(checkbox) { markRow(checkbox); updateToolbar(); }

    function toggleAll(source) {
        var boxes = batchBoxes();
        for (var i = 0; i < boxes.length; i++) { boxes[i].checked = source.checked; markRow(boxes[i]); }
        updateToolbar();
    }

    function submitBatchForm(action) {
        var form = $('batch-form');
        if (!form) return;
        var input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'action';
        input.value = action;
        form.appendChild(input);
        form.submit();
    }

    function confirmBatch(action) {
        var map = {
            delete: ['移入回收站', '选中的邮件将移入回收站，之后可以恢复。'],
            purge: ['彻底删除', '彻底删除后无法恢复，确定继续吗？'],
            restore: ['恢复邮件', '选中的邮件将回到收件箱。']
        };
        // 已读 / 未读是可逆且无副作用的，不值得打断用户去点一次确认。
        if (action === 'mark_read' || action === 'mark_unread') { submitBatchForm(action); return; }
        var m = map[action] || ['确认操作', '确定继续吗？'];
        showModal(m[0], m[1], function () { submitBatchForm(action); }, action === 'delete' || action === 'purge');
    }

    function confirmSingle(event, msg, destructive) {
        event.preventDefault();
        var form = event.target;
        showModal('确认操作', msg, function () { form.submit(); }, !!destructive);
        return false;
    }

    // 危险操作二次确认：第一次点击只「上膛」，4 秒内再点一次才真正提交。
    function askClear(btn) {
        if (btn.dataset.armed === '1') return true;
        btn.dataset.armed = '1';
        btn.dataset.label = btn.textContent;
        btn.textContent = '再点一次确认清空';
        btn.classList.add(DANGER);
        setTimeout(function () {
            btn.dataset.armed = '';
            btn.textContent = btn.dataset.label;
            btn.classList.remove(DANGER);
        }, 4000);
        return false;
    }

    window.confirmBatch = confirmBatch;
    window.confirmSingle = confirmSingle;
    window.toggleAll = toggleAll;
    window.updateRowStyle = updateRowStyle;
    window.askClear = askClear;

    /* ---------- 单封快捷操作 ---------- */
    // 走一个独立的隐藏表单，而不是去勾选批量表单里的复选框 ——
    // 否则「把这一封标为已读」会顺手把用户已经勾选的其他邮件一起处理掉。
    function runQuick(action, key) {
        var form = $('single-form');
        if (!form || !key) return;
        function send() {
            form.querySelector('[name="action"]').value = action;
            form.querySelector('[name="keys"]').value = key;
            form.submit();
        }
        if (action === 'delete') showModal('移入回收站', '这封邮件将移入回收站，之后可以恢复。', send, true);
        else if (action === 'purge') showModal('彻底删除', '彻底删除后无法恢复，确定继续吗？', send, true);
        else send();
    }

    /* ---------- 复制到剪贴板 ---------- */
    function copyText(text, label) {
        var name = label || '内容';
        function ok() { toast(name + '已复制', 'ok'); }
        function bad() { toast('复制失败，请手动选择', 'err'); }
        function fallback() {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.top = '-1000px';
                document.body.appendChild(ta);
                ta.select();
                var done = document.execCommand('copy');
                document.body.removeChild(ta);
                if (done) ok(); else bad();
            } catch (e) { bad(); }
        }
        // clipboard API 只在安全上下文可用；localhost 与 https 之外会走到 fallback。
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok).catch(fallback);
        } else fallback();
    }

    /* ---------- 事件委托 ---------- */
    // 邮件行点击必须用委托：早期版本把键名拼进 onclick 的单引号字符串里，
    // 而 encodeURIComponent 并不转义单引号 —— 主题里带一个单引号就能闭合字符串注入脚本。
    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || typeof t.closest !== 'function') return;

        var closer = t.closest('[data-modal-close]');
        if (closer) { hideModal(); return; }

        var themeBtn = t.closest('[data-theme-opt]');
        if (themeBtn) {
            if (window.__cfmailTheme) window.__cfmailTheme.set(themeBtn.getAttribute('data-theme-opt'));
            return;
        }

        var quick = t.closest('[data-quick]');
        if (quick) {
            e.preventDefault();
            e.stopPropagation();
            runQuick(quick.getAttribute('data-quick'), quick.getAttribute('data-key'));
            return;
        }

        var copyBtn = t.closest('[data-copy]');
        if (copyBtn) {
            e.preventDefault();
            copyText(copyBtn.getAttribute('data-copy'), copyBtn.getAttribute('data-copy-label') || '内容');
            return;
        }

        // ⚠️ 绝不能用「祖先里有 form 就跳过」来判断交互控件：
        //    邮件行本身就位于 <form id="batch-form"> 内部，closest('form') 永远命中，
        //    结果是整行点击被吞掉、邮件永远打不开。
        //    必须先把 target 归到行上，再判断它是不是行内真正的控件。
        var row = t.closest('.row');
        if (!row || !row.dataset.key) return;
        if (t.closest('a, button, input, label, select, textarea, iframe')) return;
        window.location.href = '/email/' + row.dataset.key;
    });

    document.addEventListener('change', function (e) {
        var t = e.target;
        if (t && t.type === 'checkbox' && t.name === 'keys' && t.form && t.form.id === 'batch-form') updateRowStyle(t);
    });

    document.addEventListener('keydown', function (e) {
        if (modalState.open) {
            if (e.key === 'Escape') { e.preventDefault(); hideModal(); return; }
            if (e.key !== 'Tab') return;
            var card = $('modal-panel');
            if (!card) return;
            var focusables = card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
            if (!focusables.length) return;
            var first = focusables[0], last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            return;
        }
        // "/" 聚焦搜索框，Esc 退出搜索 —— 邮件客户端里最省事的一组快捷键。
        var el = e.target;
        var tag = (el && el.tagName || '').toLowerCase();
        var typing = tag === 'input' || tag === 'textarea' || (el && el.isContentEditable);
        if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
            var search = $('search-input');
            if (search) { e.preventDefault(); search.focus(); search.select(); }
            return;
        }
        if (e.key === 'Escape' && typing && tag === 'input' && el.type === 'search') {
            el.value = '';
            el.blur();
        }
    });

    /* ---------- 正文 iframe 高度回报 ---------- */
    // 邮件正文渲染在沙箱 iframe 里，由它 postMessage 回报正文容器高度，父页面据此调整高度。
    // 校验 e.source === frame.contentWindow，避免页面内其它来源伪造高度。
    //
    // ⚠️ 高度必须「原样采用」，绝不能加固定增量。iframe 高度会决定它内部视口的高度，
    //    而 documentElement.scrollHeight 被视口高度托底 —— 一旦在这里加常数，
    //    就会形成「视口变高 → 测得更高 → iframe 再变高」的正反馈，
    //    表现为打开邮件后正文下方无限空白（实测 4 秒能涨 1700px 以上）。
    //
    // ⚠️ 还有一类内容用上面的办法治不好：正文里带 vh 单位（例如 <div style="min-height:100vh">）。
    //    vh 天然绑定视口高度，而视口高度正是我们在设的值 —— 这类内容不存在不动点，
    //    高度会以固定步长匀速爬升。真实内容不会「等幅」增长（图片陆续加载的步长是参差的），
    //    所以连续 3 次等幅递增就判定为反馈环并停止跟随。窗口尺寸变化时重置判定。
    var appliedHeight = -1;
    var lastStep = 0;
    var sameStep = 0;
    window.addEventListener('resize', function () { lastStep = 0; sameStep = 0; });

    window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || typeof d.__cfmailHeight !== 'number') return;
        var frame = $('mail-frame');
        if (!frame || e.source !== frame.contentWindow) return;
        var h = Math.min(Math.max(Math.ceil(d.__cfmailHeight), 120), 20000);

        // 顺手收起正文骨架。不能只靠 iframe 的 load 事件：iframe 在 HTML 解析到它时就开始加载，
        // 而监听器要等脚本执行才挂上 —— 邮件够小的话 load 会先到，事件就被错过了，
        // 骨架会一直盖在正文上直到超时兜底。子页面每次回报高度都说明它已经渲染出内容，
        // 用这个信号收起骨架是最稳的。
        var loader = $('frame-load');
        if (loader && !loader.hidden) loader.hidden = true;

        if (h === appliedHeight) return;
        var step = appliedHeight > 0 ? h - appliedHeight : 0;
        if (step > 0 && step <= 64 && step === lastStep) {
            if (++sameStep >= 3) return;
        } else {
            sameStep = 0;
        }
        lastStep = step;
        appliedHeight = h;
        frame.style.height = h + 'px';
    });

    /* ---------- 新邮件轮询 ---------- */
    function checkNew() {
        if (document.hidden) return;
        fetch('/api/check', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (d && d.latest > LATEST_TS) {
                    toast('检测到新邮件，正在刷新…');
                    setTimeout(function () { window.location.reload(); }, 1400);
                }
            })
            .catch(function () {});
    }

    if (window.location.pathname === '/' && LATEST_TS > 0) {
        setInterval(checkNew, 15000);
        // 切回标签页时立刻查一次：后台标签页的定时器会被浏览器节流，
        // 只靠 interval 的话用户切回来还要等一整个周期。
        document.addEventListener('visibilitychange', function () { if (!document.hidden) checkNew(); });
    }

    /* ---------- 初始化 ---------- */
    function boot() {
        hydrateTimes();
        groupDays();
        syncTheme();
        updateToolbar();
    }
    document.addEventListener('DOMContentLoaded', boot);
    if (document.readyState !== 'loading') boot();
})();
</script>
</body>
</html>`;
};

const renderLogin = (error = "", siteKey = "") => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>登录 · CF Mail</title>
${THEME_BOOT}
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d0f14" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="apple-touch-icon" href="/logo.svg">
<link rel="stylesheet" href="/app.css?v=${UI_VERSION}">
</head>
<body>
<main class="auth">
    <div class="auth-card">
        <div class="auth-body">
            <div class="auth-head">
                ${brandMark('auth-mark')}
                <h1>欢迎回来</h1>
                <p class="auth-sub">登录以查看你的 Cloudflare 邮箱</p>
            </div>
            ${error ? '<div class="alert error" role="alert">' + Icons.alert + '<span>' + escapeHtml(error) + '</span></div>' : ''}
            <form class="auth-form" method="POST" id="login-form">
                <div class="field">
                    <label class="label" for="username">用户名</label>
                    <div class="input-wrap">
                        <span class="lead">${Icons.user}</span>
                        <input class="input has-lead" id="username" type="text" name="username" autocomplete="username" placeholder="请输入用户名" required autofocus>
                    </div>
                </div>
                <div class="field">
                    <label class="label" for="password">密码</label>
                    <div class="input-wrap">
                        <span class="lead">${Icons.lock}</span>
                        <input class="input has-lead" id="password" type="password" name="password" autocomplete="current-password" placeholder="••••••••" required>
                        <span class="trail">
                            <button type="button" class="iconbtn" data-pw-toggle="password" aria-label="显示密码" title="显示密码">${Icons.eye}</button>
                        </span>
                    </div>
                    <p class="hint warn" id="caps-hint" hidden>大写锁定已开启</p>
                </div>
                ${siteKey ? '<div class="turnstile-wrap"><div class="cf-turnstile" data-sitekey="' + escapeAttr(siteKey) + '" data-theme="auto"></div></div>' : ''}
                <button type="submit" class="btn primary lg block" id="login-btn"><span id="login-btn-label">登录</span></button>
            </form>
        </div>
        <div class="auth-foot">Powered by Cloudflare Workers</div>
    </div>
</main>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
(function () {
    'use strict';
    var EYE = ${jsonForScript(Icons.eye)};
    var EYE_OFF = ${jsonForScript(Icons.eyeOff)};

    var form = document.getElementById('login-form');
    var btn = document.getElementById('login-btn');
    var label = document.getElementById('login-btn-label');
    if (form) {
        form.addEventListener('submit', function () {
            if (!btn) return;
            btn.disabled = true;
            if (label) label.textContent = '登录中…';
            setTimeout(function () { btn.disabled = false; if (label) label.textContent = '登录'; }, 6000);
        });
    }

    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || typeof t.closest !== 'function') return;
        var toggle = t.closest('[data-pw-toggle]');
        if (!toggle) return;
        var input = document.getElementById(toggle.getAttribute('data-pw-toggle'));
        if (!input) return;
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.innerHTML = show ? EYE_OFF : EYE;
        toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
        toggle.setAttribute('title', show ? '隐藏密码' : '显示密码');
        input.focus();
    });

    // 大写锁定是最常见的「密码明明对却登不上」来源，直接在输入框下面说出来。
    var pw = document.getElementById('password');
    var caps = document.getElementById('caps-hint');
    if (pw && caps) {
        function check(e) {
            try { caps.hidden = !(e.getModifierState && e.getModifierState('CapsLock')); }
            catch (err) { caps.hidden = true; }
        }
        pw.addEventListener('keyup', check);
        pw.addEventListener('keydown', check);
        pw.addEventListener('blur', function () { caps.hidden = true; });
    }
})();
</script>
</body>
</html>`;

const renderSetup = (error = "") => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>初始化 · CF Mail</title>
${THEME_BOOT}
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d0f14" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="apple-touch-icon" href="/logo.svg">
<link rel="stylesheet" href="/app.css?v=${UI_VERSION}">
</head>
<body>
<main class="auth">
    <div class="auth-card">
        <div class="auth-body">
            <div class="auth-head">
                ${brandMark('auth-mark')}
                <h1>欢迎使用</h1>
                <p class="auth-sub">首次部署，请设置管理员账号</p>
            </div>
            ${error ? '<div class="alert error" role="alert">' + Icons.alert + '<span>' + escapeHtml(error) + '</span></div>' : ''}
            <form class="auth-form" method="POST" action="/setup" id="setup-form">
                <div class="field">
                    <label class="label" for="username">管理员用户名</label>
                    <div class="input-wrap">
                        <span class="lead">${Icons.user}</span>
                        <input class="input has-lead" id="username" type="text" name="username" autocomplete="username" placeholder="请输入用户名" required autofocus>
                    </div>
                </div>
                <div class="field">
                    <label class="label" for="password">管理员密码</label>
                    <div class="input-wrap">
                        <span class="lead">${Icons.lock}</span>
                        <input class="input has-lead" id="password" type="password" name="password" autocomplete="new-password" minlength="8" placeholder="至少 8 位" required>
                        <span class="trail">
                            <button type="button" class="iconbtn" data-pw-toggle="password" aria-label="显示密码" title="显示密码">${Icons.eye}</button>
                        </span>
                    </div>
                    <p class="hint" id="caps-hint" hidden>大写锁定已开启</p>
                </div>
                <div class="field">
                    <label class="label" for="confirm">确认密码</label>
                    <div class="input-wrap">
                        <span class="lead">${Icons.lock}</span>
                        <input class="input has-lead" id="confirm" type="password" autocomplete="new-password" minlength="8" placeholder="再输入一次" required>
                    </div>
                </div>
                <p class="hint" id="setup-hint">密码至少 8 位，创建后即可登录。这个密码是唯一的入口，忘记后需要清空存储重新初始化。</p>
                <button type="submit" class="btn primary lg block" id="setup-btn"><span id="setup-btn-label">完成设置并登录</span></button>
            </form>
        </div>
        <div class="auth-foot">Powered by Cloudflare Workers</div>
    </div>
</main>
<script>
(function () {
    'use strict';
    var EYE = ${jsonForScript(Icons.eye)};
    var EYE_OFF = ${jsonForScript(Icons.eyeOff)};

    document.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || typeof t.closest !== 'function') return;
        var toggle = t.closest('[data-pw-toggle]');
        if (!toggle) return;
        var input = document.getElementById(toggle.getAttribute('data-pw-toggle'));
        if (!input) return;
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.innerHTML = show ? EYE_OFF : EYE;
        toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
        toggle.setAttribute('title', show ? '隐藏密码' : '显示密码');
        input.focus();
    });

    var form = document.getElementById('setup-form');
    var pw = document.getElementById('password');
    var confirm = document.getElementById('confirm');
    var hint = document.getElementById('setup-hint');
    var caps = document.getElementById('caps-hint');

    function setHint(text, kind) {
        if (!hint) return;
        hint.textContent = text;
        hint.className = 'hint' + (kind ? ' ' + kind : '');
    }

    // 本地先比一次：密码是唯一入口，打错一个字符就要清空存储重来，
    // 让用户在提交之前就发现自己少敲了。
    function matches() {
        if (!pw || !confirm) return true;
        return !confirm.value || pw.value === confirm.value;
    }

    if (pw && confirm) {
        confirm.addEventListener('input', function () {
            if (!confirm.value) setHint('密码至少 8 位，创建后即可登录。');
            else if (pw.value === confirm.value) setHint('两次输入一致。', 'ok');
            else setHint('两次输入的密码不一致。', 'bad');
        });
        pw.addEventListener('input', function () { if (confirm.value) confirm.dispatchEvent(new Event('input')); });
    }

    if (pw && caps) {
        function check(e) {
            try { caps.hidden = !(e.getModifierState && e.getModifierState('CapsLock')); }
            catch (err) { caps.hidden = true; }
        }
        pw.addEventListener('keyup', check);
        pw.addEventListener('keydown', check);
        pw.addEventListener('blur', function () { caps.hidden = true; });
    }

    if (form) {
        form.addEventListener('submit', function (e) {
            if (!matches()) {
                e.preventDefault();
                setHint('两次输入的密码不一致，请检查后再提交。', 'bad');
                if (confirm) confirm.focus();
                return;
            }
            var btn = document.getElementById('setup-btn');
            var label = document.getElementById('setup-btn-label');
            if (btn) btn.disabled = true;
            if (label) label.textContent = '创建中…';
        });
    }
})();
</script>
</body>
</html>`;

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
    const variant = source === 'settings' ? 'ok' : (source === 'env' ? 'info' : '');
    const text = SOURCE_TEXT[source] || SOURCE_TEXT.none;
    return '<span class="badge ' + variant + '">' + text + '</span>';
}

function renderSettings(settings, turnstile, forward, opts) {
    const o = opts || {};
    const secretMask = maskSecret(settings.turnstileSecretKey);
    const secretPlaceholder = secretMask
        ? '已配置：' + secretMask + '（留空则保持不变）'
        : '0x4AAAAAAAxxxxxxxxxxxxxxxx';

    let alertHtml = '';
    if (o.error) {
        alertHtml = '<div class="alert error" role="alert">' + Icons.alert + '<span>' + escapeHtml(o.error) + '</span></div>';
    } else if (o.notice) {
        alertHtml = '<div class="alert ok" role="status">' + Icons.check + '<span>' + escapeHtml(o.notice) + '</span></div>';
    }

    // 状态用一句人话讲清楚「现在到底会不会弹验证码」，而不是只给一个「已配置」的徽章。
    const turnstileState = turnstile.enabled
        ? '<b>已启用</b>：登录页会显示人机验证，服务端会校验 token。'
        : '<b>未启用</b>：登录页不显示验证码，服务端跳过校验。';

    const themeSeg = '<div class="seg" role="group" aria-label="外观主题">'
        + '<button type="button" class="seg-btn" data-theme-opt="light" aria-pressed="false">' + Icons.sun + '<span>浅色</span></button>'
        + '<button type="button" class="seg-btn" data-theme-opt="dark" aria-pressed="false">' + Icons.moon + '<span>深色</span></button>'
        + '<button type="button" class="seg-btn" data-theme-opt="auto" aria-pressed="false">' + Icons.auto + '<span>跟随系统</span></button>'
        + '</div>';

    return `
    <div class="panel">
        <div class="topbar">
            <a class="iconbtn" href="/" aria-label="返回收件箱" title="返回收件箱">${Icons.back}</a>
            <h1>设置</h1>
        </div>
        <div class="doc">
            <div class="doc-inner">
                ${alertHtml}
                <div class="stack">
                    <p class="hint">配置保存在你的 R2 存储桶中，部署后无需再打开 Cloudflare 控制台。这里的配置<b>优先于</b> Dashboard 上配置的同名环境变量。</p>

                    <form method="POST" action="/settings" class="stack">
                        <section class="card">
                            <div class="card-head">
                                <h2>邮件转发</h2>
                                ${sourceBadge(forward.source)}
                            </div>
                            <p class="card-desc">邮件成功存入 R2 后，自动转发一份到这个邮箱。留空表示不转发，改完即刻生效。</p>
                            <div class="field">
                                <label class="label" for="forward_email">转发地址</label>
                                <input class="input" id="forward_email" type="email" name="forward_email" autocomplete="off" value="${escapeAttr(settings.forwardEmail || '')}" placeholder="you@example.com">
                            </div>
                        </section>

                        <section class="card">
                            <div class="card-head">
                                <h2>人机验证 · Cloudflare Turnstile</h2>
                                ${sourceBadge(turnstile.source)}
                            </div>
                            <p class="card-desc">当前状态：${turnstileState}<br>两个 Key 必须<b>成对填写</b>：只填一个不会生效，也不会把你自己锁在门外。</p>
                            <div class="stack tight">
                                <div class="field">
                                    <label class="label" for="turnstile_site_key">Site Key</label>
                                    <input class="input" id="turnstile_site_key" type="text" name="turnstile_site_key" autocomplete="off" value="${escapeAttr(settings.turnstileSiteKey || '')}" placeholder="0x4AAAAAAAxxxxxxxxxxxxxxxx">
                                </div>
                                <div class="field">
                                    <label class="label" for="turnstile_secret_key">Secret Key</label>
                                    <input class="input" id="turnstile_secret_key" type="password" name="turnstile_secret_key" autocomplete="new-password" value="" placeholder="${escapeAttr(secretPlaceholder)}">
                                    <p class="hint">Secret Key 只保存在 R2，永远不回显。留空表示保持原值不变。</p>
                                </div>
                            </div>
                        </section>

                        <div class="settings-actions">
                            <button type="submit" class="btn primary">保存设置</button>
                            <a href="/settings" class="btn ghost">放弃修改</a>
                        </div>
                    </form>

                    <section class="card">
                        <div class="card-head">
                            <h2>外观</h2>
                            <span class="badge">仅本机</span>
                        </div>
                        <p class="card-desc">只保存在当前浏览器，不会上传到服务器。</p>
                        ${themeSeg}
                    </section>

                    <form method="POST" action="/settings/password" class="card stack" id="pw-form">
                        <div>
                            <div class="card-head">
                                <h2>修改密码</h2>
                                <span class="badge info">${Icons.shield}<span>会话轮换</span></span>
                            </div>
                            <p class="card-desc">更新后<b>其它设备上的登录会立即失效</b>，当前设备不受影响，无需重新登录。</p>
                        </div>
                        <div class="pw-grid">
                            <div class="field">
                                <label class="label" for="current_password">当前密码</label>
                                <input class="input" id="current_password" type="password" name="current_password" autocomplete="current-password" required>
                            </div>
                            <div class="field">
                                <label class="label" for="new_password">新密码</label>
                                <input class="input" id="new_password" type="password" name="new_password" autocomplete="new-password" minlength="8" required placeholder="至少 8 位">
                            </div>
                            <div class="field">
                                <label class="label" for="confirm_password">确认新密码</label>
                                <input class="input" id="confirm_password" type="password" name="confirm_password" autocomplete="new-password" minlength="8" required>
                            </div>
                        </div>
                        <p class="hint" id="pw-hint">新密码不得少于 8 位，且不能与当前密码相同。</p>
                        <div class="settings-actions">
                            <button type="submit" class="btn solid-dark">更新密码</button>
                        </div>
                    </form>

                    <section class="card card-danger">
                        <div class="card-head">
                            <h2>危险操作</h2>
                        </div>
                        <p class="card-desc">清空应用内保存的 Turnstile 密钥。若 Dashboard 上配置了同名环境变量，清空后会自动回退到环境变量。</p>
                        <form method="POST" action="/settings/clear-turnstile">
                            <button type="submit" onclick="return askClear(this)" class="btn danger-soft">清空 Turnstile 密钥</button>
                        </form>
                    </section>

                    <section class="card">
                        <div class="card-head">
                            <h2>退出登录</h2>
                            <span class="badge">仅本机</span>
                        </div>
                        <p class="card-desc">退出当前设备上的登录，其它设备的登录状态不受影响。</p>
                        <div>
                            <a href="/logout" class="btn danger-soft">${Icons.logout}<span>退出登录</span></a>
                        </div>
                    </section>

                    <p class="hint">Turnstile 的 Site Key 由服务端渲染进登录页，保存后<b>下次打开登录页</b>生效。</p>
                </div>
            </div>
        </div>
    </div>
    <script>
    (function () {
        'use strict';
        var pw = document.getElementById('new_password');
        var confirm = document.getElementById('confirm_password');
        var hint = document.getElementById('pw-hint');
        var base = '新密码不得少于 8 位，且不能与当前密码相同。';
        function set(text, kind) {
            if (!hint) return;
            hint.textContent = text;
            hint.className = 'hint' + (kind ? ' ' + kind : '');
        }
        // 提交之前就把「两次不一致」指出来，省掉一次 400 往返和整页重绘。
        function check() {
            if (!pw || !confirm || !confirm.value) { set(base); return; }
            if (pw.value === confirm.value) set('两次输入一致。', 'ok');
            else set('两次输入的密码不一致。', 'bad');
        }
        if (pw) pw.addEventListener('input', check);
        if (confirm) confirm.addEventListener('input', check);
    })();
    </script>`;
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
// ⚠️ 高度上报的取值对象必须是「内容容器」而不是 documentElement，理由见 FRAME_HEIGHT_SCRIPT。
//    配套约束：html / body 必须保持 height:auto，否则内容容器会被视口高度拉伸。
//
//    正文一律保持浅色（color-scheme:light + 白底）：邮件是按白底排版的，
//    在深色主题里把它反色会毁掉图片、表格底色和 logo。
//    深色主题下靠外层的边框与圆角把这块白「框」住，看起来是刻意的留白而不是漏了样式。
const FRAME_CSS = 'html,body{height:auto !important;min-height:0 !important;max-height:none !important;margin:0 !important;padding:0 !important}'
    + 'html{color-scheme:light}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;font-size:15px;line-height:1.7;color:#1f2937;background:#fff;word-break:break-word;overflow-wrap:anywhere}'
    + '#mail-root{padding:0 2px 20px}'
    + 'img{max-width:100%;height:auto}table{max-width:100%}'
    + 'blockquote{margin:0;padding-left:.8rem;border-left:3px solid #e5e7eb;color:#6b7280}'
    + 'a{color:#4f46e5}'
    + 'hr{border:0;border-top:1px solid #e5e7eb;margin:1.2em 0}'
    + 'pre.plain{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit}'
    + '@media (max-width:560px){body{font-size:14.5px}}';

// 唯一的内联脚本：向父页面回报正文容器的真实高度，父页面据此调整 iframe 高度。
//
// ⚠️ 这里踩过一个很隐蔽的坑：原来测的是 document.documentElement.scrollHeight。
//    而 documentElement 的 scrollHeight 会被视口高度「托底」—— 内容再短也返回不小于
//    iframe 视口的高度。父页面当时又给测得值加了固定增量（+8px）再设为 iframe 高度，
//    于是形成正反馈：视口变高 → scrollHeight 跟着变高 → iframe 更高 → …… 一路顶到上限。
//    用户看到的就是「打开邮件后下方无限空白」。
//    两道保险：① 只测 #mail-root（内容驱动，与视口无关）；② 父页面原样采用、不加常数。
//    另外用 last 去重，避免同一高度反复 postMessage。
//
// ⚠️ 第二个坑（实测出来的）：iframe 在 HTML 解析到它时就开始加载，而它此时**还没有宽度**
//    （父页面的样式表可能仍在加载，iframe 的盒子还是默认尺寸）。子页面在这个时刻测量，
//    文字会被折成 1 个字一行，量出来的高度能到 3 万多像素 —— 父页面一旦采用，页面会先
//    猛地撑开再缩回去。所以宽度没定下来之前直接不报：宽度本身没有意义，基于它算出的高度更没有。
//    ResizeObserver 与 resize 事件会在宽度落定后重新触发测量。
const FRAME_HEIGHT_SCRIPT = '(function(){'
    + 'var root=document.getElementById("mail-root")||document.body,last=-1;'
    + 'function s(){'
    + 'var box=root.getBoundingClientRect?root.getBoundingClientRect():{width:0,height:0};'
    + 'if(!box.width||box.width<80)return;'
    + 'var h=Math.ceil(Math.max(root.scrollHeight||0,box.height));'
    + 'if(h===last)return;last=h;'
    + 'try{parent.postMessage({__cfmailHeight:h},"*")}catch(e){}}'
    + 'window.addEventListener("load",s);window.addEventListener("resize",s);'
    + 'document.addEventListener("DOMContentLoaded",s);'
    + 'if(window.ResizeObserver){try{new ResizeObserver(s).observe(root)}catch(e){}}'
    + 'setTimeout(s,300);setTimeout(s,1500)})();';

function buildFrameDocument(email) {
    let inner;
    if (email.html) {
        inner = stripActiveContent(email.html).html;
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

// 附件图标：图片类给一个图片图标，其余统一用文档图标。
// 一眼能分辨「这是一张图」比清一色的回形针有用得多。
function attachmentIcon(mime) {
    return String(mime || '').toLowerCase().indexOf('image/') === 0 ? Icons.image : Icons.file;
}

function renderEmailDetail(email, key, isTrash, uploaded) {
    const fromRaw = String(email.headers['from'] || '');
    const senderName = (fromRaw.split('<')[0] || '').trim().replace(/"/g, '') || '未知发件人';
    const senderEmail = (fromRaw.match(/<([^>]+)>/) || [])[1] || fromRaw.replace(/[<>]/g, '').trim();
    const initial = escapeHtml((senderName[0] || '?').toUpperCase());
    const avatarColor = getAvatarColor(senderName);
    const subject = email.headers['subject'] || '(无主题)';
    const uploadedTs = new Date(uploaded).getTime();
    const uploadedIso = Number.isFinite(uploadedTs) ? new Date(uploadedTs).toISOString() : '';
    const encodedKey = encodeURIComponent(key);

    // 只有正文里**确实**含有可执行内容（脚本 / 内联事件 / javascript: URL）时才提示一句。
    // 普通邮件不留任何多余文字 —— 常驻一句「已剥离脚本」对 99% 的邮件毫无信息量，
    // 而且「已被剥离」的措辞容易被读成「邮件坏了」。这里只在真的发生过剥离时解释一句。
    const strippedNotice = (email.html && stripActiveContent(email.html).removed)
        ? '<div class="note">' + Icons.shield + '<span>这封邮件含有脚本或内联事件，已为安全起见移除；正文其余内容不受影响。</span></div>'
        : '';

    let attachmentsHtml = '';
    if (email.attachments.length > 0) {
        attachmentsHtml = `
        <div class="attach">
            <div class="attach-head">${Icons.attach}<span>附件 ${email.attachments.length} 个</span></div>
            <div class="attach-grid">
                ${email.attachments.map((att, index) => `
                <div class="attach-item">
                    <div class="attach-ic">${attachmentIcon(att.mime)}</div>
                    <div class="grow">
                        <div class="attach-name" title="${escapeAttr(att.filename)}">${escapeHtml(att.filename)}</div>
                        <div class="attach-size">${escapeHtml(att.sizeStr)}</div>
                    </div>
                    <a class="iconbtn" href="/attachment/${encodedKey}/${index}" download="${escapeAttr(att.filename)}" title="下载附件" aria-label="下载附件 ${escapeAttr(att.filename)}">${Icons.download}</a>
                </div>`).join('')}
            </div>
        </div>`;
    }

    // 翻译按钮。译文由服务端调 Workers AI 生成；原文已是中文 / 语种不受支持时会在状态条上明确说明。
    const translateBtn = '<button type="button" id="translate-btn" class="btn soft" onclick="translateMail()" title="把正文翻译成中文">'
        + Icons.translate + '<span class="lbl-wide">翻译</span></button>';

    // 下载原始邮件。归档备份、喂给别的客户端、排障看真实头部都用得上。
    // 标签写「下载原文」而不是「原文」：它紧挨着「翻译」，只写「原文」会被读成
    // 「原文 / 译文」的视图切换，但这里其实是下载 .eml 文件，两回事。
    const rawBtn = '<a class="btn ghost" href="/raw/' + encodedKey + '" download title="下载原始邮件（.eml）">'
        + Icons.download + '<span class="lbl-wide">下载原文</span></a>';

    const toolbar = isTrash
        ? `<div class="topbar-actions">
            ${translateBtn}
            ${rawBtn}
            <form method="POST" action="/restore" onsubmit="return confirmSingle(event, '确定要恢复这封邮件吗？')">
                <input type="hidden" name="key" value="${escapeAttr(key)}">
                <button class="btn ok-soft" title="恢复到收件箱">${Icons.restore}<span class="lbl-wide">恢复</span></button>
            </form>
            <form method="POST" action="/purge" onsubmit="return confirmSingle(event, '彻底删除后将无法恢复，确定吗？', true)">
                <input type="hidden" name="key" value="${escapeAttr(key)}">
                <button class="btn danger-soft" title="彻底删除">${Icons.trash}<span class="lbl-wide">删除</span></button>
            </form>
        </div>`
        : `<div class="topbar-actions">
            ${translateBtn}
            ${rawBtn}
            <form method="POST" action="/delete" onsubmit="return confirmSingle(event, '确定要将这封邮件移入回收站吗？')">
                <input type="hidden" name="key" value="${escapeAttr(key)}">
                <button class="iconbtn danger" title="移入回收站" aria-label="移入回收站">${Icons.trash}</button>
            </form>
        </div>`;

    return `
    <div class="panel">
        <div class="topbar">
            <a class="iconbtn" href="${isTrash ? '/trash' : '/'}" title="返回列表" aria-label="返回列表">${Icons.back}</a>
            <h1>${escapeHtml(subject)}</h1>
            ${toolbar}
        </div>
        <div class="doc">
            <div class="doc-inner">
                <h2 class="subject">${escapeHtml(subject)}</h2>
                <div class="sender">
                    <div class="avatar lg ${avatarColor}" aria-hidden="true">${initial}</div>
                    <div class="grow">
                        <div class="sender-name truncate">${escapeHtml(senderName)}</div>
                        <div class="sender-mail">
                            <a href="mailto:${escapeAttr(senderEmail)}" title="${escapeAttr(senderEmail)}">${escapeHtml(senderEmail)}</a>
                            <button type="button" class="iconbtn" data-copy="${escapeAttr(senderEmail)}" data-copy-label="发件人地址" title="复制地址" aria-label="复制发件人地址">${Icons.copy}</button>
                        </div>
                    </div>
                    <time class="sender-time" data-ts="${Number.isFinite(uploadedTs) ? uploadedTs : 0}" data-fmt="full" datetime="${escapeAttr(uploadedIso)}"></time>
                </div>
                ${attachmentsHtml}
                <div id="translate-status" class="alert info" hidden></div>
                <div id="mail-original">
                    <div class="frame-wrap">
                        <iframe id="mail-frame" src="/frame/${encodedKey}" title="邮件正文" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" style="height:320px"></iframe>
                        <div class="frame-load" id="frame-load">${Icons.spinner}<span>正在载入正文…</span></div>
                    </div>
                    ${strippedNotice}
                </div>
                <div id="mail-translated" hidden>
                    <div class="translated" id="translate-body"></div>
                    <div class="toolbar-inline">
                        <button type="button" class="btn ghost" id="copy-translated">${Icons.copy}<span>复制译文</span></button>
                    </div>
                    <p class="note">译文由 Workers AI 生成，仅供快速浏览；排版、链接与图片请以原文为准。</p>
                </div>
            </div>
        </div>
    </div>
    <script>
    (function () {
        'use strict';
        var KEY = ${jsonForScript(key)};
        var translated = null;
        var view = 'original';

        function el(id) { return document.getElementById(id); }

        function setStatus(text, kind) {
            var box = el('translate-status');
            if (!box) return;
            if (!text) { box.hidden = true; box.textContent = ''; return; }
            box.className = 'alert ' + (kind === 'error' ? 'error' : 'info');
            box.textContent = text;
            box.hidden = false;
        }

        function setView(next) {
            var original = el('mail-original');
            var panel = el('mail-translated');
            var btn = el('translate-btn');
            if (!original || !panel) return;
            view = next;
            var label = btn ? btn.querySelector('span') : null;
            if (next === 'translated' && translated) {
                original.hidden = true;
                panel.hidden = false;
                if (label) label.textContent = '显示原文';
            } else {
                panel.hidden = true;
                original.hidden = false;
                if (label) label.textContent = translated ? '显示译文' : '翻译';
            }
        }

        window.translateMail = function () {
            var btn = el('translate-btn');
            if (translated) { setView(view === 'translated' ? 'original' : 'translated'); return; }
            if (!btn || btn.disabled) return;

            var label = btn.querySelector('span');
            btn.disabled = true;
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
            });
        };

        var copyBtn = el('copy-translated');
        if (copyBtn) copyBtn.addEventListener('click', function () {
            if (translated && window.cfCopyText) window.cfCopyText(translated, '译文');
        });

        // 正文载入完成前盖一层骨架，避免先看到一片空白再「跳」出内容。
        // 加超时兜底：某些邮件正文里带了永不触发的资源，load 可能迟迟不来。
        var frame = el('mail-frame');
        var loader = el('frame-load');
        if (frame && loader) {
            frame.addEventListener('load', function () { loader.hidden = true; });
            setTimeout(function () { loader.hidden = true; }, 6000);
        }
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
    if (url.pathname === '/robots.txt') return textResponse('User-agent: *\nDisallow: /\n');
    if (url.pathname === '/app.css') return assetResponse(APP_CSS, 'text/css; charset=utf-8');

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
            : (url.searchParams.get('cleared')
                ? 'Turnstile 密钥已清空。'
                : (url.searchParams.get('pwchanged') ? '密码已更新，其它设备上的登录已失效。' : ''));

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

    // ---------- 修改密码 ----------
    // 以前想改密码只能删掉 sys_config.json 重新初始化 —— 那会连带清掉全部配置和会话，太糙了。
    if (url.pathname === '/settings/password' && method === 'POST') {
        const settings = await getSettings(env);
        const back = (opts, status) => htmlResponse(renderLayout(
            renderSettings(settings, resolveTurnstile(settings, env), resolveForwardEmail(settings, env), opts),
            'settings'
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
        if (!resolved.isTrash && resolved.obj.customMetadata?.isRead !== 'true') {
            ctx.waitUntil(env.MAIL_BUCKET.put(resolved.key, buffer, { customMetadata: { isRead: 'true' } }));
        }

        const email = processEmail(bufferToBinaryString(buffer));
        // 带上主题，浏览器标签页 / 历史记录 / 书签里才看得出这是哪封邮件。
        return htmlResponse(renderLayout(
            renderEmailDetail(email, resolved.key, resolved.isTrash, resolved.obj.uploaded),
            resolved.isTrash ? 'trash' : 'inbox',
            0,
            { title: email.headers['subject'] || '(无主题)' }
        ));
    }

    const isTrashPage = url.pathname === '/trash';
    if (url.pathname === '/' || isTrashPage) {
        // 翻页取全量、再排序截取 —— 直接 list({ limit: N }) 拿到的是**最旧的** N 封，
        // 邮件一多新邮件就再也不显示了（详见 listAllObjects 上的说明）。
        const all = await listAllObjects(env, { prefix: isTrashPage ? TRASH_PREFIX : '' });
        const emails = isTrashPage ? all : all.filter(o => isMailKey(o.key));
        emails.sort((a, b) => keyTimestamp(b.key) - keyTimestamp(a.key));

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

        // 分页：夹在 [50, 2000]，避免 ?limit= 被放大成任意值
        const requested = parseInt(url.searchParams.get('limit') || '', 10);
        const pageSize = Number.isFinite(requested)
            ? Math.min(Math.max(requested, PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX)
            : PAGE_SIZE_DEFAULT;
        const shown = matched.slice(0, pageSize);
        const nextSize = Math.min(pageSize * 2, PAGE_SIZE_MAX);
        const hasMore = matched.length > shown.length;

        // 未读计数（侧栏与底部导航的徽标）。已取到全量 metadata，顺手算出来，不额外开销。
        const unreadCount = isTrashPage ? 0 : emails.filter(o => o.customMetadata?.isRead !== 'true').length;

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
            const isRead = e.customMetadata?.isRead === 'true';

            // 主题与发件人完全由发件人控制，必须转义后才能拼进 HTML。
            // 行点击走 data-key + 事件委托：不能把键名拼进 onclick 的单引号字符串，
            // 因为 encodeURIComponent 不转义单引号，主题里带一个单引号就能注入脚本。
            //
            // 快捷操作按钮用 data-quick，由委托处理，并且只作用于这一封 ——
            // 不去动批量表单里用户已经勾选的其他邮件。
            const quickActions = isTrashPage
                ? '<button type="button" class="iconbtn" data-quick="restore" data-key="' + escapeAttr(fullKey) + '" title="恢复到收件箱" aria-label="恢复">' + Icons.restore + '</button>'
                    + '<button type="button" class="iconbtn danger" data-quick="purge" data-key="' + escapeAttr(fullKey) + '" title="彻底删除" aria-label="彻底删除">' + Icons.trash + '</button>'
                : '<button type="button" class="iconbtn" data-quick="' + (isRead ? 'mark_unread' : 'mark_read') + '" data-key="' + escapeAttr(fullKey) + '" title="' + (isRead ? '标为未读' : '标为已读') + '" aria-label="' + (isRead ? '标为未读' : '标为已读') + '">' + (isRead ? Icons.mail : Icons.mailOpen) + '</button>'
                    + '<button type="button" class="iconbtn danger" data-quick="delete" data-key="' + escapeAttr(fullKey) + '" title="移入回收站" aria-label="移入回收站">' + Icons.trash + '</button>';

            return `
            <div class="row${isRead ? '' : ' unread'}" data-key="${escapeAttr(encodeURIComponent(displayKey))}" data-ts="${ts}">
                <div class="row-check">
                    <label class="check">
                        <input type="checkbox" name="keys" value="${escapeAttr(fullKey)}" aria-label="选择这封邮件">
                        <span class="box">${CHECK_MARK}</span>
                    </label>
                </div>
                <div class="avatar md ${color}" aria-hidden="true">${escapeHtml((senderName[0] || '?').toUpperCase())}</div>
                <div class="row-body">
                    <div class="row-top">
                        <span class="row-from">${isRead || isTrashPage ? '' : '<span class="dot"></span>'}${escapeHtml(senderName)}</span>
                        <time class="row-time" data-ts="${ts}" datetime="${ts > 0 ? escapeAttr(new Date(ts).toISOString()) : ''}"></time>
                    </div>
                    <div class="row-subj">${escapeHtml(subject)}</div>
                </div>
                <div class="row-acts">${quickActions}</div>
            </div>`;
        }).join('');

        const emptyState = `
        <div class="empty">
            <div class="empty-ic">${query ? Icons.search : (isTrashPage ? Icons.trash : Icons.inbox)}</div>
            <h3>${query ? '没有匹配的邮件' : (isTrashPage ? '回收站是空的' : '收件箱是空的')}</h3>
            <p>${query ? '换个关键词试试。搜索范围是主题与发件人。' : (isTrashPage ? '被删除的邮件会在这里保留，直到你彻底删除它们。' : '发给这个地址的邮件会自动出现在这里。')}</p>
            ${query ? '<a class="btn ghost" href="' + (isTrashPage ? '/trash' : '/') + '">清除搜索条件</a>' : ''}
        </div>`;

        const batchButtons = isTrashPage
            ? '<button type="button" class="btn ok-soft" onclick="confirmBatch(\'restore\')">' + Icons.restore + '<span class="lbl-wide">恢复</span></button>'
                + '<button type="button" class="btn danger-soft" onclick="confirmBatch(\'purge\')">' + Icons.trash + '<span class="lbl-wide">彻底删除</span></button>'
            : '<button type="button" class="iconbtn" onclick="confirmBatch(\'mark_read\')" title="标记为已读" aria-label="标记为已读">' + Icons.mailOpen + '</button>'
                + '<button type="button" class="iconbtn" onclick="confirmBatch(\'mark_unread\')" title="标记为未读" aria-label="标记为未读">' + Icons.mail + '</button>'
                + '<button type="button" class="iconbtn danger" onclick="confirmBatch(\'delete\')" title="移入回收站" aria-label="移入回收站">' + Icons.trash + '</button>';

        const latestTimestamp = emails.length > 0 ? keyTimestamp(emails[0].key) : 0;
        const searchAction = isTrashPage ? '/trash' : '/';

        const countLine = query
            ? '找到 ' + matched.length + ' 封匹配「' + query + '」的邮件'
            : '共 ' + emails.length + ' 封邮件';
        const shownLine = hasMore ? '，当前显示最新 ' + shown.length + ' 封' : '';

        // 「加载更多」用 URL 递进而不是一次渲染全部：
        // 邮件上千封时把 DOM 全铺出来会明显卡顿，而分页的成本几乎为零。
        const nextHref = searchAction + '?limit=' + nextSize + (query ? '&q=' + encodeURIComponent(query) : '');
        const footer = !hasMore ? '' : (nextSize > pageSize
            ? '<div class="loadmore"><a class="btn ghost" href="' + escapeAttr(nextHref) + '">加载更多（还有 ' + (matched.length - shown.length) + ' 封）</a></div>'
            : '<div class="loadmore"><span class="hint">仅显示前 ' + PAGE_SIZE_MAX + ' 封，请用搜索缩小范围</span></div>');

        const searchBar = `
        <form class="searchbar" method="GET" action="${searchAction}" role="search">
            <div class="input-wrap">
                <span class="lead">${Icons.search}</span>
                <input class="input" id="search-input" type="search" name="q" value="${escapeAttr(query)}" autocomplete="off" aria-label="搜索主题或发件人" placeholder="搜索主题或发件人　按 / 聚焦">
            </div>
            <button type="submit" class="btn primary">搜索</button>
            ${query ? '<a class="btn ghost" href="' + searchAction + '">清除</a>' : ''}
        </form>`;

        const html = `
        <div class="panel">
            <div class="topbar">
                <label class="check" title="全选本页">
                    <input type="checkbox" id="check-all" onclick="toggleAll(this)" aria-label="全选本页邮件">
                    <span class="box">${CHECK_MARK}</span>
                </label>
                <h1>${isTrashPage ? '回收站' : '收件箱'}</h1>
                <div class="topbar-actions" id="default-header">
                    <a class="iconbtn" href="/settings" title="设置" aria-label="设置">${Icons.gear}</a>
                    <button type="button" class="iconbtn" onclick="location.reload()" title="刷新" aria-label="刷新">${Icons.refresh}</button>
                </div>
                <div class="topbar-actions" id="action-header" hidden>
                    <span class="sel-count">已选 <b id="selected-count">0</b></span>
                    ${batchButtons}
                </div>
            </div>
            ${searchBar}
            <div class="rowlist-meta">${escapeHtml(countLine + shownLine)}</div>
            <form id="batch-form" method="POST" action="/batch-action" class="listwrap">
                <input type="hidden" name="next" value="${isTrashPage ? '/trash' : '/'}">
                <div id="list-wrap">
                    ${shown.length > 0 ? rows : ''}
                </div>
                ${shown.length > 0 ? footer : emptyState}
            </form>
        </div>
        <form id="single-form" method="POST" action="/batch-action" hidden>
            <input type="hidden" name="next" value="${isTrashPage ? '/trash' : '/'}">
            <input type="hidden" name="action" value="">
            <input type="hidden" name="keys" value="">
        </form>`;
        return htmlResponse(renderLayout(html, isTrashPage ? 'trash' : 'inbox', latestTimestamp, {
            unreadCount: unreadCount,
            // 搜索时把关键词带进标题：开了好几个标签页找邮件时，「搜索「发票」· CF Mail」
            // 比三个一模一样的「收件箱 · CF Mail」有用得多。
            title: query ? '搜索「' + query + '」' : (isTrashPage ? '回收站' : '收件箱')
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
            return htmlResponse('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + THEME_BOOT + '<title>服务异常 · CF Mail</title><link rel="stylesheet" href="/app.css?v=' + UI_VERSION + '"></head><body><main class="auth"><div class="auth-card"><div class="auth-body"><div class="auth-head"><div class="modal-ic danger">' + Icons.alert + '</div><h1>服务暂时不可用</h1><p class="auth-sub">请稍后重试。若持续出现，请查看 Worker 日志（Dashboard 的 Logs 页，或本地 <span class="mono">wrangler tail</span>）。</p></div></div></div></main></body></html>', 500);
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
