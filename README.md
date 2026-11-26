<div align="center">

# CF Webmail

**跑在 Cloudflare 边缘网络上的无服务器邮箱**

零服务器 · 零数据库 · 收信 / 发信 / 翻译 · 全部在免费额度内

</div>

---

## ✉️ 发信功能

基于 Cloudflare 2026-11-24 开放的 **Email Sending on Workers Free**，本项目补上了发信闭环。发出的邮件以标准 `.eml` 留档到 `sent/`，与现有详情、翻译、原文下载体系无缝复用。

| 功能 | 说明 |
| :--- | :--- |
| **✍️ 写邮件** | 侧栏主按钮 / 列表头入口；多收件人（逗号分隔，≤ 50）；主题与正文至少填一项 |
| **↩️ 回复** | 详情页预填收件人、`Re:` 主题与引用正文；已发送页的「回复」即再次发给原收件人 |
| **📤 已发送** | 侧栏独立视图，可查看 / 下载原文 / 彻底删除，支持搜索与分页 |
| **⚙️ 发件人** | 设置页「发件设置」可配；优先级：应用内设置 → `SEND_FROM` → 未配置 |
| **💬 可读错误** | `E_RECIPIENT_PLAN_RESTRICTED` 等错误码翻译成「下一步该做什么」 |

```
设置页 / SEND_FROM
   │  发件人地址（域名须 onboard）
   ▼
/compose 撰写 ──POST /api/send──▶ env.EMAIL.send()
                                      │
                                      ├──▶ 收件人（免费版：仅已验证目标地址）
                                      │
                                      └──▶ sent/<时间戳>_….eml 留档
                                                  │
                                                  ▼
                                            「已发送」视图
```

> **⚠️ 免费版限制**
>
> - **收件人**只能是账号里「已验证的目标地址」；发给其它地址会报 `E_RECIPIENT_PLAN_RESTRICTED`，需升级 Workers 付费版才能发给任意地址。
> - **发件人**地址的域名必须 onboard 到 Email Service（SPF / DKIM / DMARC），否则报 `E_SENDER_DOMAIN_NOT_AVAILABLE`。DNS 生效一般 5–15 分钟。
> - 好消息：**发给已验证地址永久免费**，不占月配额，也不计每日发送额度。

**启用发信**：① 确认 `wrangler.jsonc` 含 `send_email` 绑定（已内置）；② 到 Cloudflare → Email Service → Email Sending → **Onboard Domain**；③ 在「设置 → 发件设置」填发件人地址，并把测试收件邮箱加入 **Destination Addresses** 验证。绑定缺失或未配发件人时撰写页会显示指引，收信功能不受影响。

---

## 🚀 快速开始

### 部署（Dashboard 连接 GitHub，推荐）

**前置条件**：Cloudflare 账号 + 域名托管 + 启用 Email Routing；**先在 Dashboard → R2 点一次同意条款**（否则自动建桶失败）；代码已推送到 GitHub。

**Workers & Pages → Create → Workers → Connect to Git**，按下表填写：

| 配置项 | 值 |
| :--- | :--- |
| Project name | `cf-webmail-client`（必须与 `wrangler.jsonc` 的 `name` 一致） |
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |

首次部署自动完成 **R2 建桶 + 绑定**、**Workers AI 绑定**（翻译用）、**send_email 绑定**（发信用）。TRUST 提醒：Dashboard 部署的资源 ID 不会写回仓库，日后改用本地 `wrangler deploy` 前请先把桶名复制进 `wrangler.jsonc`，否则会新建空桶。

**收信路由**：域名管理 → Email → Email Routing → Routes → Create address，Action 选 **Send to a Worker**、Worker 选 `cf-webmail-client`。

**首次访问**：打开 Worker URL，自动跳初始化页，设置管理员账号（密码 ≥ 8 位）即可登录。

### 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

| 命令 | 作用 |
| :--- | :--- |
| `npm test` / `npm run test:send` | 回归测试 / 发信测试（零依赖、不联网、不碰线上数据） |
| `npm run check` | 离线校验部署配置 |
| `npm run preview` / `npm run verify:frame` | 登录页视觉对比 / iframe 高度收敛验证 |
| `npm run deploy` / `npm run tail` / `npm run types` | 部署 / 实时日志 / 生成类型定义 |

