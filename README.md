# CF Webmail · Cloudflare Workers 无服务器邮箱

基于 Cloudflare Workers 的轻量网页邮箱：用 **Email Routing** 收信，原始 `.eml` 存入 **R2**，同一个 Worker 同时负责前端渲染与邮件解析。没有服务器、没有数据库，全部跑在 Cloudflare 免费额度内。

**目录**

- [特性](#特性)
- [架构](#架构)
- [项目结构](#项目结构)
- [部署（Dashboard 连接 GitHub，推荐）](#部署dashboard-连接-github推荐)
- [应用内配置（部署后无需打开控制台）](#应用内配置部署后无需打开控制台)
- [本地开发](#本地开发)
- [配置参考](#配置参考)
- [安全设计](#安全设计)
- [运维与排查](#运维与排查)
- [成本](#成本)
- [已知取舍](#已知取舍)
- [许可](#许可)

---

## 特性

| 能力 | 说明 |
| --- | --- |
| **一键部署** | `wrangler.jsonc` 里 R2 只写绑定名、不写桶名 → 首次部署时 Cloudflare **自动创建 R2 桶并自动绑定**，无需手工建资源 |
| **免控制台点资源** | R2 / Workers AI 绑定全部由配置文件驱动；只有三个可选变量需要在 Dashboard 填一次 |
| **健壮的 MIME 解析内核** | base64 / quoted-printable、嵌套 multipart、RFC 2047 头部折叠（Header Folding）、GBK 乱码自动嗅探回退 |
| **正文沙箱渲染** | 邮件正文放在**不透明源 iframe** 中并剥离脚本与内联事件，恶意邮件无法触碰你的会话 |
| **附件流式下载** | 附件不进 HTML，按需从 R2 解码返回；10MB 附件也不会把页面撑爆 |
| **完整邮件管理** | 收件箱 / 回收站、批量操作、已读未读、PWA 可安装 |
| **应用内配置** | 转发邮箱、Turnstile 密钥全部在网页的「**设置**」页里配，部署后完全不用打开 Cloudflare 控制台 |
| **可选人机验证** | Turnstile **成对配置才启用**，不配置就自动跳过，不会把人锁在门外 |
| **登录防护** | 加盐口令哈希、常量时间比对、按 IP 限流、服务端会话过期 |
| **可观测性** | 开启 `observability` + `upload_source_maps`，日志堆栈可直接映射到源码行号 |

---

## 架构

```
发件人
  │  SMTP
  ▼
Cloudflare Email Routing ──(Send to a Worker)──▶  Worker.email()
                                                      │  原始 .eml
                                                      ▼
                                                 ┌──────────┐
                                                 │    R2    │  env.MAIL_BUCKET
                                                 └──────────┘
                                                      ▲
浏览器 ── HTTPS ──▶ Worker.fetch() ────────────────────┘
                      │
                      ├─ /                        收件箱列表
                      ├─ /email/<key>             邮件详情（正文走 iframe）
                      ├─ /frame/<key>             沙箱化正文文档
                      ├─ /attachment/<key>/<n>    附件流式下载
                      ├─ /trash /delete /restore /purge /batch-action
                      └─ /login /logout /setup /api/check
```

**R2 键名约定**

| 键 | 用途 |
| --- | --- |
| `sys_config.json` | 管理员账号（加盐哈希）、会话 token 与过期时间 |
| `_sys/settings.json` | 应用内设置（转发邮箱、Turnstile 密钥） |
| `<时间戳>_<发件人长度>_<发件人><主题>.eml` | 收件箱邮件（原始 MIME 全文）。**入库时**已把 RFC 2047 编码的头解码为明文；发件人用长度前缀界定，因此发件人里含 `_` 也不会串位 |
| `trash/<原键名>` | 回收站中的邮件 |
| `_sys/login_fail_<ip>` | 登录限流计数（内部键，永不进列表） |

---

## 项目结构

| 文件 | 说明 |
| --- | --- |
| `workers.js` | 全部业务代码：前端页面 + 邮件接收 + MIME 解析 + 路由（单文件 Worker） |
| `tests/regression.test.mjs` | **零依赖**回归测试：桩 R2 + 直接调 `fetch` / `email()`，46 条用例覆盖登录、鉴权、XSS、沙箱、附件、设置页、邮件入库与键名还原 |
| `tools/render-preview.mjs` | 把初始化页与登录页渲染成静态 HTML，生成 `.preview/compare.html` 左右对比（`npm run preview`） |
| `wrangler.jsonc` | 部署配置。**R2 自动创建 + 自动绑定**，并绑定 Workers AI |
| `package.json` / `package-lock.json` | 依赖与脚本，锁文件保证构建可复现 |
| `.dev.vars.example` | 本地开发变量模板（复制为 `.dev.vars`） |
| `.github/workflows/ci.yml` | CI：语法检查 + 离线校验部署配置 |
| `LICENSE` | MIT |

---

## 部署（Dashboard 连接 GitHub，推荐）

### 前置条件

1. 一个 Cloudflare 账号，域名已托管在 Cloudflare（DNS 生效）。
2. 该域名已启用 **Email Routing**。
3. **先开通 R2**：Dashboard → **R2** → 点一次同意条款。
   > ⚠️ 这是最关键的一步。账号没开通 R2 时，自动创建桶会直接失败 —— 这是部署失败最常见的原因。
4. 代码已推送到你的 GitHub 仓库。

### 步骤一：创建 Worker 项目

**Workers & Pages** → **Create** → **Workers** → **Connect to Git** → 选择仓库，然后按下表填写：

| 配置项 | 值 |
| --- | --- |
| **Project name** | `cf-webmail-client` ← **必须与 `wrangler.jsonc` 里的 `name` 完全一致** |
| **Build command** | `npm install` |
| **Deploy command** | `npx wrangler deploy` |

点 **Deploy**。首次部署会自动发生两件事：

- **R2 自动创建 + 自动绑定**：`wrangler.jsonc` 里 R2 只有 `"binding": "MAIL_BUCKET"`、没有 `bucket_name`，Cloudflare 会自动建桶（以 Worker 名为前缀命名，具体名称以 Dashboard 为准）并绑定到 `env.MAIL_BUCKET`。**不需要手动建桶，也不需要改代码。**
- **Workers AI 自动绑定**：`"ai": { "binding": "AI" }` 绑定为 `env.AI`，无需创建资源。
  当前版本**尚未调用 AI**，属于预留能力（绑定本身不产生费用），后续可直接 `env.AI.run(...)`。

> ⚠️ **通过 Dashboard 部署时，自动创建出来的资源 ID 不会写回你的 GitHub 仓库**，只能在 Dashboard 查看。
> 若以后想改用本地 `wrangler deploy`，请先把桶名/ID 从 Dashboard 复制进 `wrangler.jsonc`，
> 否则 wrangler 会当成「没有绑定」再创建一套新资源 —— 你会以为线上邮件全丢了。

### 步骤二：配置变量与密钥（二选一）

**方式 A（推荐）：用网页里的「设置」页**
登录后点侧边栏（或收件箱右上角齿轮）进入 **设置**，填好保存即可，**不需要打开 Cloudflare 控制台**。
详见下一节 [应用内配置](#应用内配置部署后无需打开控制台)。

**方式 B：用 Cloudflare Dashboard 的环境变量**
Dashboard → **Workers & Pages** → `cf-webmail-client` → **Settings** → **Variables and Secrets**：

| 名称 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `FORWARD_EMAIL` | Text | 否 | 收到邮件后自动转发到这个邮箱；留空 = 不转发 |
| `TURNSTILE_SITE_KEY` | Text | 否 | Turnstile 的 Site Key（公开值） |
| `TURNSTILE_SECRET_KEY` | **Secret** | 否 | Turnstile 的 Secret Key（密钥，必须选 Secret 类型） |

保存后如未生效，到 **Deployments** 点一次 **Retry deployment**。

> **为什么 `wrangler.jsonc` 里没有直接写这三个变量？**
> 因为配置文件里出现过的变量会**覆盖** Dashboard 上的同名变量：写空值或假占位值，
> 等于把你已经配好的真实值清掉（转发失效、验证码永远过不去）。
> 而且 `TURNSTILE_SECRET_KEY` 是密钥，写进仓库等于明文提交到 Git。

### 步骤三：把邮件路由到 Worker

域名管理页 → **Email** → **Email Routing** → **Routes** → **Create address**：

- **Custom address**：如 `inbox`
- **Domain**：你的域名
- **Action**：**Send to a Worker**
- **Worker**：`cf-webmail-client`

保存后，所有发往 `inbox@yourdomain.com` 的邮件都会触发 `export default { async email(...) }`，原始邮件写入 R2。

### 步骤四：首次访问与初始化

1. 打开 Worker URL（`https://cf-webmail-client.<你的子域>.workers.dev/`）。
2. R2 中还没有配置文件，Worker 会自动跳到**初始化页面**。
3. 设置管理员用户名和密码（**密码至少 8 位**），点「完成设置并登录」。
4. 之后用该账号登录即可。

### 部署检查清单

- [ ] 账号已开通 R2（Dashboard → R2 能看到桶列表）
- [ ] 域名已启用 Email Routing
- [ ] Workers 项目的 Project name 与 `wrangler.jsonc` 的 `name` 一致
- [ ] Deploy command 是 `npx wrangler deploy`
- [ ] 首次部署日志里没有 R2 相关报错
- [ ] Email Routing 里已建好指向该 Worker 的地址
- [ ] 已完成管理员初始化并能成功登录

---

## 应用内配置（部署后无需打开控制台）

登录后进入 **设置** 页（侧边栏「设置」，或收件箱右上角的齿轮图标），可以配置：

| 配置项 | 说明 |
| --- | --- |
| **邮件转发** | 邮件存入 R2 成功后自动转发一份；留空 = 不转发。**改完即刻生效** |
| **Turnstile Site Key / Secret Key** | 两个 Key **必须成对填写**，只填一个会直接报错并拒绝保存 |

### 取值优先级

三个配置都按 **应用内设置 → 环境变量 → 关闭** 三段式回退：

```
应用内设置（R2）──有值──▶ 生效
      │
      └──无值──▶ Dashboard 环境变量 ──有值──▶ 生效
                        │
                        └──无值──▶ 关闭（例如验证码自动跳过）
```

所以**已经用环境变量配好的老部署不会因为这次升级而失效**；而设置页里的值会覆盖环境变量。
设置页右上角的徽章会明确标出当前生效来源（`应用内已配置` / `来自环境变量` / `未配置`）。

### 几个设计细节

- **Secret Key 永不回显**：页面只显示掩码（如 `SUPERS••••••••1234`）。
  因此该输入框**留空 = 保持原值不变**；想清空请用页面底部的「清空 Turnstile 密钥」（需点两次确认）。
  非密钥字段（转发邮箱、Site Key）会回显当前值，所以**留空 = 清空**。
- **成对校验**：Site Key 与 Secret Key 只填一个会返回 `400` 并拒绝保存，避免「以为配好了、实际永远过不去」。
- **不会把人锁死**：两个 Key 不完整时验证直接关闭，登录页也不渲染组件。
- **生效时机**：Site Key 是服务端渲染进登录页的，保存后**下次打开登录页**生效。
- **存储位置与取舍**：配置存在 R2 的 `_sys/settings.json`。
  Cloudflare 的**环境变量 Secret 是加密存储**的，而 **R2 的值不是** ——
  放进 R2 换来「免控制台配置」，代价是失去静态加密。
  如果你更看重加密存储，就继续用方式 B（环境变量）；设置页清空密钥后会自动回退到环境变量。

> 本项目是单管理员应用，登录后即是管理员，因此设置页没有额外的权限层。
> 若你要改成多用户，记得给 `/settings` 加一道管理员校验。

---

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 填入本地测试用的变量
npm run dev                      # 本地跑，自动创建本地 R2（存在 .wrangler/，不影响线上）
```

其他脚本：

| 命令 | 作用 |
| --- | --- |
| `npm test` | 跑回归测试（**零依赖、不联网、不碰线上数据**） |
| `npm run preview` | 渲染初始化页 / 登录页到 `.preview/compare.html`，左右对比视觉效果 |
| `npm run check` | **离线**校验部署配置（不需要登录、不需要账号） |
| `npm run deploy` | 本地 CLI 部署（会把你创建的资源 ID 写回配置） |
| `npm run tail` | 实时查看线上日志 |
| `npm run types` | 生成 `worker-configuration.d.ts`，让编辑器识别 `env` 上的绑定 |

`npm run check` 的正常输出：

```
Your Worker has access to the following bindings:
Binding                 Resource
env.MAIL_BUCKET         R2 Bucket
env.AI                  AI
```

---

## 配置参考

### 绑定

| 绑定 | 类型 | 来源 | 代码中的用法 |
| --- | --- | --- | --- |
| `MAIL_BUCKET` | R2 桶 | `wrangler.jsonc` 自动创建 | `env.MAIL_BUCKET` |
| `AI` | Workers AI | `wrangler.jsonc` 自动绑定（预留） | `env.AI` |

### 变量

| 变量 | 类型 | 默认行为 | 代码中的用法 |
| --- | --- | --- | --- |
| `FORWARD_EMAIL` | 文本 | 未设置 → 不转发 | 存库成功后调用 `message.forward()` |
| `TURNSTILE_SITE_KEY` | 文本 | 未设置 → 登录页不渲染验证码 | 注入登录页 `data-sitekey` |
| `TURNSTILE_SECRET_KEY` | 密钥 | 未设置 → 跳过服务端校验 | 调 Turnstile `siteverify` |

**只有两个 Turnstile 变量同时存在时验证才会启用**（`siteKey && secretKey`）。
只填一个属于半配置：服务端会直接跳过校验，登录页也不渲染组件 —— 不会把人锁死。

每个配置的取值都按 **应用内设置 → 环境变量 → 关闭** 三段式回退，详见 [应用内配置](#应用内配置部署后无需打开控制台)。

---

## 安全设计

| 风险 | 处理方式 |
| --- | --- |
| **邮件内容 XSS** | 主题、发件人、附件名等完全由发件人控制，渲染前统一 `escapeHtml()` |
| **点击行 XSS** | 不再把键名拼进 `onclick` 字符串（`encodeURIComponent` **不转义单引号**），改为 `data-key` + 事件委托 |
| **正文脚本执行** | 正文在不透明源 iframe 中渲染（`sandbox` 属性 + CSP `sandbox`），并额外剥离 `<script>` 与内联 `on*` 事件 |
| **附件类型混淆** | `text/html` / `image/svg+xml` 等危险 MIME 一律降级为 `application/octet-stream` + `Content-Disposition: attachment` |
| **口令存储** | 加盐 SHA-256（每账号 16 字节随机盐），并兼容早期无盐数据 |
| **口令比对** | 常量时间 `safeEqual`，避免逐字符提前返回泄漏前缀信息 |
| **暴力破解** | 按 `CF-Connecting-IP` 限流：15 分钟窗口内失败 8 次 → 锁定 10 分钟（**锁定期间即使口令正确也拒绝**） |
| **会话** | 32 字节随机 token、`HttpOnly` + `Secure` + `SameSite=Lax`、服务端校验 30 天过期 |
| **信息泄漏** | 未捕获异常只写日志，不把堆栈回显给客户端；页面统一 `no-store` + `noindex` |
| **搜索引擎收录** | 全站 `X-Robots-Tag: noindex`，并提供 `robots.txt` 拒绝抓取 |
| **点击劫持** | 页面响应带 `X-Frame-Options: DENY`（正文 iframe 单独用 `SAMEORIGIN`） |

---

## 运维与排查

| 症状 | 原因与处理 |
| --- | --- |
| 部署失败，日志提示 R2 相关错误 | 账号还没开通 R2。Dashboard → R2 点一次同意条款后重新部署 |
| 改了 Dashboard 变量没生效 | 到 Deployments 点一次 **Retry deployment** |
| 登录页报「尝试次数过多」 | 触发了 IP 限流。等待 10 分钟，或删除 R2 中的 `_sys/login_fail_<你的IP>` 键 |
| Turnstile 一直不过 | 两个 Key 必须来自同一个 Turnstile 站点且成对配置。想临时关闭：删掉两个变量后重新部署 |
| 中文邮件乱码 | 解析内核已内置 GBK 回退：UTF-8 解出替换字符（�）时自动改用 GBK 重解，并择错误更少的结果 |
| 列表里主题显示成 `=?UTF-8?B?...?=` | 是旧版本写入的邮件：老版本先 sanitize 键名、再在列表页解码，而 sanitize 会把 RFC 2047 里的 `?` 换成 `_`，编码标记被破坏后永远解不回来。新版**入库时即解码**；旧邮件重新投递一封即可正常 |
| 点邮件行没反应、打不开 | 老版本的点击守卫用 `closest('form')` 排除交互控件，但邮件行本身就在 `<form id="batch-form">` 里，于是整行点击被吞。已改为先把目标归到 `.email-row`，再排除 `a/button/input/label/select/textarea/iframe` |
| 邮件正文被当成附件 | 极少数畸形邮件。解析器有「绝望模式」容错，会把疑似正文的附件内容强行显示出来 |
| 忘记管理员密码 | 删除 R2 中的 `sys_config.json`，重新访问站点即回到初始化页面（**注意：会一并清掉会话**） |
| 想改成单文件版本 | 把 `workers.js` 改名为 `_worker.js` 放进 Cloudflare Pages 的静态目录即可 |

查看线上日志：Dashboard → 你的 Worker → **Logs**，或本地 `npm run tail`。

---

## 成本

全部在 Cloudflare 免费额度内：

- **Workers**：免费版每天 10 万次请求
- **Email Routing**：接收邮件免费，不限量
- **R2**：10 GB 存储 + 每月 100 万次 A 类操作免费，且**出网流量免费**
- **Workers AI**：仅绑定不调用，不产生费用

---

## 已知取舍

- **Tailwind 走 CDN**：页面引用 `https://cdn.tailwindcss.com`，省掉了构建步骤，代价是首屏多一个外部请求。若追求极致性能，可改用 Tailwind CLI 在构建阶段产出 CSS，再改走静态路由。
- **变量既支持应用内设置也支持环境变量**：设置页换来「免控制台配置」，代价是密钥存在 R2 里、失去 Cloudflare 的静态加密；如果你更看重加密存储，用环境变量即可，两者按「设置 → 环境变量」回退。
- **邮件保存在 R2 而非数据库**：列表页靠键名解析出发件人与主题。发件人用**长度前缀**界定，含 `_` 也不会串位；主题保留发件人之后的全部内容，因此含 `_` 也完整。极端情况（主题里出现与分隔语义冲突的字符）只影响列表显示，正文与附件不受影响。
- **初始化页与登录页共用同一套视觉**：相同的背景渐变、玻璃卡片、logo 块与页脚，避免首次部署与日常登录看起来像两个产品。
- **正文 iframe 允许脚本**：为了让注入的「高度自适应」脚本生效。由于沙箱是不透明源，邮件自带脚本拿不到本站 Cookie / DOM / localStorage，风险已被隔离。若你更保守，可把 iframe 的 `sandbox` 与 CSP 中的 `allow-scripts` 去掉，代价是正文高度固定为 `60vh`。

---

## 许可

[MIT](LICENSE)