---

## ⚙️ 配置

三种配置都按 **应用内设置 → 环境变量 → 关闭** 三段式回退：老部署用环境变量照常工作，设置页的值会覆盖它。变量在 **Workers & Pages → 设置 → Variables and Secrets** 里配（改后到 Deployments 点 Retry deployment）。

| 变量 | 类型 | 说明 |
| :--- | :--- | :--- |
| `FORWARD_EMAIL` | Text | 收到邮件后转发到此邮箱；留空 = 不转发 |
| `SEND_FROM` | Text | 发件人地址，域名须已 onboard；留空则需在应用内填写 |
| `TURNSTILE_SITE_KEY` | Text | Turnstile Site Key（公开值） |
| `TURNSTILE_SECRET_KEY` | Secret | Turnstile Secret Key（必须选 Secret 类型） |

> **为什么 `wrangler.jsonc` 里不直接写变量？** 配置文件里的同名变量会覆盖 Dashboard 的值，写空值等于把已配好的真实值清掉；密钥写进仓库等于明文提交。

登录后在 **设置** 页可配置：邮件转发、Turnstile 密钥（**必须成对填写**）、发件人地址、每页数量、自动标已读、修改密码（**轮换会话 token，其它设备立即失效**）、一键退出其它设备。

> Secret Key 永不回显，输入框留空 = 保持原值；非密钥字段留空 = 清空。两个 Key 不完整时验证自动关闭，不会把人锁在门外。

**绑定一览**

| 绑定 | 类型 | 用途 |
| :--- | :--- | :--- |
| `MAIL_BUCKET` | R2 桶 | 邮件 `.eml`、设置、计数、译文缓存 |
| `AI` | Workers AI | 正文翻译 `@cf/meta/m2m100-1.2b` |
| `EMAIL` | Email Sending | 写邮件 / 回复 `env.EMAIL.send()` |

---

## ✨ 核心能力

| 能力 | 说明 |
| :--- | :--- |
| **健壮 MIME 解析** | base64 / quoted-printable、嵌套 multipart、RFC 2047 头部折叠、GBK 乱码嗅探回退 |
| **正文沙箱渲染** | 不透明源 iframe + 剥离脚本与内联事件，恶意邮件碰不到会话 |
| **附件流式下载** | 不进 HTML，按需解码返回；10MB 附件也不撑爆页面 |
| **完整邮件管理** | 收件箱 / 已发送 / 回收站、星标、已读未读、批量操作、PWA 可安装 |
| **搜索与翻页** | 按主题 + 发件人过滤；R2 `list()` 跟 cursor 翻到底，新邮件不会因超过一页而消失 |
| **正文一键翻译** | Workers AI 按 token 就地替换文字，标签 / 表格 / 按钮 / 图片位置一个不动 |
| **下载原始邮件** | `/raw/<key>` 一键下载未经改写的 `.eml`，用于留档或取证 |
| **登录防护** | 加盐口令哈希、常量时间比对、按 IP 限流、服务端会话过期 |

**架构**

```
发件人 ──SMTP──▶ Email Routing ──▶ Worker.email() ──▶ R2
                                                       ▲
浏览器 ──HTTPS──▶ Worker.fetch() ───────────────────────┘
                    ├─ /                    收件箱列表
                    ├─ /sent /trash         已发送 / 回收站
                    ├─ /email /frame        邮件详情（正文走 iframe）
                    ├─ /attachment /raw     附件 / 原文下载
                    ├─ /compose /api/send   撰写 / 发送
                    └─ /login /settings     登录 / 设置
```

**R2 键名约定**

| 键 | 用途 |
| :--- | :--- |
| `sys_config.json` | 管理员账号（加盐哈希）、会话 token |
| `_sys/settings.json` | 应用内设置 |
| `<时间戳>_<发件人长度>_<发件人><主题>.eml` | 收件箱邮件，入库时已解码头部 |
| `sent/<键名>` / `trash/<键名>` | 已发送 / 回收站邮件 |
| `_sys/counts.json` / `_sys/latest.json` | 计数缓存 / 最新邮件时间戳 |
| `_sys/trans/<哈希>.html` | 整篇译文缓存 |

> 老版本 `<时间戳>_<发件人>_<主题>.eml` 的键名会被自动抢救解码，**已入库老邮件无需重投即可正常显示**。

---

## 🌐 正文翻译（Workers AI）

详情页「翻译」按钮把正文译成中文，再点切回原文。核心设计是**就地替换文字，不改动版式**：正文切成标签与文本 token，标签原样保留，只翻译文本节点并按原位置填回。原文与译文共用同一个 iframe，切换只改 `src`，元素位置不动。

- **模型**：`@cf/meta/m2m100-1.2b`，只翻译、不生成内容；支持英 / 中 / 法 / 西 / 阿拉伯 / 俄 / 德 / 日 / 葡 / 印地语。
- **源语言识别**：显式传 `source_lang`（模型默认英文），按字符集 + 高频虚词轻量判断。
- **预算**：单次最多 48 次 AI 调用、4 路并发，超出预算的片段保留原文并如实告知。
- **缓存**：整篇译文存 R2，来回切换不重复计费；彻底删除邮件时一并清理。
- **成本**：$0.342 / 百万 token（输入输出同价），只在点翻译时产生。免费版每天 10,000 Neurons，个人用量远低于此。
- **隐私**：推理跑在你自己账号的 Cloudflare 基础设施内，不经第三方。不想用可删掉 `ai` 绑定，其余功能不受影响。

---

## 🔒 安全设计

| 风险 | 处理 |
| :--- | :--- |
| 邮件内容 XSS | 发件人 / 主题 / 附件名统一 `escapeHtml()` 后渲染 |
| 点击行 XSS | 键名放 `data-key` + 事件委托，绝不拼进 `onclick` |
| 正文脚本执行 | 不透明源 iframe + CSP `sandbox`，额外剥离 `<script>` 与内联 `on*` |
| 附件类型混淆 | `text/html` / `image/svg+xml` 等一律降级为 `application/octet-stream` |
| 口令存储与比对 | 加盐 SHA-256 + 常量时间 `safeEqual` |
| 暴力破解 | 按 IP 限流：15 分钟内失败 8 次 → 锁定 10 分钟 |
| 会话 | 32 字节 token、`HttpOnly` + `Secure` + `SameSite=Lax`、服务端 30 天过期 |
| 会话轮换 | 改密码 / 退出其它设备时轮换 token，旧 cookie 当场作废 |
| 开放重定向 | 回跳目标白名单校验（只接受 `/` 与 `/trash`） |
| 信息泄漏 | 异常只写日志不回显；全站 `no-store` + `noindex` |

> `Response.redirect()` 只接受绝对 URL，全站统一 `Response.redirect(url.origin + '/xxx', 302)`。不要用 `Referer` 回跳 —— 本站 `Referrer-Policy: no-referrer`，浏览器不发它。

---

## 💰 成本

全部在免费额度内：**Workers** 每天 10 万次请求 · **Email Routing** 收信免费不限量 · **R2** 10GB 存储 + 每月 100 万次 A 类操作且出网免费 · **Email Sending** 发给已验证地址永久免费 · **Workers AI** 仅翻译时按量计费。

---

## ⚖️ 已知取舍

- **Tailwind 走 CDN**：省掉构建步骤，代价是首屏多一个外部请求。
- **配置存在 R2**：换来免控制台配置，代价是密钥失去 Cloudflare 的静态加密；更看重加密就用环境变量。
- **邮件靠键名解析**：发件人用长度前缀界定、`_` 不会串位；极端字符只影响列表文字，正文与附件不受影响。
- **翻译逐片段调用**：保留版式的代价是短片段缺上下文、纯数字符号被跳过；单次有 48 次调用预算。
- **`/raw` 下载的是入库原文**：恶意邮件的原始脚本会随文件下载，请用文本编辑器或邮件客户端打开，不要在浏览器渲染。
- **正文 iframe 允许脚本**：为让「高度自适应」脚本生效；沙箱是不透明源，邮件脚本拿不到 Cookie / DOM / localStorage。

---

## 📄 许可

[MIT](LICENSE)
